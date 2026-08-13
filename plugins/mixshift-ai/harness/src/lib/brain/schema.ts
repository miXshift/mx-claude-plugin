/**
 * Brand Brain contract (Tier 2): the versioned document every consumer
 * reads, regardless of transport.
 *
 * Today the document lives at ~/.mixshift/clients/<slug>/brand-brain.yaml,
 * assembled client-side by lib/brain/fetch.ts. At P2 the same document is
 * served by a MixShift endpoint (GET /api/brain/:brand) assembled
 * server-side. Skills never read the file directly; they go through
 * lib/brain/read.ts, so the transport swap never touches skill code.
 *
 * Layer boundaries (the litmus, applied in order):
 *   1. Two unrelated skills want the same value      → not OCL
 *   2. System can produce it without a human         → brain (this file)
 *   3. Human judgment about the brand itself         → context.yaml (Tier 3)
 *   4. Knob on one skill's behavior                  → OCL
 * Precedence at read time: OCL > context.yaml > brain > skill default.
 * The brain proposes; Tier 3 always wins; promotion copies a confirmed
 * Tier-2 value into context.yaml with provenance.
 *
 * Versioning: schema_version bumps on breaking shape changes; readers
 * MUST check it. A brain written by an older schema is re-fetchable
 * cheaply (it is a cache of warehouse state), so migrations may simply
 * discard + refetch during P1.
 */

import { z } from 'zod';

/**
 * Provenance for one assembled source. `source_hash` is a sha256 of the
 * normalized input rows; at P2 it doubles as the etag for conditional
 * GETs. `sproc` records which warehouse procedure produced the rows
 * (or the catalog query id when the local dev fallback ran).
 */
export const brainSourceMetaSchema = z.object({
  sproc: z.string(),
  fetched_at: z.iso.datetime(),
  row_count: z.number().int().min(0),
  source_hash: z.string(),
});

export type BrainSourceMeta = z.infer<typeof brainSourceMetaSchema>;

/**
 * Seller-level facts (source class S1, platform facts). First-slice
 * field set; everything nullable
 * because warehouse rows are sparse and the brain must tolerate partial
 * data without failing assembly.
 *
 * Expected result-set columns from sp_brain_seller_fetch (one row per
 * seller id): MerchantAlias, Name, ACOSTarget, MonthlyBudget,
 * MarketPlaceName, MerchantRegion, AgencyName, DefaultCurrencyCode,
 * iBrandReportEnabled, iRunningInitialPull, dtLatestRecordDate,
 * dtMWSLatestRecordDate, dtActivatedOn, dtMwsActivatedOn.
 */
export const brainSellerSchema = z.object({
  merchant_alias: z.string().nullable(),
  /** Warehouse seller.Name (storefront/legal label). */
  storefront_name: z.string().nullable(),
  /** seller.ACOSTarget as set in the MixShift platform. The single most
   *  consumed brain field: DHC, monthly-report, PQS, KBH all want it. */
  acos_target_pct: z.number().nullable(),
  monthly_budget: z.number().nullable(),
  marketplace: z.string().nullable(),
  merchant_region: z.string().nullable(),
  agency_name: z.string().nullable(),
  default_currency_code: z.string().nullable(),
  i_brand_report_enabled: z.boolean().nullable(),
  i_running_initial_pull: z.boolean().nullable(),
  data_freshness: z.object({
    ads_latest: z.iso.datetime().nullable(),
    retail_latest: z.iso.datetime().nullable(),
  }),
  activated: z.object({
    ads: z.iso.datetime().nullable(),
    retail: z.iso.datetime().nullable(),
  }),
  /** Which seller_id the lifted scalar fields came from (the primary
   *  row: first row with a non-null ACOSTarget, else the first row).
   *  Multi-marketplace brands have several rows; per-account detail
   *  stays in the registry (index.yaml), not here. */
  primary_seller_id: z.number().int().nullable(),
});

export type BrainSeller = z.infer<typeof brainSellerSchema>;

/**
 * Catalog facts (source class S1), AGGREGATED. The brain never stores
 * per-ASIN row dumps; it stores the shape of the catalog. SC rows come
 * from sp_brain_catalog_fetch_sc (mws_items), VC rows from
 * sp_brain_catalog_fetch_vc (vendor_items); both merge into this one
 * section. Sub-brand source: SC uses Brand; VC prefers the AM-set
 * CustomBrand, falling back to the Amazon-derived Brand.
 */
/**
 * One hero ASIN: a top seller by trailing-365d ordered revenue. Channel
 * split (sc/vc) because a hybrid 1P+3P brand sells the same ASIN through
 * both at different revenue. Sources: BRAIN-HERO-SC
 * (business_reports_dpst_sku) / BRAIN-HERO-VC
 * (vendor_sales_manufacturing_asin).
 */
export const brainHeroAsinSchema = z.object({
  asin: z.string(),
  title: z.string().nullable(),
  ordered_revenue_365d: z.number(),
  units_365d: z.number().int().nullable(),
  /** Current FBA sellable units from the latest mws_inventory_health
   *  snapshot (SC only; the live `Available` field, not the deprecated
   *  SellableQuantity). FBA on-hand ONLY by decision (2026-06-12) —
   *  merchant-fulfilled stock (mws_items.ItemQuantityAvailable) is omitted
   *  in v1. Null when no inventory row joins. */
  sellable_qty: z.number().int().nullable(),
  /** Days of supply on that snapshot (tightest populated). Null when
   *  absent. */
  days_of_supply: z.number().int().nullable(),
});

export type BrainHeroAsin = z.infer<typeof brainHeroAsinSchema>;

export const brainCatalogSchema = z.object({
  /** Distinct ASINs across SC + VC rows. */
  asin_count: z.number().int().min(0),
  /** Distinct SC SKUs (VC has no SKU grain). Null when no SC source ran. */
  sku_count: z.number().int().min(0).nullable(),
  sub_brands: z.array(z.string()),
  item_groups: z.array(z.string()),
  /** Top sellers by trailing-365d revenue, per channel. A channel key is
   *  present only when its hero source ran. Replaces hero_asins_deferred. */
  top_asins: z
    .object({
      sc: z.array(brainHeroAsinSchema).optional(),
      vc: z.array(brainHeroAsinSchema).optional(),
    })
    .optional(),
  /** Legacy marker from the pre-hero brain (slices 1-2). Optional now that
   *  top_asins populates; kept so brains written before this slice still
   *  validate without a re-fetch. */
  hero_asins_deferred: z.literal(true).optional(),
});

export type BrainCatalog = z.infer<typeof brainCatalogSchema>;

/**
 * Recent ad-activity baseline (source class S1, cached from
 * BRAIN-RECENT-ACTIVITY at brain-fetch time so skills need not
 * re-pull it). Brand-wide: trailing-30d ad spend + ad
 * sales summed across ALL the brand's sellers (not a single account —
 * the brand's ad activity may sit on any seat). acos is null when ad
 * sales are zero (no division).
 */
export const brainRecentActivitySchema = z.object({
  spend_30d: z.number().nullable(),
  ad_sales_30d: z.number().nullable(),
  acos_30d: z.number().nullable(),
  /** When the window was computed (brain-fetch time). */
  as_of: z.iso.datetime(),
});

export type BrainRecentActivity = z.infer<typeof brainRecentActivitySchema>;

/**
 * Campaign-structure facts (source class S1 + light S2 derivations),
 * AGGREGATED from sp_brain_campaign_fetch rows (enabled + paused
 * campaigns). Percentages are whole numbers 0-100.
 */
export const brainCampaignStructureSchema = z.object({
  campaign_count: z.number().int().min(0),
  paused_campaign_count: z.number().int().min(0),
  distinct_objectives: z.array(z.string()),
  distinct_item_groups: z.array(z.string()),
  distinct_brands: z.array(z.string()),
  /** % of campaigns carrying a non-empty Objective tag. The brain's
   *  substitute for the deep skill's retired CS-27 (campaign-objective
   *  completeness). Whole number 0-100. NOTE: unlike CS-27 this is NOT
   *  spend-weighted and does not pre-filter to T-30 spending campaigns — it
   *  is a flat share over every campaign row the BRAIN-CAMPAIGN source
   *  returned (enabled + paused). null only when there are no campaigns.
   *  `.optional()` for backward-compat: brains fetched before this field
   *  existed (and older test fixtures) must still validate on load. */
  objective_tag_completeness_pct: z.number().min(0).max(100).nullable().optional(),
  /** % of campaigns on smart/default bid optimization. Derivation
   *  assumption (BidOptimization value semantics) is flagged in the SP
   *  draft; verify against real warehouse values. */
  smart_default_adoption_pct: z.number().min(0).max(100).nullable(),
  /** % of campaigns carrying a BrandEntityId. */
  brand_entity_id_presence_pct: z.number().min(0).max(100).nullable(),
});

export type BrainCampaignStructure = z.infer<typeof brainCampaignStructureSchema>;

/**
 * Capture-rate (attribution-window) calibration (source class S1+S2,
 * Phase 8 enrichment). Auto-derived from CS-06/07/08 (the scalars) +
 * CS-28 (the nested daily curve); see lib/enrichment/capture-rate.ts and
 * lib/enrichment/settlement-curve.ts. Mirrors context.yaml's
 * `capture_rate_calibration` block (lib/context/schema.ts) so a brain
 * pre-fill and an AM-confirmed value are directly comparable — Tier 3 wins.
 *
 * PERCENTAGE-NUMBER convention throughout (e.g. 28.5 = 28.5%, 12.0 = 12
 * points), matching settlement-curve.ts + the Tier-3 schema. The brain
 * adds two provenance scalars not in the Tier-3 shape (`basis`,
 * `settled_window_days`) so a consumer knows which channel/window the
 * scalars were measured on.
 */
export const brainSettlementCellSchema = z.object({
  acos_1day: z.number().nullable(),
  acos_7day: z.number().nullable(),
  acos_14day: z.number().nullable(),
  improvement_pts_1_to_7: z.number().nullable(),
  improvement_pts_1_to_14: z.number().nullable(),
  settled_pct_at_1day: z.number().nullable(),
  status: z.enum(['computed', 'insufficient_data']).optional(),
});

export const brainDailySettlementCurveSchema = z.object({
  by_campaign_type: z.object({
    sponsoredProducts: brainSettlementCellSchema,
    sponsoredBrands: brainSettlementCellSchema,
    sponsoredDisplay: brainSettlementCellSchema,
  }),
  dow_offset_pts: z.object({
    monday: z.number(),
    tuesday: z.number(),
    wednesday: z.number(),
    thursday: z.number(),
    friday: z.number(),
    saturday: z.number(),
    sunday: z.number(),
  }),
  stability_score: z.enum(['high', 'medium', 'low']),
  last_calibrated: z.string(),
});

export const brainCaptureRateCalibrationSchema = z.object({
  enabled: z.boolean(),
  capture_rate_pct: z.number().nullable(),
  fresh_day_acos_improvement_pts: z.number().nullable(),
  settlement_application_rule: z.string(),
  /** Which channel/window the scalars were measured on. */
  basis: z.enum(['SC', 'VC']).nullable(),
  settled_window_days: z.number().int().nullable(),
  /** The CS-28 daily curve, nested exactly as in the Tier-3 block.
   *  Present only when the settlement source ran and produced a curve. */
  daily_settlement_curve: brainDailySettlementCurveSchema.optional(),
});

export type BrainCaptureRateCalibration = z.infer<
  typeof brainCaptureRateCalibrationSchema
>;

/**
 * One ADVISORY stockout window (source class S2, Phase 8 enrichment).
 * Auto-detected from CS-29 (FBA OOS ASIN-days) by
 * lib/enrichment/stockout-windows.ts. Advisory: a finding for an AM to
 * confirm into structural_events[], NOT a confirmed fact. Mirrors
 * StockoutCandidate (lib/enrichment/types.ts).
 *
 * Persisted brains carry an `impacted_revenue_usd` key this schema no
 * longer declares (the removed multiply-counted account-wide revenue,
 * fb 37350, on pre-0.8.8 brains; a compat-shim literal 0 on newer ones,
 * see assemble.ts::assembleStockoutSection). z.object strips unknown
 * keys by default, so the key silently drops on read either way.
 */
export const brainStockoutSchema = z.object({
  asin: z.string(),
  item_name: z.string(),
  started: z.string(),
  ended: z.string(),
  days_in_window: z.number().int(),
  days_at_zero: z.number().int(),
  signal_source: z.enum([
    'sellable_zero',
    'alert_active',
    'days_of_supply_low',
    'multi',
  ]),
});

export type BrainStockout = z.infer<typeof brainStockoutSchema>;

/**
 * One ADVISORY brand-term typo cluster (source class S2, Phase 8
 * enrichment). Auto-detected from CS-31 (converting search-term corpus)
 * vs Tier-3 brand_terms by lib/enrichment/brand-typos.ts. Advisory: a
 * finding for an AM to confirm into brand_terms.variants[], NOT a fact.
 * NO-OPS for brand-new brands with no brand_terms yet (the section is
 * simply omitted; it populates on a later refresh once cold-start ran).
 * Mirrors BrandTermTypoCluster (lib/enrichment/types.ts).
 */
export const brainBrandTermVariantSchema = z.object({
  term: z.string(),
  orders: z.number(),
  sales: z.number(),
  spend: z.number(),
});

export const brainBrandTermTypoSchema = z.object({
  canonical_match: z.string(),
  root_token: z.string(),
  distance: z.number().int(),
  match_type: z.enum(['levenshtein', 'token_membership']),
  variant_count: z.number().int(),
  total_orders: z.number(),
  total_sales: z.number(),
  total_spend: z.number(),
  top_variants: z.array(brainBrandTermVariantSchema),
  all_variants: z.array(brainBrandTermVariantSchema),
});

export type BrainBrandTermTypo = z.infer<typeof brainBrandTermTypoSchema>;

/**
 * One S3 observation aggregate: what skills have noticed, merged by
 * field path. Single observations never present as facts; `count` and
 * `confidence` carry the weight. See lib/brain/observe.ts for the
 * write-side envelope.
 */
export const brainObservationAggregateSchema = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  observed_by: z.string(),
  observed_at: z.iso.datetime(),
  count: z.number().int().min(1),
});

export type BrainObservationAggregate = z.infer<
  typeof brainObservationAggregateSchema
>;

/**
 * The Brand Brain document. Sections beyond `seller` (catalog, campaign,
 * derived) land in later slices; the envelope is stable from day one so
 * consumers written now survive the growth.
 */
export const brandBrainSchema = z.object({
  schema_version: z.literal(1),
  brand_slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  generated_at: z.iso.datetime(),
  /** What assembled this document: `plugin@<version>` during P1,
   *  `brain-service@<version>` after the P2 promotion. */
  generator: z.string(),
  sources: z.object({
    seller: brainSourceMetaSchema.optional(),
    catalog_sc: brainSourceMetaSchema.optional(),
    catalog_vc: brainSourceMetaSchema.optional(),
    campaign: brainSourceMetaSchema.optional(),
    hero_sc: brainSourceMetaSchema.optional(),
    hero_vc: brainSourceMetaSchema.optional(),
    recent_activity: brainSourceMetaSchema.optional(),
    // Phase 8 enrichment sources.
    capture_rate: brainSourceMetaSchema.optional(),
    stockout: brainSourceMetaSchema.optional(),
    brand_typos: brainSourceMetaSchema.optional(),
  }),
  seller: brainSellerSchema.optional(),
  /** Present when at least one catalog source (SC or VC) fetched ok. */
  catalog: brainCatalogSchema.optional(),
  /** Present when the campaign source fetched ok. */
  campaign_structure: brainCampaignStructureSchema.optional(),
  /** Brand-wide ad-activity baseline (cached BRAIN-RECENT-ACTIVITY).
   *  Present when the recent-activity source fetched ok. */
  recent_activity: brainRecentActivitySchema.optional(),
  /** Attribution-window calibration scalars (+ nested daily curve).
   *  Present when CS-06/07/08 and/or CS-28 produced usable signal. */
  capture_rate_calibration: brainCaptureRateCalibrationSchema.optional(),
  /** ADVISORY: detected FBA stockout windows (CS-29). Present
   *  when the stockout source ran; empty array when it ran and found
   *  none. AM confirms these into structural_events[]. */
  stockouts: z.array(brainStockoutSchema).optional(),
  /** ADVISORY: detected brand-term typo clusters (CS-31 vs Tier-3
   *  brand_terms). Omitted entirely when the brand has no brand_terms
   *  yet (cold-start hasn't run). AM confirms these into
   *  brand_terms.variants[]. */
  brand_term_typos: z.array(brainBrandTermTypoSchema).optional(),
  /** S3 skill observations, keyed by dotted field path
   *  (e.g. "buy_box_health.chronic_losers"). */
  observations: z.record(z.string(), brainObservationAggregateSchema).default({}),
  /** Sub-brand label-lens record (mx-ops#6): present only on a BOUND brand's
   *  brain. Which sources RESOLVED to which outcome (lib/binding/lens.ts) —
   *  consumers must not attribute a non-'applied' source's rows to the
   *  sub-brand. Every outcome here is evidence-based (resolved from the
   *  gateway's `applied_params` echo after the query returned), never a
   *  pre-query claim. Additive/optional: older readers strip it on read, and
   *  the brain is regenerated wholesale each fetch, so mixed-version fleets
   *  tolerate it. `dropped`/`unverified`/`query_failed` are additive on top
   *  of the original three-bucket shape (`.default([])` so a brain written
   *  by an earlier build of this same unreleased feature still parses). */
  label_lens: z
    .object({
      bound: z.boolean(),
      applied: z.array(z.string()).default([]),
      /** P0: the gateway did not honor a filter we sent — these rows are
       *  account-wide despite the binding. */
      dropped: z.array(z.string()).default([]),
      /** We sent a filter but the response carried no evidence either way
       *  (an older gateway deploy). Not proven label-scoped. */
      unverified: z.array(z.string()).default([]),
      account_wide: z.array(z.string()).default([]),
      missing_label_value: z.array(z.string()).default([]),
      /** The query failed or was deferred — no scoping claim was possible. */
      query_failed: z.array(z.string()).default([]),
    })
    .optional(),
});

export type BrandBrain = z.infer<typeof brandBrainSchema>;

export const BRAIN_SCHEMA_VERSION = 1 as const;
