/**
 * Zod schema for ~/.mixshift/clients/<brand>/context.yaml.
 *
 * Single source of truth for what skills can rely on. Mirrors the YAML
 * schema at plugins/mixshift-amazon-ppc/shared/clients/_schema/
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
  attribution_window_days: z.number().int().positive(),
  tacos_target_pct: z.number().positive().optional(),
  tacos_goal_pct: z.number().positive().optional(),
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

// Skill overlay map (from BRAND-MANAGEMENT.md v0.3). Permissive: each skill's
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
  // TACOS-primary accounts must define a TACOS target/goal (per the YAML
  // schema's management note). Enforce as a refinement.
  .refine(
    (ctx) => {
      if (ctx.management.primary_metric !== 'TACOS') return true;
      return (
        ctx.management.tacos_target_pct !== undefined ||
        ctx.management.tacos_goal_pct !== undefined
      );
    },
    {
      message:
        'TACOS-primary accounts must define management.tacos_target_pct or management.tacos_goal_pct',
      path: ['management'],
    },
  );

export type BrandContext = z.infer<typeof contextSchema>;

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
