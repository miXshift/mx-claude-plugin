/**
 * Phase 1.5 enrichment output shapes.
 *
 * Three analyses, written together to `runs/mx-account-cold-start/<date>/
 * <date>.enrichment.json`:
 *
 *   1. daily_settlement_curve  — from CS-28 (attribution settlement math)
 *   2. stockout_candidates     — from CS-29 + CS-30 (inventory-window stitching)
 *   3. brand_term_typo_candidates — from CS-31 (search-term typo clustering)
 *
 * Delta-mode merge (Phase C.6) patches `daily_settlement_curve` into
 * `context.yaml::capture_rate_calibration.daily_settlement_curve` without
 * touching AM-edited fields. The two detected_anomalies fields land in
 * `context.yaml::detected_anomalies` as a pending list — additive merge
 * (never wipe entries the AM hasn't yet confirmed or dismissed).
 *
 * Shapes mirror Todd's `enrich-context.py` output. Stable across Phase C
 * sub-phases (C.2/C.3/C.4 each fill in one of the three blocks).
 */

// ---------------------------------------------------------------------------
// 1. Daily settlement curve (CS-28)
// ---------------------------------------------------------------------------

export type CampaignType = 'sponsoredProducts' | 'sponsoredBrands' | 'sponsoredDisplay';

export type StabilityScore = 'high' | 'medium' | 'low';

export interface SettlementCurveCell {
  acos_1day: number | null;
  acos_7day: number | null;
  acos_14day: number | null;
  improvement_pts_1_to_7: number | null;
  improvement_pts_1_to_14: number | null;
  settled_pct_at_1day: number | null;
  /** "insufficient data" when low-volume cells can't compute reliably. */
  status?: 'computed' | 'insufficient_data';
}

export interface SettlementCurve {
  by_campaign_type: {
    sponsoredProducts: SettlementCurveCell;
    sponsoredBrands: SettlementCurveCell;
    sponsoredDisplay: SettlementCurveCell;
  };
  /** Additive day-of-week offsets to the base curve. Positive = settles slower. */
  dow_offset_pts: {
    monday: number;
    tuesday: number;
    wednesday: number;
    thursday: number;
    friday: number;
    saturday: number;
    sunday: number;
  };
  /** High/medium/low based on std-dev of settlement % across the trailing-12-month window. */
  stability_score: StabilityScore;
  /** ISO timestamp this curve was last computed. */
  last_calibrated: string;
}

// ---------------------------------------------------------------------------
// 2. Stockout candidates (CS-29 + CS-30)
// ---------------------------------------------------------------------------

export type StockoutSignalSource =
  | 'sellable_zero'
  | 'alert_active'
  | 'days_of_supply_low'
  | 'multi';

export interface StockoutCandidate {
  asin: string;
  item_name: string;
  /** ISO date YYYY-MM-DD. */
  started: string;
  /** ISO date YYYY-MM-DD. May equal started if still active. */
  ended: string;
  /** Total days in the contiguous window. */
  days_in_window: number;
  /** Days within the window where SellableQuantity = 0 (subset of days_in_window). */
  days_at_zero: number;
  /** Estimated ad-attributed revenue lost across the window (USD). */
  impacted_revenue_usd: number;
  /** Which signal(s) caught the window — 'multi' when more than one fired. */
  signal_source: StockoutSignalSource;
}

// ---------------------------------------------------------------------------
// 3. Brand-name typo clusters (CS-31)
// ---------------------------------------------------------------------------

export type TypoMatchType = 'levenshtein' | 'token_membership';

export interface BrandTermVariant {
  /** The actual search-term string. */
  term: string;
  /** Orders attributed to this variant in the trailing 90-day window. */
  orders: number;
  sales: number;
  spend: number;
}

export interface BrandTermTypoCluster {
  /** The canonical brand term this cluster maps to. */
  canonical_match: string;
  /** The shared root token (the substring all variants in the cluster share). */
  root_token: string;
  /** Levenshtein distance for `levenshtein` matches; 0 for `token_membership`. */
  distance: number;
  /** Why this cluster matched. See TypoMatchType. */
  match_type: TypoMatchType;
  variant_count: number;
  total_orders: number;
  total_sales: number;
  total_spend: number;
  /** Top variants in the cluster (sorted by orders desc). Capped at 5. */
  top_variants: BrandTermVariant[];
  /** All variants in the cluster (full list — top_variants is a UI subset). */
  all_variants: BrandTermVariant[];
}

// ---------------------------------------------------------------------------
// Top-level enrichment artifact
// ---------------------------------------------------------------------------

export interface EnrichmentArtifact {
  schema_version: 1;
  brand_slug: string;
  run_date: string;
  /** ISO timestamp when enrichment ran. */
  generated_at: string;
  /** Number of accounts (SellerIDs) the enrichment spanned. */
  account_count: number;
  /** Set when one or more sub-analyses had insufficient data or failed
   *  outright. The artifact is still written; consumers branch on this. */
  partial: boolean;
  partial_reasons: string[];

  daily_settlement_curve: SettlementCurve | null;
  stockout_candidates: StockoutCandidate[];
  brand_term_typo_candidates: BrandTermTypoCluster[];
}
