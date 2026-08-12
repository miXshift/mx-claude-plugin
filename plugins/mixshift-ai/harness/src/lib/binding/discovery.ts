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

/** Blank/absent labels are a BUCKET, never a sub-brand candidate (design doc
 *  §3, the DHC-07/08 rule: `COALESCE(NULLIF(col,''),'(unclassified)')`). */
export const UNCLASSIFIED_LABEL = '(unclassified)';

/** Normalize a raw label value to the unclassified bucket when blank. The
 *  gateway is expected to already COALESCE server-side (matching the
 *  DHC-07/08 pattern), but this is defensive: a null/''/whitespace-only
 *  label must never silently count as a "distinct label" candidate. */
export function normalizeLabel(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : UNCLASSIFIED_LABEL;
}

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
  proposal: ShapeProposal;
  evidence: string[];
  /** Always true — documents that this is a proposal, never applied
   *  automatically (design doc §4.1: "Never silently classify"). */
  confirm_required: true;
}

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
  const topRetail = retail.labels.filter((l) => l.label !== UNCLASSIFIED_LABEL).slice(0, 5);

  if (retail.distinct_labels <= 1) {
    evidence.push(
      retail.distinct_labels === 0
        ? 'retail side has no non-blank labels'
        : `retail side has exactly one non-blank label (${topRetail[0]?.label ?? UNCLASSIFIED_LABEL})`,
    );
    if (retail.unclassified_share > 0) {
      evidence.push(
        `${(retail.unclassified_share * 100).toFixed(0)}% of retail units are unclassified`,
      );
    }
    return { proposal: 'single_brand', evidence, confirm_required: true };
  }

  evidence.push(`retail side has ${retail.distinct_labels} distinct non-blank labels`);
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
  const none = { retailRows: [], adsRows: [], vendorRows: [], matchRows: [] };

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

  const [retail, ads, vendor, match] = await Promise.all([
    runNamedQuery<Sbd01RetailRow>('sbd-01', queryOpts),
    runNamedQuery<Sbd02AdsRow>('sbd-02', queryOpts),
    runNamedQuery<Sbd03VendorRow>('sbd-03', queryOpts),
    runNamedQuery<Sbd04MatchRow>('sbd-04', queryOpts),
  ]);

  const errors: LabelDiscoveryFetchResult['errors'] = [];
  const rowsOf = <Row>(queryId: string, result: DataQueryResult<Row>): Row[] => {
    if (result.ok) return result.rows;
    errors.push({ query_id: queryId, message: result.message, friendly: result.friendly });
    return [];
  };

  return {
    ok: errors.length === 0,
    resolvedSellerIds,
    retailRows: rowsOf('sbd-01', retail),
    adsRows: rowsOf('sbd-02', ads),
    vendorRows: rowsOf('sbd-03', vendor),
    matchRows: rowsOf('sbd-04', match),
    errors,
  };
}
