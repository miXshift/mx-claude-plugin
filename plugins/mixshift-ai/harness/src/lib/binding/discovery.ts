/**
 * Sub-brand label discovery (mx-ops#6 P1; docs/subbrand-architecture.md §4.1
 * "shape detection" in mx-legacy-auth).
 *
 * Assembles a PER-SIDE label coverage report from four gateway named
 * queries — retail labels (sbd-01, mws_items.Brand), ads labels (sbd-02,
 * campaign.Brand), vendor labels (sbd-03, vendor_items.CustomBrand), and the
 * cross-side match rate (sbd-04) — into distinct-label counts, blank-label
 * ("(unclassified)") share per side, the retail<->ads match rate, and a
 * shape classification PROPOSAL (single_brand vs brand_nested candidate).
 *
 * CONTRACT (confirmed against the gateway-side draft PR #106,
 * feat/subbrand-p1-queries): sbd-01..04 are `sellerScoped: true` with EMPTY
 * declared params — seller ids travel via the same top-level `sellerIds`
 * field every other sellerScoped named query uses (see
 * lib/data/query-runner.ts's `runNamedQuery` / `NamedQueryOptions.sellerIds`),
 * NOT a `params.seller_ids` (or `AmazonSellerID`) key. Reason: `dispatch.ts`
 * unconditionally hoists a `params.seller_ids` key to that same top-level
 * field before the gateway ever sees it, so a declared param of that name
 * would never arrive — the gateway side designed around that, and this
 * client follows the same convention.
 *
 * The CLI takes an AmazonSellerID (a string), but `sellerIds` is the
 * warehouse's INTERNAL numeric seller.SellerID(s) for that account (the same
 * distinction `binding.amazon_seller_id` vs `binding.seller_ids` draws).
 * `fetchLabelDiscovery` resolves the one to the other by reusing
 * `discoverSellers()` (the same primitive `brand discover` / `brand add`
 * already use) and filtering for matching rows — no new SQL surface.
 *
 * sbd-01..03 arrive with `label` already COALESCEd to the literal string
 * `'(unclassified)'` for blanks (never null/empty); sbd-04 excludes blank
 * labels entirely. `normalizeLabel` below still defensively re-checks this
 * (idempotent on an already-'(unclassified)' value) rather than trusting the
 * wire shape blindly.
 *
 * The gateway pack entries may still not be DEPLOYED at any given moment —
 * `fetchLabelDiscovery` tolerates a per-query `unknown_query` failure
 * without throwing, so this command degrades gracefully ahead of that
 * deploy.
 *
 * `assembleCoverageReport` is a pure function over already-fetched rows —
 * see discovery.test.ts for the mocked-row unit tests. LIVE integration
 * (actually calling sbd-01..04 against a real tenant) is deferred until the
 * gateway half deploys.
 */

import { runNamedQuery, type DataQueryResult } from '../data/query-runner.js';
import { UNCLASSIFIED_LABEL, normalizeLabel } from './label.js';
import {
  coerceRetailEconRow,
  coerceAdsEconRow,
  coerceVendorEconRow,
  type Sbd05RetailEconRow,
  type Sbd06AdsEconRow,
  type Sbd07VendorEconRow,
  type Sbd05RetailEconRowWire,
  type Sbd06AdsEconRowWire,
  type Sbd07VendorEconRowWire,
} from './economics.js';
import { discoverSellers } from '../discovery/seller-query.js';

// ---------------------------------------------------------------------------
// Wire row shapes (frozen contract; see module header)
// ---------------------------------------------------------------------------

export interface Sbd01RetailRow {
  SellerID: number | string;
  source: string; // 'mws_items.Brand'
  label: string;
  asin_count: number;
  row_count: number;
}

export interface Sbd02AdsRow {
  SellerID: number | string;
  source: string; // 'campaign.Brand'
  label: string;
  campaign_count: number;
}

export interface Sbd03VendorRow {
  SellerID: number | string;
  source: string; // 'vendor_items.CustomBrand'
  label: string;
  item_count: number;
}

export interface Sbd04MatchRow {
  label: string;
  retail_asins: number;
  ads_campaigns: number;
  has_retail: boolean;
  has_ads: boolean;
}

// ---------------------------------------------------------------------------
// Wire-shape coercion (FINDING 2, red team over PR #131, live-wire-verified):
// the four interfaces above are the CLEAN, POST-COERCION shape every
// assemble* function below consumes. What `runNamedQuery` actually returns
// is different in two ways:
//
//   - the gateway's mysql pool runs with bigNumberStrings:true (COUNT()
//     derives a BIGINT column), so asin_count / row_count / campaign_count /
//     item_count / retail_asins / ads_campaigns arrive as JS STRINGS, not
//     numbers. buildSideCoverage's `entry.units += r.units` and
//     assembleMatch's arithmetic would otherwise string-concatenate
//     ("40" + "25" -> "4025") instead of summing, silently corrupting every
//     total and share.
//   - has_retail / has_ads come from `IF(...,0,1)` and arrive as a JS
//     NUMBER 0/1, not a boolean.
//
// Coercing ONCE here, at the fetch boundary, means every function above
// this comment can keep assuming clean number/boolean input.
// ---------------------------------------------------------------------------

export interface Sbd01RetailRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  asin_count: number | string;
  row_count: number | string;
}

export interface Sbd02AdsRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  campaign_count: number | string;
}

export interface Sbd03VendorRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  item_count: number | string;
}

export interface Sbd04MatchRowWire {
  label: string;
  retail_asins: number | string;
  ads_campaigns: number | string;
  has_retail: number | boolean;
  has_ads: number | boolean;
}

/** Number(...) with a NaN guard: a malformed/missing count degrades to 0
 *  rather than poisoning every downstream sum with NaN. */
function coerceCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** A 0/1 (or already-boolean) flag -> a real boolean. Robust to either
 *  arriving as a number or, defensively, a numeric string. */
function coerceFlag(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  return coerceCount(raw) === 1;
}

/** Exported for direct unit testing against realistic wire fixtures (string
 *  counts) without a network mock — see discovery.test.ts. */
export function coerceRetailRow(row: Sbd01RetailRowWire): Sbd01RetailRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    asin_count: coerceCount(row.asin_count),
    row_count: coerceCount(row.row_count),
  };
}

export function coerceAdsRow(row: Sbd02AdsRowWire): Sbd02AdsRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    campaign_count: coerceCount(row.campaign_count),
  };
}

export function coerceVendorRow(row: Sbd03VendorRowWire): Sbd03VendorRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    item_count: coerceCount(row.item_count),
  };
}

export function coerceMatchRow(row: Sbd04MatchRowWire): Sbd04MatchRow {
  return {
    label: row.label,
    retail_asins: coerceCount(row.retail_asins),
    ads_campaigns: coerceCount(row.ads_campaigns),
    has_retail: coerceFlag(row.has_retail),
    has_ads: coerceFlag(row.has_ads),
  };
}

/** Blank/absent labels are a BUCKET, never a sub-brand candidate (design doc
 *  §3, the DHC-07/08 rule: `COALESCE(NULLIF(col,''),'(unclassified)')`).
 *
 *  DEFINED IN `./label.ts`, re-exported here so existing importers are
 *  unaffected. It moved because economics.ts needs the SAME normalizer and
 *  cannot import this module without a cycle — keying the two sides
 *  differently is what let a whitespace-padded label lose its economics. */
export { UNCLASSIFIED_LABEL, normalizeLabel };

// ---------------------------------------------------------------------------
// Per-side coverage
// ---------------------------------------------------------------------------

export interface SideLabelBreakdown {
  label: string;
  /** Originating source column(s) for this label, comma-joined when the
   *  same label value appears from more than one source (e.g. an SC row and
   *  a VC row sharing a label). */
  source: string;
  units: number;
}

export type LabelSide = 'retail' | 'ads';

export interface SideCoverage {
  side: LabelSide;
  total_units: number;
  /** Distinct NON-blank labels — excludes the (unclassified) bucket. */
  distinct_labels: number;
  unclassified_units: number;
  /** 0..1; 0 when total_units is 0 (nothing to divide). */
  unclassified_share: number;
  /** Sorted descending by units; includes the (unclassified) row if present. */
  labels: SideLabelBreakdown[];
}

interface NormalizedUnit {
  label: string;
  source: string;
  units: number;
}

function buildSideCoverage(side: LabelSide, rows: NormalizedUnit[]): SideCoverage {
  const byLabel = new Map<string, { sources: Set<string>; units: number }>();
  for (const r of rows) {
    const entry = byLabel.get(r.label) ?? { sources: new Set<string>(), units: 0 };
    entry.sources.add(r.source);
    entry.units += r.units;
    byLabel.set(r.label, entry);
  }

  const labels: SideLabelBreakdown[] = [...byLabel.entries()]
    .map(([label, { sources, units }]) => ({
      label,
      source: [...sources].sort().join(', '),
      units,
    }))
    .sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));

  const totalUnits = labels.reduce((n, l) => n + l.units, 0);
  const unclassified = byLabel.get(UNCLASSIFIED_LABEL);
  const unclassifiedUnits = unclassified?.units ?? 0;
  const distinctLabels = labels.filter((l) => l.label !== UNCLASSIFIED_LABEL).length;

  return {
    side,
    total_units: totalUnits,
    distinct_labels: distinctLabels,
    unclassified_units: unclassifiedUnits,
    unclassified_share: totalUnits > 0 ? unclassifiedUnits / totalUnits : 0,
    labels,
  };
}

/** Retail side merges SC (mws_items.Brand, sbd-01) and VC
 *  (vendor_items.CustomBrand, sbd-03) rows — both are "retail" per the
 *  design doc's binding.retail_label, differing only in source table. */
export function assembleRetailCoverage(
  scRows: readonly Sbd01RetailRow[],
  vcRows: readonly Sbd03VendorRow[],
): SideCoverage {
  const units: NormalizedUnit[] = [
    ...scRows.map((r) => ({ label: normalizeLabel(r.label), source: r.source, units: r.asin_count })),
    ...vcRows.map((r) => ({ label: normalizeLabel(r.label), source: r.source, units: r.item_count })),
  ];
  return buildSideCoverage('retail', units);
}

export function assembleAdsCoverage(rows: readonly Sbd02AdsRow[]): SideCoverage {
  const units: NormalizedUnit[] = rows.map((r) => ({
    label: normalizeLabel(r.label),
    source: r.source,
    units: r.campaign_count,
  }));
  return buildSideCoverage('ads', units);
}

// ---------------------------------------------------------------------------
// Cross-side match rate
// ---------------------------------------------------------------------------

export interface MatchSummary {
  /** Distinct non-blank labels considered (the (unclassified) bucket has no
   *  cross-side "match" meaning — it is excluded here). */
  distinct_labels_considered: number;
  matched: number;
  retail_only: number;
  ads_only: number;
  /** matched / distinct_labels_considered; null when there is nothing to
   *  divide (no non-blank labels on either side yet). */
  match_rate: number | null;
}

export function assembleMatch(rows: readonly Sbd04MatchRow[]): MatchSummary {
  const considered = rows.filter((r) => normalizeLabel(r.label) !== UNCLASSIFIED_LABEL);
  const matched = considered.filter((r) => r.has_retail && r.has_ads).length;
  const retailOnly = considered.filter((r) => r.has_retail && !r.has_ads).length;
  const adsOnly = considered.filter((r) => !r.has_retail && r.has_ads).length;
  return {
    distinct_labels_considered: considered.length,
    matched,
    retail_only: retailOnly,
    ads_only: adsOnly,
    match_rate: considered.length > 0 ? matched / considered.length : null,
  };
}

// ---------------------------------------------------------------------------
// Shape classification (PROPOSAL ONLY — the user always confirms)
// ---------------------------------------------------------------------------

export type ShapeProposal = 'single_brand' | 'brand_nested_candidate';

export interface ClassificationProposal {
  /** null when there was no real data to classify from at all — see
   *  `insufficientDataClassification` below (FINDING 1, red team over
   *  PR #131). Callers must never treat null as either shape. */
  proposal: ShapeProposal | null;
  evidence: string[];
  /** Always true — documents that this is a proposal, never applied
   *  automatically (design doc §4.1: "Never silently classify"). */
  confirm_required: true;
}

/**
 * Design doc §4.1: "1 dominant label OR blanks-dominated -> single_brand".
 * A retail side at or above this unclassified share is blanks-dominated
 * regardless of how many labeled slivers exist among the non-blank
 * remainder — a handful of tiny labeled rows on an otherwise-unlabeled
 * account is not sub-brand evidence.
 *
 * Deliberately RETAIL-ONLY: a blank-dominated ADS side is the NORMAL state
 * on a genuinely nested account (F24 — ads-side blanks measured 59-100% on
 * real nested evidence accounts), so this gate must never look at `ads`,
 * or every real nested account would misclassify as single_brand.
 *
 * Tunable; not itself a value the evidence measured (F24 gives ads-side
 * blank RATES, not a retail single/nested threshold), so this is a
 * documented default rather than a prescribed number.
 */
export const RETAIL_BLANK_DOMINATED_THRESHOLD = 0.9;

/**
 * Design doc §4.1: brand_nested candidacy requires "N labels with
 * MEANINGFUL catalog/spend mass" — a label under this share of the side's
 * total units does not count toward N. Without this qualifier, a handful
 * of sliver labels (a handful of mislabeled ASINs, a one-off test
 * campaign) on an otherwise blanks-dominated-but-just-under-the-threshold
 * account would manufacture a brand_nested_candidate proposal on noise.
 * Tunable.
 */
export const MEANINGFUL_LABEL_SHARE = 0.02;

/**
 * Propose single_brand vs brand_nested_candidate from the RETAIL side's
 * label diversity (design doc F24: retail labels vastly outnumber ads
 * labels on nested accounts in practice, so retail is the more reliable
 * shape signal; ads coverage is reported as a caveat, not the deciding
 * factor). This is a heuristic proposal, not a decision — the caller must
 * always present it for user confirmation (§4.1).
 */
export function classifyShape(retail: SideCoverage, ads: SideCoverage): ClassificationProposal {
  const evidence: string[] = [];
  const nonBlankRetail = retail.labels.filter((l) => l.label !== UNCLASSIFIED_LABEL);
  const topRetail = nonBlankRetail.slice(0, 5);

  // Gate 1 (§4.1, "blanks-dominated"): checked BEFORE counting labels, so a
  // blank-dominated retail side never reaches brand_nested_candidate no
  // matter how many sliver labels sit in the non-blank remainder.
  if (
    retail.total_units > 0 &&
    retail.unclassified_share >= RETAIL_BLANK_DOMINATED_THRESHOLD
  ) {
    evidence.push(
      `retail side is ${(retail.unclassified_share * 100).toFixed(0)}% unclassified ` +
        `(at or above the ${(RETAIL_BLANK_DOMINATED_THRESHOLD * 100).toFixed(0)}% blanks-dominated ` +
        'threshold), so any remaining labeled slivers are not treated as sub-brand evidence',
    );
    return { proposal: 'single_brand', evidence, confirm_required: true };
  }

  // Gate 2 (§4.1, "meaningful ... mass"): a label under MEANINGFUL_LABEL_SHARE
  // of the side's total units does not count toward N for nested candidacy.
  // With zero total_units there is no denominator to qualify against — fall
  // back to raw non-blank presence (matches the "no rows at all" case).
  const meaningfulRetail =
    retail.total_units > 0
      ? nonBlankRetail.filter((l) => l.units / retail.total_units >= MEANINGFUL_LABEL_SHARE)
      : nonBlankRetail;

  if (meaningfulRetail.length <= 1) {
    evidence.push(
      meaningfulRetail.length === 0
        ? 'retail side has no label with meaningful catalog/spend mass'
        : `retail side has exactly one label with meaningful mass (${meaningfulRetail[0]?.label ?? UNCLASSIFIED_LABEL})`,
    );
    if (retail.unclassified_share > 0) {
      evidence.push(
        `${(retail.unclassified_share * 100).toFixed(0)}% of retail units are unclassified`,
      );
    }
    return { proposal: 'single_brand', evidence, confirm_required: true };
  }

  evidence.push(
    `retail side has ${meaningfulRetail.length} distinct labels with meaningful mass ` +
      `(>= ${(MEANINGFUL_LABEL_SHARE * 100).toFixed(0)}% of units each)`,
  );
  evidence.push(
    `top labels by units: ${topRetail.map((l) => `${l.label} (${l.units})`).join(', ')}`,
  );
  if (ads.unclassified_share > 0.5) {
    evidence.push(
      `ads side is ${(ads.unclassified_share * 100).toFixed(0)}% unclassified — expect sub-brand ` +
        'ad attribution to start mostly (unclassified) and improve as labels are added (F24)',
    );
  }
  return { proposal: 'brand_nested_candidate', evidence, confirm_required: true };
}

/**
 * Classification when there is no real data to classify from at all (the
 * fetch failed outright, or the AmazonSellerID resolved to zero warehouse
 * sellers) — FINDING 1, red team over PR #131: an all-empty-rows report
 * would otherwise collapse to distinct_labels=0 and `classifyShape`'s
 * normal "no non-blank labels -> single_brand" path, producing a
 * wrong-looking-real answer during the documented gateway rollout gap.
 * Callers (the CLI) use this INSTEAD OF `classifyShape` whenever
 * `fetchLabelDiscovery` reports a total failure (see `classifyFetchOutcome`
 * below — status 'error').
 */
export function insufficientDataClassification(reason: string): ClassificationProposal {
  return { proposal: null, evidence: [reason], confirm_required: true };
}

// ---------------------------------------------------------------------------
// Full report assembly
// ---------------------------------------------------------------------------

export interface CoverageReport {
  seller_id: string;
  generated_at: string;
  retail: SideCoverage;
  ads: SideCoverage;
  match: MatchSummary;
  classification: ClassificationProposal;
}

export interface CoverageReportInput {
  sellerId: string;
  retailRows: readonly Sbd01RetailRow[];
  vendorRows: readonly Sbd03VendorRow[];
  adsRows: readonly Sbd02AdsRow[];
  matchRows: readonly Sbd04MatchRow[];
  /** Injectable for deterministic tests; defaults to `new Date()`. */
  now?: Date;
}

export function assembleCoverageReport(input: CoverageReportInput): CoverageReport {
  const retail = assembleRetailCoverage(input.retailRows, input.vendorRows);
  const ads = assembleAdsCoverage(input.adsRows);
  const match = assembleMatch(input.matchRows);
  const classification = classifyShape(retail, ads);
  return {
    seller_id: input.sellerId,
    generated_at: (input.now ?? new Date()).toISOString(),
    retail,
    ads,
    match,
    classification,
  };
}

// ---------------------------------------------------------------------------
// Live fetch (network path — see module header re: contract/deploy status)
// ---------------------------------------------------------------------------

export interface LabelDiscoveryFetchResult {
  ok: boolean;
  /** The internal numeric warehouse seller_id(s) resolved for the given
   *  AmazonSellerID (empty when none were found — see `errors`). */
  resolvedSellerIds: number[];
  retailRows: Sbd01RetailRow[];
  vendorRows: Sbd03VendorRow[];
  adsRows: Sbd02AdsRow[];
  matchRows: Sbd04MatchRow[];
  /** Per-label economics (mx-ops#6): the dollars promotion candidates rank
   *  on, and the observable activity their lifecycle is read from. */
  retailEconRows: Sbd05RetailEconRow[];
  adsEconRows: Sbd06AdsEconRow[];
  vendorEconRows: Sbd07VendorEconRow[];
  /** One entry per query id that failed; the corresponding rows array above
   *  is empty for that side rather than the whole call throwing. The
   *  synthetic id `resolve_seller_ids` covers the AmazonSellerID -> internal
   *  seller_id resolution step failing (before any sbd-* query even runs). */
  errors: Array<{ query_id: string; message: string; friendly: string }>;
}

/**
 * Resolve an AmazonSellerID to this tenant's internal numeric warehouse
 * seller_id(s) by reusing `discoverSellers()` (the same primitive `brand
 * discover` / `brand add` already use) and filtering for matching rows.
 * Exported for direct unit testing without a network mock.
 */
export function resolveSellerIds(
  amazonSellerId: string,
  sellers: readonly { seller_id: number; amazon_seller_id: string | null }[],
): number[] {
  return sellers
    .filter((s) => s.amazon_seller_id === amazonSellerId)
    .map((s) => s.seller_id);
}

/** How many discovery queries may be in flight at once. Three keeps the
 *  connection burst narrow enough to avoid the connect-timeout drop that a
 *  wide fan-out causes on a slow network, while still overlapping enough
 *  that the whole fetch stays well inside the statement-timeout budget.
 *  Exported so a test can assert the fan-out is actually bounded. */
export const DISCOVERY_FETCH_CONCURRENCY = 3;

/**
 * Run `tasks` with at most `limit` in flight, preserving input order in the
 * results. Rejections propagate (each task here already resolves to a typed
 * failure envelope rather than throwing).
 */
async function mapWithConcurrency<T extends readonly (() => Promise<unknown>)[]>(
  tasks: T,
  limit: number,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results = new Array<unknown>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

/**
 * Fetch all four sbd-* named queries for one Amazon Seller ID. Resolves the
 * AmazonSellerID to internal numeric seller_id(s) first (sbd-01..04 are
 * `sellerScoped` with EMPTY declared params — seller ids travel via
 * `NamedQueryOptions.sellerIds`, the same top-level field every other
 * sellerScoped named query uses; see the module header), then tolerates
 * individual query failures (e.g. `unknown_query` while the gateway pack
 * entries are still being deployed) — a partial result with `ok: false` and
 * populated `errors` is returned rather than throwing, so the caller can
 * still render whatever sides succeeded.
 */
export async function fetchLabelDiscovery(
  amazonSellerId: string,
  options: { dataDirOverride?: string; queryTimeoutMs?: number } = {},
): Promise<LabelDiscoveryFetchResult> {
  const none = {
    retailRows: [],
    adsRows: [],
    vendorRows: [],
    matchRows: [],
    retailEconRows: [],
    adsEconRows: [],
    vendorEconRows: [],
  };

  let sellers: Awaited<ReturnType<typeof discoverSellers>>;
  try {
    sellers = await discoverSellers({
      dataDirOverride: options.dataDirOverride,
      includeInactive: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      resolvedSellerIds: [],
      ...none,
      errors: [{ query_id: 'resolve_seller_ids', message, friendly: message }],
    };
  }

  const resolvedSellerIds = resolveSellerIds(amazonSellerId, sellers);
  if (resolvedSellerIds.length === 0) {
    const message = `No seller found for Amazon Seller ID "${amazonSellerId}" in this tenant's warehouse access.`;
    return {
      ok: false,
      resolvedSellerIds: [],
      ...none,
      errors: [{ query_id: 'resolve_seller_ids', message, friendly: message }],
    };
  }

  const queryOpts = {
    sellerIds: resolvedSellerIds,
    dataDirOverride: options.dataDirOverride,
    queryTimeoutMs: options.queryTimeoutMs,
  };

  // Bounded concurrency, NOT a bare Promise.all over all seven.
  //
  // Each simultaneous request opens its OWN connection, and on a network
  // where a fresh connect is slow, a wide burst is what pushes one of them
  // past the connect timeout — the reported failure behind mx-ops#6,
  // where a 4-wide burst reliably dropped one query. The transient replay
  // in query-runner is the safety net; keeping the burst narrow is what
  // stops it being needed. Sockets freed by an earlier wave get reused by
  // the next, so a narrower fan-out also opens fewer connections in total.
  //
  // The economics trio (sbd-05/06/07) took this call from four queries to
  // seven, so widening the burst here would have made the very failure just
  // fixed MORE likely rather than less.
  const [retail, ads, vendor, match, retailEcon, adsEcon, vendorEcon] = await mapWithConcurrency(
    [
      () => runNamedQuery<Sbd01RetailRowWire>('sbd-01', queryOpts),
      () => runNamedQuery<Sbd02AdsRowWire>('sbd-02', queryOpts),
      () => runNamedQuery<Sbd03VendorRowWire>('sbd-03', queryOpts),
      () => runNamedQuery<Sbd04MatchRowWire>('sbd-04', queryOpts),
      () => runNamedQuery<Sbd05RetailEconRowWire>('sbd-05', queryOpts),
      () => runNamedQuery<Sbd06AdsEconRowWire>('sbd-06', queryOpts),
      () => runNamedQuery<Sbd07VendorEconRowWire>('sbd-07', queryOpts),
    ] as const,
    DISCOVERY_FETCH_CONCURRENCY,
  );

  const errors: LabelDiscoveryFetchResult['errors'] = [];
  function rowsOf<WireRow, CleanRow>(
    queryId: string,
    result: DataQueryResult<WireRow>,
    coerce: (row: WireRow) => CleanRow,
  ): CleanRow[] {
    if (result.ok) return result.rows.map(coerce);
    errors.push({ query_id: queryId, message: result.message, friendly: result.friendly });
    return [];
  }

  // Coerce all four sides BEFORE building the result. `rowsOf` is what
  // PUSHES into `errors`, so evaluating `ok: errors.length === 0` inline as
  // the first property of the object literal read `errors` while it was
  // still empty — object-literal properties evaluate in source order, so
  // `ok` was computed before any of the rowsOf() calls below it had run.
  // That made `ok` unconditionally true whenever the seller-id resolution
  // above succeeded, no matter how many queries failed, which in turn made
  // classifyFetchOutcome always return 'ok' and left the command layer's
  // fail-loud abort permanently unreachable. Root cause of the
  // 2026-08-18 report (mx-ops#6): a dropped ads query rendered as a
  // confident "no campaigns yet" instead of stopping the plan.
  const retailRows = rowsOf('sbd-01', retail, coerceRetailRow);
  const adsRows = rowsOf('sbd-02', ads, coerceAdsRow);
  const vendorRows = rowsOf('sbd-03', vendor, coerceVendorRow);
  const matchRows = rowsOf('sbd-04', match, coerceMatchRow);
  const retailEconRows = rowsOf('sbd-05', retailEcon, coerceRetailEconRow);
  const adsEconRows = rowsOf('sbd-06', adsEcon, coerceAdsEconRow);
  const vendorEconRows = rowsOf('sbd-07', vendorEcon, coerceVendorEconRow);

  return {
    ok: errors.length === 0,
    resolvedSellerIds,
    retailRows,
    adsRows,
    vendorRows,
    matchRows,
    retailEconRows,
    adsEconRows,
    vendorEconRows,
    errors,
  };
}

/**
 * Classify a fetch result into the CLI's status/exit-code contract (FINDING
 * 1, red team over PR #131):
 *   'ok'      fetched.ok — every query (and the seller-id resolution step)
 *             succeeded.
 *   'error'   the seller-id resolution step failed (nothing to query at
 *             all — see the synthetic `resolve_seller_ids` error id), or
 *             EVERY sbd-* query failed.
 *   'partial' some but not all of the sbd-* queries failed; the report is
 *             real (built from whichever sides succeeded) but incomplete.
 */
export type FetchOutcome = 'ok' | 'partial' | 'error';

/** How many gateway named queries fetchLabelDiscovery calls per run (the
 *  four discovery entries plus the three economics ones) — used to tell
 *  "some failed" from "all failed". Must track the fan-out above: if it
 *  drifts LOW, an all-failed run misreports as 'partial' and the caller
 *  renders an empty plan instead of an error. A test pins the two together. */
export const SBD_QUERY_COUNT = 7;

export function classifyFetchOutcome(fetched: LabelDiscoveryFetchResult): FetchOutcome {
  if (fetched.ok) return 'ok';
  const sellerResolutionFailed = fetched.errors.some((e) => e.query_id === 'resolve_seller_ids');
  if (sellerResolutionFailed) return 'error';
  return fetched.errors.length >= SBD_QUERY_COUNT ? 'error' : 'partial';
}
