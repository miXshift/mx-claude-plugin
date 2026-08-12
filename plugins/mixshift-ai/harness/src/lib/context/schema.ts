/**
 * Zod schema for ~/.mixshift/clients/<brand>/context.yaml.
 *
 * Single source of truth for what skills can rely on. Mirrors the YAML
 * schema at plugins/mixshift-ai/shared/clients/_schema/
 * context.schema.yaml — the YAML version is canonical for documentation
 * and SKILL.md references, this Zod version is canonical for runtime
 * validation. A drift test (see schema.test.ts) asserts both versions
 * agree on required top-level fields.
 *
 * Schema policy:
 *   - Required fields fail closed (missing → validation error)
 *   - Optional fields are permissive (extra unknowns allowed at top level
 *     so users can store custom annotations, but typed where present)
 *   - To add a required field: update this file, update the YAML schema,
 *     update the template (shared/clients/_template/context.yaml), and
 *     backfill any existing brand contexts. Bump schema_version if
 *     the change is breaking.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------
// Sub-shapes
// -----------------------------------------------------------------------

const accountSchema = z.object({
  seller_id: z.number().int().positive(),
  seller_name: z.string().min(1),
  account_type: z.enum(['SC', 'VC']),
  status: z.enum(['active', 'wind_down', 'inactive']),
  role: z.enum(['primary', 'legacy', 'secondary']),
  amazon_seller_id: z.string().optional(),
  marketplace: z.string().optional(),
  merchant_type: z.enum(['seller', 'vendor']).optional(),
  // MerchantAlias from the warehouse seller table — the Amazon storefront
  // label. Preserved here for reference; not used by grouping (Name is
  // canonical, see brand-grouping.ts). User shouldn't edit this manually.
  merchant_alias: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  ads_active: z.boolean().optional(),
  retail_active: z.boolean().optional(),
});

const sourcesSchema = z.object({
  ad_metrics: z.string().min(1),
  ops_revenue: z.string().min(1),
  ops_revenue_field: z.string().min(1),
  ops_units_field: z.string().min(1),
  ops_date_field: z.string().min(1),
});

const managementSchema = z.object({
  primary_metric: z.enum(['ACOS', 'TACOS']),
  acos_target_pct: z.number().positive(),
  // Provenance of acos_target_pct: 'warehouse' = derived from the account's
  // own data at bootstrap; 'default' = the bootstrap fallback nobody has
  // confirmed; 'user' = explicitly set by the user (the context editor stamps
  // this when management.acos_target_pct is edited). Optional so pre-existing
  // customer context.yaml files keep validating. ABSENT = written before
  // provenance existed: consumers must surface the value for confirmation
  // ("unverified") but must NOT downgrade behavior, because a pre-provenance
  // file may hold a genuinely user-set target.
  acos_target_source: z.enum(['warehouse', 'default', 'user']).optional(),
  attribution_window_days: z.number().int().positive(),
  // Canonical field for the TACOS-primary account-level goal.
  tacos_goal_pct: z.number().positive().optional(),
  // DEPRECATED ALIAS for tacos_goal_pct, kept only so existing customer
  // context.yaml files keep validating. normalizeLegacyTacosFields() (called
  // from lib/context/load.ts before this schema runs) maps this onto
  // tacos_goal_pct on read, so by the time a context reaches skill code only
  // tacos_goal_pct is populated. Do not write new fields against this key.
  tacos_target_pct: z.number().positive().optional(),
  tacos_in_bottom_line: z.boolean().optional(),
  implied_tacos_pct: z.number().positive().optional(),
  tacos_reference_line: z.string().optional(),
});

const postureSchema = z.object({
  stance: z.enum(['scale', 'efficiency', 'defend', 'clear_bleed']),
  multiplier: z.number().min(0).max(1),
});

const bidHealthSchema = z.object({
  scale_threshold_pct: z.number().positive(),
  pullback_threshold_pct: z.number().positive(),
});

const goalsSchema = z.object({
  monthly_total_sales_target: z.number().nonnegative().optional(),
  quarterly_total_sales_target: z.number().nonnegative().optional(),
  tacos_goal_pct: z.number().positive().optional(),
});

// Mirrors the server stake category enum (mx-legacy-auth migration 018) MINUS
// the three server-side kinds (content_change / strategy_change /
// platform_external are minted by server write seams, not curated here), so
// every local type maps 1:1 onto a server category when events sync to the
// brand timeline. #37499 additions: off_amazon_media (a STANDING off-Amazon
// media condition — outside demand gen, MMM attribution, non-Amazon ad
// lines), assortment_change (products rotating in/out of the catalog as
// expected behavior — seasonal flavors, planned discontinuations), and
// `other` (the explicit escape: record what the user said, under a specific
// `kind`, instead of forcing a wrong type).
export const STRUCTURAL_EVENT_TYPES = [
  'brand_migration',
  'media_spike',
  'media_spike_recurring',
  'portfolio_decision',
  'promotional_window',
  'promotional_window_recurring',
  'stockout',
  'price_test',
  'launch',
  'off_amazon_media',
  'assortment_change',
  'other',
] as const;

/**
 * Kind slugs the SERVER reserves for its own machine-attested audit events
 * (mx-legacy-auth routes/timeline.ts RESERVED_KINDS, minus the knowledge
 * family). A curated event syncs as `structural.<kind>`, so a local kind of
 * `content_change` would collide with the guarded listings-write provenance
 * kind and be rejected 400 reserved_kind forever. Rejected at authoring time
 * so the user gets a clear message instead of a permanently failing sync.
 * Safe as a hard schema rule: `kind` is new in this release, so no existing
 * context.yaml can carry one.
 */
export const RESERVED_EVENT_KINDS = ['content_change', 'ads_change', 'corroboration'] as const;

/**
 * FORWARD TOLERANCE (#37499 review): `type` accepts a KNOWN value or any
 * lowercase slug. The 12 known values stay the documented, recommended set
 * (and the ones consumers key on), but an unrecognized slug must not hard-fail
 * the whole brand for every skill — that is exactly what a stricter enum did
 * to 0.8.7 clients when this release added three values, and context.yaml
 * travels between machines through the org store. An unknown type still syncs
 * losslessly: stake-sync maps it to the server's `other` category carrying the
 * original slug as `kind` (see lib/timeline/stake-sync.ts).
 */
const structuralEventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'type must be a lowercase snake_case slug')
  .max(64);

const structuralEventSchema = z
  .object({
    id: z.string().min(1),
    type: structuralEventTypeSchema,
    // Freeform idiom axis mirroring the server timeline's `kind` (there it
    // syncs as `structural.<kind>`): what THIS event specifically is, in the
    // team's own words, when the fixed type is broader than the event.
    // REQUIRED when type is 'other' (see the refine below).
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, 'kind must be a lowercase snake_case slug')
      .max(64)
      .refine((k) => !(RESERVED_EVENT_KINDS as readonly string[]).includes(k), {
        message: `kind cannot be one of ${RESERVED_EVENT_KINDS.join(', ')} (the timeline reserves those for MixShift's own audited write records). Pick a more specific slug, e.g. manual_content_change.`,
      })
      .optional(),
    // Freeform team-idiom tags; sync to the timeline stake's tags[] axis.
    tags: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,63}$/,
            'tags must be lowercase slugs (a-z, 0-9, -, _; max 64 chars)',
          ),
      )
      .max(16)
      .optional(),
    affects: z.array(z.unknown()).default([]),
    interpretation: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    active_through: z.string().optional(),
  })
  // `other` must not lose the specificity the fixed enum could not hold —
  // that is the whole point of the escape (#37499).
  .refine((e) => e.type !== 'other' || (e.kind !== undefined && e.kind.length > 0), {
    message: "a structural event of type 'other' requires a kind (what the event is, as a lowercase snake_case slug)",
    path: ['kind'],
  });

/** One curated Tier-3 structural event (the stake-sync input shape). */
export type StructuralEvent = z.infer<typeof structuralEventSchema>;

const campaignStructureSchema = z.object({
  naming_pattern: z.string().min(1),
  account_codes: z.array(z.string()).default([]),
  objectives: z.array(z.string()).optional(),
});

const negationSchema = z.object({
  protected_terms: z.array(z.string()).default([]),
  lane_rules: z.record(z.string(), z.unknown()).default({}),
  competitor_brands: z.array(z.string()).optional(),
  asin_negation: z.unknown().optional(),
});

const subBrandSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  item_groups: z.array(z.string()).optional(),
});

// -----------------------------------------------------------------------
// Sub-brand binding (mx-ops#6 P1; docs/subbrand-architecture.md §2.1-2.3)
// -----------------------------------------------------------------------
//
// Identifies a brand as a LABEL-SCOPED sub-brand of an agency's Amazon
// seller account (D-023: identifier-only, no stored account entity). Every
// field is optional so the block itself is additive and a partially-filled
// binding (e.g. discovered but not yet fully confirmed) still validates.
//
// Known label source columns, documented for humans reading context.yaml.
// Deliberately NOT a closed enum on the schema below — see the comment on
// bindingLabelSourceSchema for why.
export const KNOWN_RETAIL_LABEL_SOURCES = [
  'mws_items.Brand',
  'vendor_items.CustomBrand',
] as const;
export const KNOWN_ADS_LABEL_SOURCE = 'campaign.Brand';

/**
 * FORWARD TOLERANCE, same lesson as `structural_events[].type` (#37499
 * review, see structuralEventTypeSchema above): a fixed enum of label
 * source columns would hard-fail an OLDER client the instant the design
 * adds a new source (a future retail-side table, a second ads table). The
 * two known values are documented above for humans; the schema itself only
 * requires a non-empty short string so a client that has never heard of a
 * newer source still loads the brand instead of failing the whole context.
 */
const bindingLabelSourceSchema = z.string().min(1).max(128);

const bindingLabelSchema = z.object({
  source: bindingLabelSourceSchema,
  value: z.string().min(1),
});

/**
 * `binding.kind` is a lowercase snake_case slug, not a fixed enum — the
 * same forward-tolerance treatment as `structural_events[].type`. 'sub_brand'
 * is the only kind minted by P1; a later design could add another kind
 * (e.g. a joint-venture binding) without breaking a client built against
 * this release.
 */
const bindingKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'binding.kind must be a lowercase snake_case slug')
  .max(64);

const bindingSchema = z.object({
  kind: bindingKindSchema.optional(),
  amazon_seller_id: z.string().min(1).optional(),
  seller_ids: z.array(z.number().int()).optional(),
  retail_label: bindingLabelSchema.optional(),
  ads_label: bindingLabelSchema.optional(),
  // Plain-language note, MODEL-VISIBLE on ANY plugin version (design doc
  // §11 "old clients are the residual smearing hazard"): an install that
  // predates this schema cannot read `binding` at all, but an LLM-driven
  // skill run still reads context.yaml's prose. This field exists so even
  // that old-client path carries a human sentence saying the brand is
  // label-scoped and account-wide fetches must not be attributed to it.
  scope_note: z.string().max(2000).optional(),
});

/** A sub-brand's binding to its parent Amazon seller account and label. */
export type BindingBlock = z.infer<typeof bindingSchema>;

const captureRateCalibrationSchema = z.object({
  enabled: z.boolean(),
  capture_rate_pct: z.number().optional(),
  fresh_day_acos_improvement_pts: z.number().optional(),
  settlement_application_rule: z.string().optional(),
  daily_settlement_curve: z.unknown().optional(),
  last_calibrated: z.string().optional(),
  stability_score: z.enum(['high', 'medium', 'low']).optional(),
});

// Skill overlay map (skill-shaping overlay design). Permissive: each skill's
// configurable_fields define its own validation; here we just accept arbitrary
// objects keyed by skill_id.
const skillConfigSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()),
);

// -----------------------------------------------------------------------
// Top-level
// -----------------------------------------------------------------------

export const contextSchema = z
  .object({
    // Required
    schema_version: z.literal(1),
    brand_slug: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'brand_slug must be lowercase, start with a letter, and contain only letters / digits / hyphens',
      ),
    brand_name: z.string().min(1),
    last_updated: z.iso.date(),
    accounts: z.array(accountSchema).min(1, 'At least one account is required'),
    sources: sourcesSchema,
    management: managementSchema,

    // Optional
    capture_rate_calibration: captureRateCalibrationSchema.optional(),
    sub_brands: z.array(subBrandSchema).optional(),
    brand_terms: z.unknown().optional(),
    // DEPRECATED (Phase 5 — Brand Context pivot): bid_health.* are single-skill
    // scalar knobs whose canonical home is now KBH's OCL (config.yaml). Run
    // `mixshift brand migrate-config <slug>` to copy them across. Kept
    // `.optional()` + still resolvable as a seed (and runaway's pullback seed)
    // for back-compat; a future release drops it. No schema_version bump —
    // the field moved, the envelope is unchanged. See lib/migrations/config-migrations.ts.
    bid_health: bidHealthSchema.optional(),
    goals: goalsSchema.optional(),
    active_watch: z.unknown().optional(),
    structural_events: z.array(structuralEventSchema).optional(),
    objective_calibration: z.unknown().optional(),
    delivery: z.unknown().optional(),
    open_gaps: z.array(z.unknown()).optional(),
    posture: postureSchema.optional(),
    paused_campaigns: z.array(z.string()).optional(),
    campaign_structure: campaignStructureSchema.optional(),
    attribution_rule: z.unknown().optional(),
    negation: negationSchema.optional(),
    reporting: z.unknown().optional(),
    thresholds: z.record(z.string(), z.unknown()).optional(),
    detected_anomalies: z.unknown().optional(),
    skill_config: skillConfigSchema.optional(),
    // Sub-brand binding (mx-ops#6 P1). Additive + fully optional; absent on
    // every normal brand and on every context.yaml written before this field
    // existed. See the binding schema block above for the forward-tolerance
    // rationale on kind and the label sources.
    binding: bindingSchema.optional(),
  })
  // TACOS-primary accounts must define a TACOS goal (per the YAML schema's
  // management note). Enforce as a refinement. tacos_target_pct is the
  // deprecated alias; normalizeLegacyTacosFields() maps it onto
  // tacos_goal_pct before this schema runs, but the OR-check is kept here
  // too so the refinement stays correct if this schema is ever invoked
  // directly against un-normalized input (e.g. from a future caller).
  .refine(
    (ctx) => {
      if (ctx.management.primary_metric !== 'TACOS') return true;
      return (
        ctx.management.tacos_goal_pct !== undefined ||
        ctx.management.tacos_target_pct !== undefined
      );
    },
    {
      message:
        'TACOS-primary accounts must define management.tacos_goal_pct (or the deprecated alias management.tacos_target_pct)',
      path: ['management'],
    },
  );

export type BrandContext = z.infer<typeof contextSchema>;

/**
 * Normalize the deprecated `management.tacos_target_pct` alias onto the
 * canonical `management.tacos_goal_pct` field.
 *
 * Existing customer context.yaml files may still use tacos_target_pct (the
 * pre-consolidation field name). Rather than force a migration, the loader
 * calls this on the raw parsed YAML before Zod validation, so:
 *   - callers downstream of load.ts only ever see tacos_goal_pct populated
 *   - tacos_target_pct stays accepted for parsing/back-compat, but never
 *     becomes the field skills branch on
 *
 * If both fields are present, tacos_goal_pct (canonical) wins and
 * tacos_target_pct is dropped rather than overwritten. Mutates nothing —
 * returns a new object (or the same reference when there's nothing to do).
 */
export function normalizeLegacyTacosFields(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const management = obj.management;
  if (
    management === null ||
    typeof management !== 'object' ||
    Array.isArray(management)
  ) {
    return raw;
  }
  const mgmt = management as Record<string, unknown>;
  if (mgmt.tacos_target_pct === undefined) return raw;

  const normalizedMgmt = { ...mgmt };
  if (normalizedMgmt.tacos_goal_pct === undefined) {
    normalizedMgmt.tacos_goal_pct = normalizedMgmt.tacos_target_pct;
  }
  delete normalizedMgmt.tacos_target_pct;

  return { ...obj, management: normalizedMgmt };
}

/**
 * The required top-level field names — used by the drift test to assert
 * this Zod schema is in sync with the canonical YAML schema.
 */
export const REQUIRED_TOP_LEVEL_FIELDS = [
  'schema_version',
  'brand_slug',
  'brand_name',
  'last_updated',
  'accounts',
  'sources',
  'management',
] as const;
