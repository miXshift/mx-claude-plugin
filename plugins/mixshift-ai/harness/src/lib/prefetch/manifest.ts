/**
 * Load + validate `skills/<skill-id>/skill.manifest.yaml`.
 *
 * The manifest tells the prefetch runner which SQL IDs to execute and
 * how to round/parallelize them. It also declares required context
 * fields, allowed tools, risk tier, etc. — fields skills read directly
 * at runtime.
 *
 * Schema source of truth lives in
 * `plugins/mixshift-ai/shared/skill-manifest.schema.yaml`. This Zod
 * version is the runtime-validation mirror.
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { pluginPath } from './plugin-root.js';
import { formatZodError } from '../profile/format-error.js';
import { calibrationManifestSchema } from '../calibration/manifest-schema.js';

const allowedToolEnum = z.enum([
  'db_read',
  'file_read',
  'file_write',
  'renderer',
  'validator',
  'web_search',
  'prefetch',
]);

const artifactSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    'report_html',
    'context_yaml',
    'narrative_md',
    'json_artifact',
    'block_html',
  ]),
});

const batchRoundSchema = z.object({
  round: z.number().int().positive(),
  parallel: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
});

const preExecutionSchema = z.object({
  enabled: z.boolean(),
  // Default artifact_path uses tokens we substitute at runtime:
  //   {brand_slug}, {skill_id}, {run_date}
  artifact_path: z
    .string()
    .min(1)
    .default('tmp/{brand_slug}-{skill_id}-{run_date}.data.json'),
  batch_plan: z.array(batchRoundSchema).default([]),
});

export const skillManifestSchema = z.object({
  schema_version: z.literal(1),
  skill_id: z.string().min(1),
  display_name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  run_kind: z.enum(['per_account', 'portfolio']),
  cadence: z.enum(['daily', 'weekly', 'monthly', 'on_demand']),
  risk_tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  allowed_tools: z.array(allowedToolEnum).default([]),
  side_effect_policy: z.enum([
    'none',
    'artifact_write',
    'context_write',
    'recommendation_only',
  ]),
  review_required: z.enum(['never', 'on_non_green', 'always']),
  sql_ids: z.array(z.string()).default([]),
  pre_execution: preExecutionSchema.optional(),
  required_context_fields: z.array(z.string()).default([]),
  optional_context_fields: z.array(z.string()).default([]),
  artifacts: z.array(artifactSchema).default([]),
  verdict_range: z
    .array(z.enum(['GREEN', 'YELLOW', 'RED', 'OBSERVATIONAL']))
    .default([]),
  pricing_tier: z.enum(['free', 'pro', 'enterprise']),
  trigger_phrases: z.array(z.string()).optional(),
  upstream_skills: z.array(z.string()).optional(),
  escalation_conditions: z.array(z.string()).optional(),
  notes: z.string().optional(),
  // OCL — Objective Level Configuration. When present, the harness shows a
  // confirm-on-run flow with these fields before invoking the skill. Skills
  // without a calibration block skip the confirm flow entirely. See
  // lib/calibration/manifest-schema.ts for field types + authoring guide.
  calibration: calibrationManifestSchema.optional(),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type BatchRound = z.infer<typeof batchRoundSchema>;

/**
 * Load + validate a skill manifest by skill ID. Looks at
 * `skills/<skill-id>/skill.manifest.yaml` under the plugin root.
 */
export async function loadSkillManifest(skillId: string): Promise<SkillManifest> {
  const path = pluginPath('skills', skillId, 'skill.manifest.yaml');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      throw new Error(
        `Skill manifest not found at ${path}. ` +
          `Known skill IDs are subdirectories under skills/. ` +
          `Check the skill name and try again.`,
      );
    }
    throw err;
  }
  const parsed = parseYaml(raw);
  const result = skillManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      formatZodError(
        result.error,
        `Skill manifest at ${path} failed schema validation`,
      ),
    );
  }
  return result.data;
}

/**
 * Flatten the manifest's batch_plan into a list of rounds. If the
 * manifest has no pre_execution.batch_plan but does have sql_ids, we
 * fabricate a single-round plan that runs all sql_ids in parallel.
 *
 * Returns rounds in execution order. Each round contains the SQL IDs
 * to run in parallel within that round.
 */
export function resolveBatchPlan(manifest: SkillManifest): BatchRound[] {
  const plan = manifest.pre_execution?.batch_plan ?? [];
  if (plan.length > 0) {
    return [...plan].sort((a, b) => a.round - b.round);
  }
  if (manifest.sql_ids.length === 0) {
    return [];
  }
  return [
    { round: 1, parallel: [...manifest.sql_ids], notes: 'Default single-round plan' },
  ];
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
