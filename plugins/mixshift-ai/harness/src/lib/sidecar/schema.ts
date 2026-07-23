/**
 * Zod schema for run sidecar JSONs.
 *
 * Canonical YAML source lives at
 * `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`. This module is
 * the runtime-validation mirror.
 *
 * Sidecars are append-only artifacts written by skills at the end of
 * each run. They capture:
 *   - Which library queries fired (id + params hash for cross-run identity)
 *   - The subset of context.yaml the skill actually consumed
 *   - Headline metrics (numbers downstream runs compare against)
 *   - A verdict (GREEN | YELLOW | RED | OBSERVATIONAL)
 *
 * Stable enough for current and prior sidecars to be inspected together for
 * config edits, dropped queries, metric jumps, and verdict regressions.
 */

import { z } from 'zod';

const verdictSchema = z.enum(['GREEN', 'YELLOW', 'RED', 'OBSERVATIONAL']);
const runKindSchema = z.enum(['per_account', 'portfolio']);

// Each entry in sql_calls is canonical {id, params_hash}. params_hash is
// computed by the sidecar writer from the params used at runtime — the
// callers send the raw params, we hash here.
const sqlCallSchema = z.object({
  id: z.string().min(1),
  params_hash: z.string().min(1),
});

const artifactsSchema = z.object({
  report_html_path: z.string().min(1),
  report_html_archive_path: z.string().optional(),
  block_html_path: z.string().optional(),
});

const postureSchema = z.object({
  stance: z.string().min(1),
  multiplier: z.number(),
});

// context_snapshot validation depends on run_kind. The base shape
// permits arbitrary keys (since skills choose what they actually
// consumed); we add per-kind required checks via .refine on the
// top-level sidecar schema below.
const contextSnapshotSchema = z.record(z.string(), z.unknown());

export const sidecarSchema = z
  .object({
    schema_version: z.literal(1),
    skill: z.string().min(1),
    skill_version: z.string().min(1),
    brand_slug: z.string().min(1),
    run_kind: runKindSchema,
    run_at_utc: z.iso.datetime(),
    data_date: z.iso.date(),
    run_id: z.string().regex(/^[0-9a-f]{6}$/i, 'run_id must be 6 lowercase hex chars'),
    context_snapshot: contextSnapshotSchema,
    sql_calls: z.array(sqlCallSchema).default([]),
    headline_metrics: z.record(z.string(), z.number()),
    verdict: verdictSchema,
    artifacts: artifactsSchema,
    // Optional fields
    structural_events_active: z.array(z.string()).optional(),
    posture_at_run: postureSchema.optional(),
    data_lag_pct: z.number().optional(),
    history_tier: z.enum(['provisional', 'tier-14', 'tier-30']).optional(),
    notes: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.run_kind === 'per_account') {
      const required = [
        'account_type',
        'seller_id',
        'primary_metric',
        'acos_target_pct',
        'attribution_window_days',
      ] as const;
      for (const key of required) {
        if (s.context_snapshot[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['context_snapshot', key],
            message:
              `Sidecar with run_kind=per_account must include ` +
              `context_snapshot.${key}. The skill should snapshot every ` +
              `context.yaml field it consumed.`,
          });
        }
      }
    } else if (s.run_kind === 'portfolio') {
      const required = ['portfolio_account_count', 'portfolio_config_path'] as const;
      for (const key of required) {
        if (s.context_snapshot[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['context_snapshot', key],
            message:
              `Sidecar with run_kind=portfolio must include ` +
              `context_snapshot.${key}.`,
          });
        }
      }
    }
  });

export type Sidecar = z.infer<typeof sidecarSchema>;
export type SqlCall = z.infer<typeof sqlCallSchema>;
