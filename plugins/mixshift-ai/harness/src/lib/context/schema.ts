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

const structuralEventTypes = [
  'brand_migration',
  'media_spike',
  'media_spike_recurring',
  'portfolio_decision',
  'promotional_window',
  'promotional_window_recurring',
  'stockout',
  'price_test',
  'launch',
] as const;

const structuralEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(structuralEventTypes),
  affects: z.array(z.unknown()).default([]),
  interpretation: z.string().min(1),
  start: z.string().optional(),
  end: z.string().optional(),
  active_through: z.string().optional(),
});

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
