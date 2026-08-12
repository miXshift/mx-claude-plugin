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
 * CONTRACT NOTE: sbd-01..04 are being built in parallel on the gateway
 * (mx-legacy-auth) and may not be live yet — `fetchLabelDiscovery` below
 * tolerates a per-query `unknown_query` failure (pack entry absent) without
 * throwing, so this command degrades gracefully ahead of that deploy. The
 * row SHAPES are the frozen part of the contract (per the build brief); the
 * PARAM name this module sends (`AmazonSellerID`) is this client's own
 * choice pending the gateway side landing — a one-line fix here if the
 * actual entries expect something else.
 *
 * `assembleCoverageReport` is a pure function over already-fetched rows —
 * see discovery.test.ts for the mocked-row unit tests. LIVE integration
 * (actually calling sbd-01..04 against a real tenant) is deferred until the
 * gateway half deploys.
 */

import { runNamedQuery, type DataQueryResult } from '../data/query-runner.js';

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
  retailRows: Sbd01RetailRow[];
  vendorRows: Sbd03VendorRow[];
  adsRows: Sbd02AdsRow[];
  matchRows: Sbd04MatchRow[];
  /** One entry per query id that failed; the corresponding rows array above
   *  is empty for that side rather than the whole call throwing. */
  errors: Array<{ query_id: string; message: string; friendly: string }>;
}

/**
 * Fetch all four sbd-* named queries for one Amazon Seller ID. Tolerant of
 * individual query failures (e.g. `unknown_query` while the gateway pack
 * entries are still being deployed) — a partial result with `ok: false` and
 * populated `errors` is returned rather than throwing, so the caller can
 * still render whatever sides succeeded.
 */
export async function fetchLabelDiscovery(
  amazonSellerId: string,
  options: { dataDirOverride?: string; queryTimeoutMs?: number } = {},
): Promise<LabelDiscoveryFetchResult> {
  const params = { AmazonSellerID: amazonSellerId };
  const queryOpts = {
    params,
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
    retailRows: rowsOf('sbd-01', retail),
    adsRows: rowsOf('sbd-02', ads),
    vendorRows: rowsOf('sbd-03', vendor),
    matchRows: rowsOf('sbd-04', match),
    errors,
  };
}
