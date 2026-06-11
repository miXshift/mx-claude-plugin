/**
 * Brand Brain contract (Tier 2): the versioned document every consumer
 * reads, regardless of transport.
 *
 * Today the document lives at ~/.mixshift/clients/<slug>/brand-brain.yaml,
 * assembled client-side by lib/brain/fetch.ts. At P2 the same document is
 * served by a MixShift endpoint (GET /api/brain/:brand) assembled
 * server-side. Skills never read the file directly; they go through
 * lib/brain/read.ts, so the transport swap never touches skill code.
 * Strategy: internal/BRAND-BRAIN-STRATEGY.md (main checkout).
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
 * fields per internal/BACKGROUND-DISCOVERY.md; everything nullable
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
export const brainCatalogSchema = z.object({
  /** Distinct ASINs across SC + VC rows. */
  asin_count: z.number().int().min(0),
  /** Distinct SC SKUs (VC has no SKU grain). Null when no SC source ran. */
  sku_count: z.number().int().min(0).nullable(),
  sub_brands: z.array(z.string()),
  item_groups: z.array(z.string()),
  /** Hero-ASIN ranking needs SP-MIGRATION Phase 2 activity pulls. */
  hero_asins_deferred: z.literal(true),
});

export type BrainCatalog = z.infer<typeof brainCatalogSchema>;

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
  /** % of campaigns on smart/default bid optimization. Derivation
   *  assumption (BidOptimization value semantics) is flagged in the SP
   *  draft; verify against real warehouse values. */
  smart_default_adoption_pct: z.number().min(0).max(100).nullable(),
  /** % of campaigns carrying a BrandEntityId. */
  brand_entity_id_presence_pct: z.number().min(0).max(100).nullable(),
});

export type BrainCampaignStructure = z.infer<typeof brainCampaignStructureSchema>;

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
  }),
  seller: brainSellerSchema.optional(),
  /** Present when at least one catalog source (SC or VC) fetched ok. */
  catalog: brainCatalogSchema.optional(),
  /** Present when the campaign source fetched ok. */
  campaign_structure: brainCampaignStructureSchema.optional(),
  /** S3 skill observations, keyed by dotted field path
   *  (e.g. "buy_box_health.chronic_losers"). */
  observations: z.record(z.string(), brainObservationAggregateSchema).default({}),
});

export type BrandBrain = z.infer<typeof brandBrainSchema>;

export const BRAIN_SCHEMA_VERSION = 1 as const;
