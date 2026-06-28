/**
 * Pure assembly: warehouse rows in, Brand Brain document out.
 *
 * No filesystem, no network, no environment reads. This function is the
 * piece that moves server-side verbatim at the P2 promotion (the brain
 * service runs the same assembly on cron); keeping it pure is what makes
 * that move a transport swap instead of a rewrite. I/O lives in
 * lib/brain/fetch.ts (client transport, P1).
 */

import { createHash } from 'node:crypto';
import {
  BRAIN_SCHEMA_VERSION,
  type BrandBrain,
  type BrainSeller,
  type BrainCatalog,
  type BrainCampaignStructure,
  type BrainHeroAsin,
  type BrainRecentActivity,
  type BrainSourceMeta,
  type BrainCaptureRateCalibration,
  type BrainStockout,
  type BrainBrandTermTypo,
} from './schema.js';
import {
  computeSettlementCurve,
  type CS28Row,
} from '../enrichment/settlement-curve.js';
import {
  detectStockoutWindows,
  type CS29Row,
  type CS30Row,
} from '../enrichment/stockout-windows.js';
import {
  detectBrandTermTypos,
  type CS31Row,
  type BrandTermsBlock,
} from '../enrichment/brand-typos.js';
import {
  deriveCaptureRateCalibration,
  type CS06Row,
  type CS07Row,
  type CS08Row,
} from '../enrichment/capture-rate.js';

/** Raw row shape as returned by the brain SPs (or the local dev
 *  fallback SQL). Values arrive untyped from the wire; normalization is
 *  defensive. */
export type RawSellerRow = Record<string, unknown>;
export type RawCatalogRow = Record<string, unknown>;
export type RawCampaignRow = Record<string, unknown>;

/** Rows + provenance for one fetched source. */
export interface SourceInput<Row> {
  rows: Row[];
  /** Which procedure/query produced the rows (provenance). */
  sproc: string;
}

export interface AssembleBrainInput {
  brandSlug: string;
  sellerRows: RawSellerRow[];
  /** Which procedure/query produced sellerRows (provenance). */
  sellerSproc: string;
  /** The brand's PRIMARY seat id (registry-derived; see
   *  fetch.ts::pickPrimarySeat). When set, the seller scalars lift from the
   *  row whose `ID` matches this, instead of the arbitrary-row heuristic. */
  primarySellerId?: number | null;
  /** e.g. `plugin@0.5.21`. P2 passes `brain-service@x.y`. */
  generator: string;
  /** Injected for determinism in tests; defaults to now. */
  now?: Date;
  /** Carried forward from the previous document so a re-fetch never
   *  drops accumulated S3 observations. */
  previousObservations?: BrandBrain['observations'];
  /** Slice-2 sources. Omitted = source not applicable or failed; the
   *  corresponding section + source meta are simply absent. */
  catalogSc?: SourceInput<RawCatalogRow>;
  catalogVc?: SourceInput<RawCatalogRow>;
  campaign?: SourceInput<RawCampaignRow>;
  /** Slice-3 hero-ASIN sources (top sellers by trailing-365d revenue),
   *  per channel. Fold into catalog.top_asins. */
  heroSc?: SourceInput<RawCatalogRow>;
  heroVc?: SourceInput<RawCatalogRow>;
  /** Slice-3 recent-activity source: the single BRAIN-RECENT-ACTIVITY row
   *  (trailing-30d ad spend/sales rolled up across all the brand's
   *  sellers). */
  recentActivity?: SourceInput<RawSellerRow>;
  // -- Phase 8 enrichment sources (I/O-free computers; called directly) --
  /** CS-28 settlement-curve rows. Drives the nested daily curve AND the
   *  `capture_rate` source meta (the canonical capture-rate provenance). */
  settlement?: SourceInput<CS28Row>;
  /** CS-06 (SC) attribution-window monthly rows — capture-rate scalars. */
  captureRateSc?: SourceInput<CS06Row>;
  /** CS-07 (VC) attribution-window monthly rows — capture-rate scalars. */
  captureRateVc?: SourceInput<CS07Row>;
  /** CS-08 daily 1d-vs-7d distribution — capture-rate scalars. */
  captureRateDaily?: SourceInput<CS08Row>;
  /** CS-29 FBA out-of-stock ASIN-day rows (stockout windows). */
  stockout?: SourceInput<CS29Row>;
  /** CS-30 daily ad-sales rows — impact-$ helper for stockout windows
   *  (NOT a brain section of its own; structural_events is descoped). */
  stockoutImpact?: SourceInput<CS30Row>;
  /** CS-31 converting search-term corpus rows (brand-term typos). */
  brandTypos?: SourceInput<CS31Row>;
  /** Tier-3 brand_terms (+ competitor_brands) for the typo detector. Absent
   *  for a brand-new brand → the typo section NO-OPS cleanly (omitted). */
  brandTermsInput?: {
    brand_terms: BrandTermsBlock;
    competitor_brands?: string[];
  };
}

/**
 * Assemble the brain document from whichever sources fetched. Seller is
 * the spine (always present); catalog/campaign sections render only
 * when their sources are provided. The envelope shape stays stable as
 * sources grow.
 */
export function assembleBrain(input: AssembleBrainInput): BrandBrain {
  const now = input.now ?? new Date();
  const seller = assembleSellerSection(input.sellerRows, input.primarySellerId);

  const meta = <Row,>(src: SourceInput<Row>): BrainSourceMeta => ({
    sproc: src.sproc,
    fetched_at: now.toISOString(),
    row_count: src.rows.length,
    source_hash: hashRows(src.rows as Array<Record<string, unknown>>),
  });

  const sources: BrandBrain['sources'] = {
    seller: meta({ rows: input.sellerRows, sproc: input.sellerSproc }),
  };
  if (input.catalogSc) sources.catalog_sc = meta(input.catalogSc);
  if (input.catalogVc) sources.catalog_vc = meta(input.catalogVc);
  if (input.campaign) sources.campaign = meta(input.campaign);
  if (input.heroSc) sources.hero_sc = meta(input.heroSc);
  if (input.heroVc) sources.hero_vc = meta(input.heroVc);
  if (input.recentActivity) sources.recent_activity = meta(input.recentActivity);
  // Phase 8 enrichment source metas. capture_rate is canonically the CS-28
  // settlement source (richest; drives the nested curve); the CS-06/07/08
  // scalar sources fold into the same section without their own meta keys,
  // mirroring how CS-30 helps stockout without its own key.
  if (input.settlement) sources.capture_rate = meta(input.settlement);
  if (input.stockout) sources.stockout = meta(input.stockout);
  if (input.brandTypos) sources.brand_typos = meta(input.brandTypos);

  const captureRate = assembleCaptureRateSection(input);
  const stockouts = input.stockout
    ? assembleStockoutSection(
        input.stockout.rows,
        input.stockoutImpact?.rows ?? [],
      )
    : undefined;
  const brandTermTypos = assembleBrandTypoSection(input);

  // Catalog section renders when any catalog OR hero source ran — hero
  // ASINs hang off catalog.top_asins, and a brand could (in principle)
  // have hero data without the taxonomy pull.
  const hasCatalog =
    input.catalogSc || input.catalogVc || input.heroSc || input.heroVc;

  return {
    schema_version: BRAIN_SCHEMA_VERSION,
    brand_slug: input.brandSlug,
    generated_at: now.toISOString(),
    generator: input.generator,
    sources,
    seller,
    ...(hasCatalog
      ? {
          catalog: assembleCatalogSection(
            input.catalogSc?.rows ?? null,
            input.catalogVc?.rows ?? null,
            input.heroSc?.rows ?? null,
            input.heroVc?.rows ?? null,
          ),
        }
      : {}),
    ...(input.campaign
      ? { campaign_structure: assembleCampaignSection(input.campaign.rows) }
      : {}),
    ...(input.recentActivity
      ? {
          recent_activity: assembleRecentActivity(
            input.recentActivity.rows[0],
            now,
          ),
        }
      : {}),
    ...(captureRate ? { capture_rate_calibration: captureRate } : {}),
    ...(stockouts !== undefined ? { stockouts } : {}),
    ...(brandTermTypos !== undefined ? { brand_term_typos: brandTermTypos } : {}),
    observations: input.previousObservations ?? {},
  };
}

/**
 * Lift the seller section from the fetched rows. Multi-marketplace
 * brands return one row per seller id; scalar fields lift from the
 * PRIMARY row. When `primarySellerId` is supplied (registry-derived; see
 * fetch.ts::pickPrimarySeat), the primary is the row whose `ID` matches it —
 * that's the truthful pick for multi-seat brands. Falls back to the legacy
 * heuristic (first row with a non-null ACOSTarget, else the first row) when no
 * id is given or no row matches it, so existing callers stay correct.
 * Per-account detail lives in the registry (index.yaml), not here.
 *
 * Exported for unit tests.
 */
export function assembleSellerSection(
  rows: RawSellerRow[],
  primarySellerId?: number | null,
): BrainSeller {
  const byId =
    primarySellerId != null
      ? rows.find((r) => toNumber(r.ID) === primarySellerId)
      : undefined;
  const primary =
    byId ?? rows.find((r) => toNumber(r.ACOSTarget) !== null) ?? rows[0] ?? {};

  return {
    merchant_alias: toTrimmedString(primary.MerchantAlias),
    storefront_name: toTrimmedString(primary.Name),
    acos_target_pct: toNumber(primary.ACOSTarget),
    monthly_budget: toNumber(primary.MonthlyBudget),
    marketplace: toTrimmedString(primary.MarketPlaceName),
    merchant_region: toTrimmedString(primary.MerchantRegion),
    agency_name: toTrimmedString(primary.AgencyName),
    default_currency_code: toTrimmedString(primary.DefaultCurrencyCode),
    i_brand_report_enabled: toBool(primary.iBrandReportEnabled),
    i_running_initial_pull: toBool(primary.iRunningInitialPull),
    data_freshness: {
      ads_latest: toIso(primary.dtLatestRecordDate),
      retail_latest: toIso(primary.dtMWSLatestRecordDate),
    },
    activated: {
      ads: toIso(primary.dtActivatedOn),
      retail: toIso(primary.dtMwsActivatedOn),
    },
    primary_seller_id: toNumber(primary.ID),
  };
}

/**
 * Merge SC + VC catalog rows into the aggregated catalog section. The
 * brain stores the SHAPE of the catalog (distincts + counts), never
 * per-ASIN dumps. `null` rows = that channel's source didn't run (vs an
 * empty array = ran and returned nothing).
 *
 * Sub-brand sources per the locked design: SC rows use `Brand`
 * (mws_items); VC rows prefer the AM-set `CustomBrand`, falling back to
 * the Amazon-derived `Brand`.
 *
 * Exported for unit tests.
 */
export function assembleCatalogSection(
  scRows: RawCatalogRow[] | null,
  vcRows: RawCatalogRow[] | null,
  heroScRows: RawCatalogRow[] | null = null,
  heroVcRows: RawCatalogRow[] | null = null,
): BrainCatalog {
  const asins = new Set<string>();
  const subBrands = new Set<string>();
  const itemGroups = new Set<string>();
  const skus = new Set<string>();

  for (const r of scRows ?? []) {
    addIf(asins, toTrimmedString(r.ASIN ?? r.Asin));
    addIf(skus, toTrimmedString(r.SKU));
    addIf(subBrands, toTrimmedString(r.Brand));
    addIf(itemGroups, toTrimmedString(r.ItemGroup));
  }
  for (const r of vcRows ?? []) {
    addIf(asins, toTrimmedString(r.Asin ?? r.ASIN));
    addIf(subBrands, toTrimmedString(r.CustomBrand) ?? toTrimmedString(r.Brand));
    addIf(itemGroups, toTrimmedString(r.ItemGroup));
  }

  const sc = heroScRows ? heroScRows.map(toHeroAsin).filter(isHeroAsin) : null;
  const vc = heroVcRows ? heroVcRows.map(toHeroAsin).filter(isHeroAsin) : null;
  const topAsins =
    sc || vc ? { ...(sc ? { sc } : {}), ...(vc ? { vc } : {}) } : undefined;

  return {
    asin_count: asins.size,
    sku_count: scRows === null ? null : skus.size,
    sub_brands: [...subBrands].sort(),
    item_groups: [...itemGroups].sort(),
    ...(topAsins ? { top_asins: topAsins } : {}),
  };
}

/**
 * Map a hero-source row (BRAIN-HERO-SC / -VC) to the typed hero shape.
 * Both sources alias to the same columns (asin, title,
 * ordered_revenue_365d, units_365d). Rows arrive already ranked
 * (ORDER BY revenue DESC LIMIT 20) so order is preserved.
 */
function toHeroAsin(r: RawCatalogRow): BrainHeroAsin | null {
  const asin = toTrimmedString(r.asin ?? r.ASIN ?? r.Asin);
  if (!asin) return null;
  return {
    asin,
    title: toTrimmedString(r.title ?? r.Title ?? r.ItemName),
    ordered_revenue_365d: toNumber(r.ordered_revenue_365d) ?? 0,
    units_365d: toIntOrNull(r.units_365d),
    // SC-only stock (VC hero rows omit these → null).
    sellable_qty: toIntOrNull(r.sellable_qty),
    days_of_supply: toIntOrNull(r.days_of_supply),
  };
}

function isHeroAsin(v: BrainHeroAsin | null): v is BrainHeroAsin {
  return v !== null;
}

/**
 * Build the recent-activity baseline from the single BRAIN-RECENT-ACTIVITY
 * row (trailing-30d ad spend + ad sales, brand-wide). ACoS is
 * spend/sales*100, null when sales are zero. `row` may be undefined if the
 * source returned no rows (a quiet brand returns one all-null row, so this
 * is belt-and-suspenders).
 *
 * Exported for unit tests.
 */
export function assembleRecentActivity(
  row: RawSellerRow | undefined,
  now: Date,
): BrainRecentActivity {
  const spend = toNumber(row?.spend_30d);
  const adSales = toNumber(row?.ad_sales_30d);
  const acos =
    spend !== null && adSales !== null && adSales !== 0
      ? Math.round((spend / adSales) * 10000) / 100
      : null;
  return {
    spend_30d: spend,
    ad_sales_30d: adSales,
    acos_30d: acos,
    as_of: now.toISOString(),
  };
}

/**
 * Aggregate enabled+paused campaign rows into the campaign-structure
 * section. Percentages are whole numbers.
 *
 * objective_tag_completeness_pct: share of ALL campaigns carrying a
 * non-empty Objective. The brain's substitute for the deep skill's retired
 * CS-27 (campaign-objective completeness). Loses CS-27's spend-weighting and
 * its T-30-spending pre-filter (acceptable: the brain stores shape, not the
 * per-campaign spend list) — it is a flat row share over every BRAIN-CAMPAIGN
 * row.
 *
 * smart_default_adoption_pct: share of ALL campaigns whose
 * BidOptimization flag is set. Verified against the warehouse
 * 2026-06-12: the column is a nullable '1' flag (NULL / '' = off,
 * '1' = smart bidding on), so the denominator is every campaign row,
 * not just rows carrying a value. The SMART_BID_VALUES set keeps a few
 * defensive synonyms in case the convention ever changes.
 *
 * Exported for unit tests.
 */
export function assembleCampaignSection(
  rows: RawCampaignRow[],
): BrainCampaignStructure {
  const objectives = new Set<string>();
  const itemGroups = new Set<string>();
  const brands = new Set<string>();
  let paused = 0;
  let withObjective = 0;
  let bidSmart = 0;
  let brandEntity = 0;

  for (const r of rows) {
    const objective = toTrimmedString(r.Objective);
    addIf(objectives, objective);
    if (objective) withObjective++;
    addIf(itemGroups, toTrimmedString(r.ItemGroup));
    addIf(brands, toTrimmedString(r.Brand));
    if (toTrimmedString(r.State)?.toLowerCase() === 'paused') paused++;
    const bid = toTrimmedString(r.BidOptimization)?.toLowerCase();
    if (bid && SMART_BID_VALUES.has(bid)) bidSmart++;
    if (toTrimmedString(r.BrandEntityId)) brandEntity++;
  }

  return {
    campaign_count: rows.length,
    paused_campaign_count: paused,
    distinct_objectives: [...objectives].sort(),
    distinct_item_groups: [...itemGroups].sort(),
    distinct_brands: [...brands].sort(),
    objective_tag_completeness_pct:
      rows.length > 0 ? Math.round((withObjective / rows.length) * 100) : null,
    smart_default_adoption_pct:
      rows.length > 0 ? Math.round((bidSmart / rows.length) * 100) : null,
    brand_entity_id_presence_pct:
      rows.length > 0 ? Math.round((brandEntity / rows.length) * 100) : null,
  };
}

const SMART_BID_VALUES = new Set([
  'smart',
  'default',
  'auto',
  'optimized',
  'enabled',
  'true',
  '1',
]);

// ---------------------------------------------------------------------------
// Phase 8 enrichment section builders. Each wraps an I/O-free computer
// (settlement-curve / stockout-windows / brand-typos) or the new capture-rate
// deriver and shapes its output to the brain schema. Pure: no I/O, no Date.now
// of their own beyond what the computers already do.
// ---------------------------------------------------------------------------

/**
 * Capture-rate calibration: the CS-06/07/08 scalars (deriveCaptureRateCalibration)
 * plus the nested CS-28 daily curve (computeSettlementCurve). Returns undefined
 * when neither source produced anything, so the section is omitted entirely. When
 * only the curve computes, the scalars carry a null/curve-only fallback so the
 * block still renders the richer signal monthly-report prefers.
 */
export function assembleCaptureRateSection(
  input: AssembleBrainInput,
): BrainCaptureRateCalibration | undefined {
  const scalars = deriveCaptureRateCalibration({
    cs06: input.captureRateSc?.rows ?? null,
    cs07: input.captureRateVc?.rows ?? null,
    cs08: input.captureRateDaily?.rows ?? null,
  });
  const curve = input.settlement
    ? computeSettlementCurve(input.settlement.rows)
    : null;

  if (!scalars && !curve) return undefined;

  const base: BrainCaptureRateCalibration = scalars ?? {
    enabled: true,
    capture_rate_pct: null,
    fresh_day_acos_improvement_pts: null,
    settlement_application_rule:
      'Derived from the daily settlement curve only; no monthly attribution-window comparison was available.',
    basis: null,
    settled_window_days: null,
  };
  return curve ? { ...base, daily_settlement_curve: curve } : base;
}

/**
 * Detected FBA stockout windows (advisory). Direct pass-through of
 * detectStockoutWindows; StockoutCandidate is structurally BrainStockout.
 * Returns [] when the source ran and found none.
 */
export function assembleStockoutSection(
  cs29Rows: CS29Row[],
  cs30Rows: CS30Row[],
): BrainStockout[] {
  return detectStockoutWindows(cs29Rows, cs30Rows);
}

/**
 * Detected brand-term typo clusters (advisory). NO-OPS cleanly (returns
 * undefined → section omitted) when the brand has no Tier-3 brand_terms yet
 * (cold-start hasn't run) or the search-term source didn't run; it populates on
 * a later refresh once brand_terms exists. Returns [] when it ran with
 * brand_terms but found no typos.
 */
export function assembleBrandTypoSection(
  input: AssembleBrainInput,
): BrainBrandTermTypo[] | undefined {
  if (!input.brandTypos || !input.brandTermsInput) return undefined;
  return detectBrandTermTypos(
    input.brandTypos.rows,
    input.brandTermsInput.brand_terms,
    { competitor_brands: input.brandTermsInput.competitor_brands ?? [] },
  );
}

function addIf(set: Set<string>, v: string | null | undefined): void {
  if (v) set.add(v);
}

/**
 * Deterministic content hash of the normalized rows. Used as the source
 * etag: identical warehouse data hashes identically across fetches, so
 * "did anything change" is one string compare (and at P2, a conditional
 * GET).
 */
export function hashRows(rows: RawSellerRow[]): string {
  const canonical = JSON.stringify(
    rows.map((r) =>
      Object.keys(r)
        .sort()
        .map((k) => [k, normalizeForHash(r[k])]),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeForHash(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v ?? null;
}

// ---------------------------------------------------------------------------
// Defensive coercion. Warehouse values arrive as numbers, numeric strings,
// Date objects, ISO strings, 0/1 tinyints, or NULL depending on driver and
// transport (mysql2 direct vs datahub JSON). Assembly must never throw on a
// sparse or oddly-typed row.
// ---------------------------------------------------------------------------

function toTrimmedString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.trunc(n);
}

function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const n = toNumber(v);
  if (n === null) return null;
  return n !== 0;
}

function toIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
