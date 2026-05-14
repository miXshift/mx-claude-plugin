/**
 * Write a run sidecar after a skill completes.
 *
 * Inputs come from a skill-supplied JSON payload (passed via
 * `--input-file <path>`), augmented with run-time fields (run_at_utc,
 * run_id, sql_calls hashing). The output path follows the canonical
 * convention:
 *
 *   ~/.mixshift/clients/<brand>/runs/<skill>/<data-date>-<run-id>.json
 *
 * run_id is 6 hex chars (24 bits of randomness). Same-day reruns get
 * different IDs without prompting; the comparator picks the most recent
 * by file mtime.
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveDataDir } from '../paths/resolve.js';
import { sidecarSchema, type Sidecar, type SqlCall } from './schema.js';
import { formatZodError } from '../profile/format-error.js';

/**
 * Skill-supplied input. Most fields map 1:1 to the schema; the
 * differences are:
 *   - `sql_calls` is supplied as {id, params} pairs — we hash params
 *     here (sorted JSON → sha1) so identical params across runs
 *     produce identical hashes.
 *   - `run_at_utc` / `run_id` are computed here if not supplied.
 */
export interface SidecarWriteInput {
  skill: string;
  skill_version: string;
  brand_slug: string;
  run_kind: 'per_account' | 'portfolio';
  data_date: string;
  context_snapshot: Record<string, unknown>;
  sql_calls?: Array<{
    id: string;
    params?: Record<string, unknown>;
    /** Pre-computed hash. If absent, we compute from params. */
    params_hash?: string;
  }>;
  headline_metrics: Record<string, number>;
  verdict: 'GREEN' | 'YELLOW' | 'RED' | 'OBSERVATIONAL';
  artifacts: {
    report_html_path: string;
    report_html_archive_path?: string;
    block_html_path?: string;
  };
  structural_events_active?: string[];
  posture_at_run?: { stance: string; multiplier: number };
  data_lag_pct?: number;
  history_tier?: 'provisional' | 'tier-14' | 'tier-30';
  notes?: string;
  /** Override for tests / re-running with a deterministic ID. */
  run_id?: string;
  run_at_utc?: string;
  dataDirOverride?: string;
}

export interface SidecarWriteResult {
  sidecar_path: string;
  run_id: string;
  data_date: string;
  brand_slug: string;
  skill: string;
}

export async function writeSidecar(
  input: SidecarWriteInput,
): Promise<SidecarWriteResult> {
  const runId = input.run_id ?? generateRunId();
  const runAtUtc = input.run_at_utc ?? new Date().toISOString();
  const sqlCalls = normalizeSqlCalls(input.sql_calls ?? []);

  const candidate: Sidecar = {
    schema_version: 1,
    skill: input.skill,
    skill_version: input.skill_version,
    brand_slug: input.brand_slug,
    run_kind: input.run_kind,
    run_at_utc: runAtUtc,
    data_date: input.data_date,
    run_id: runId,
    context_snapshot: input.context_snapshot,
    sql_calls: sqlCalls,
    headline_metrics: input.headline_metrics,
    verdict: input.verdict,
    artifacts: input.artifacts,
    ...(input.structural_events_active
      ? { structural_events_active: input.structural_events_active }
      : {}),
    ...(input.posture_at_run ? { posture_at_run: input.posture_at_run } : {}),
    ...(input.data_lag_pct !== undefined ? { data_lag_pct: input.data_lag_pct } : {}),
    ...(input.history_tier ? { history_tier: input.history_tier } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  };

  const parsed = sidecarSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(formatZodError(parsed.error, `Sidecar payload is invalid`));
  }

  const path = sidecarPath({
    brand_slug: input.brand_slug,
    skill: input.skill,
    data_date: input.data_date,
    run_id: runId,
    dataDirOverride: input.dataDirOverride,
  });

  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, JSON.stringify(parsed.data, null, 2) + '\n');

  return {
    sidecar_path: path,
    run_id: runId,
    data_date: input.data_date,
    brand_slug: input.brand_slug,
    skill: input.skill,
  };
}

/**
 * Compute the canonical sidecar path. Exposed so callers (compare,
 * etc.) can locate prior runs without duplicating the convention.
 */
export function sidecarPath(args: {
  brand_slug: string;
  skill: string;
  data_date: string;
  run_id: string;
  dataDirOverride?: string;
}): string {
  return join(
    resolveDataDir(args.dataDirOverride),
    'clients',
    args.brand_slug,
    'runs',
    args.skill,
    `${args.data_date}-${args.run_id}.json`,
  );
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function generateRunId(): string {
  return randomBytes(3).toString('hex');
}

function normalizeSqlCalls(
  calls: Array<{
    id: string;
    params?: Record<string, unknown>;
    params_hash?: string;
  }>,
): SqlCall[] {
  return calls.map((c) => ({
    id: c.id,
    params_hash: c.params_hash ?? hashParams(c.params ?? {}),
  }));
}

/**
 * Hash a params object for cross-run identity. Stable across reorderings
 * (keys are sorted before stringification). Uses sha1 → 40 hex chars,
 * which is enough collision resistance for this purpose (drift
 * detection, not crypto).
 */
function hashParams(params: Record<string, unknown>): string {
  const sortedKeys = Object.keys(params).sort();
  const canonical = JSON.stringify(
    sortedKeys.reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = params[k];
      return acc;
    }, {}),
  );
  return createHash('sha1').update(canonical).digest('hex');
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, content, { encoding: 'utf-8' });
  await rename(tmpPath, path);
}
