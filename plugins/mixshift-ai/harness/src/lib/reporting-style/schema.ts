/**
 * Zod schema for per-brand reporting-style.yaml.
 *
 * Lives at `~/.mixshift/clients/<brand-slug>/reporting-style.yaml`. Optional
 * file. Produced by account-cold-start Phase 2 sub-step (Reporting Style
 * Intake) when the AM uploads a reference monthly report. Consumed by
 * monthly-performance-report to match the brand's house style.
 *
 * When this file is absent, MPR uses canonical defaults.
 *
 * Schema source-of-truth in YAML form:
 *   `shared/clients/_schema/reporting-style.schema.yaml`
 *
 * Schema policy:
 *   - Required: schema_version, brand_slug, last_updated, sections
 *   - Optional: source, variants, voice_notes, emphasis, omit
 *   - Permissive: unknown top-level keys are preserved (so AMs can add
 *     brand-specific annotations without schema churn)
 */

import { z } from 'zod';

// -----------------------------------------------------------------------
// Sub-shapes
// -----------------------------------------------------------------------

const sourceSchema = z.object({
  type: z.enum(['cold_start_inference', 'manual_edit']).optional(),
  reference_artifact: z.string().nullable().optional(),
  notes: z.string().optional(),
});

const variantsSchema = z.object({
  metrics_table: z.enum(['split', 'unified']).optional(),
  forecast_presentation: z
    .enum(['anchor_cards_plus_table', 'inline_metric_row', 'forward_projection_table', 'none'])
    .optional(),
  item_group: z.enum(['table_only', 'table_plus_deep_dives']).optional(),
});

const emphasisSchema = z.object({
  primary_metric: z.enum(['ACOS', 'TACOS']).optional(),
  feature_sub_brands: z.array(z.string()).optional(),
  forecast_lead: z.enum(['ahead', 'behind', 'neutral']).optional(),
  brand_specific_framings: z.array(z.string()).optional(),
});

// -----------------------------------------------------------------------
// Top-level
// -----------------------------------------------------------------------

export const reportingStyleSchema = z
  .object({
    schema_version: z.literal(1),
    brand_slug: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'brand_slug must be lowercase'),
    last_updated: z.iso.date(),
    sections: z.array(z.string().min(1)).min(1, 'At least one section required'),

    source: sourceSchema.optional(),
    variants: variantsSchema.optional(),
    voice_notes: z.string().optional(),
    emphasis: emphasisSchema.optional(),
    omit: z.array(z.string()).optional(),
  })
  // Tolerant: unknown top-level keys are preserved by the YAML lib but
  // not validated. AMs may add brand-specific annotations.
  .passthrough();

export type ReportingStyle = z.infer<typeof reportingStyleSchema>;

export const REQUIRED_TOP_LEVEL_FIELDS = [
  'schema_version',
  'brand_slug',
  'last_updated',
  'sections',
] as const;
