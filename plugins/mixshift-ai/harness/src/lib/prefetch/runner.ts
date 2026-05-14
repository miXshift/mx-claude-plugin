/**
 * Orchestrate `mixshift prefetch <brand> <skill>`:
 *
 *   1. Load the skill manifest + brand context.
 *   2. Resolve the batch plan (rounds of SQL IDs to run in parallel).
 *   3. Compute the standard param map.
 *   4. For each round, run every SQL in parallel (Promise.all):
 *        - Read the SQL body from the library
 *        - Substitute list params (CSV-inline) + leave scalars as :name
 *        - Execute via runQuery() in namedPlaceholders mode
 *   5. Write artifacts (data.json + data.md) under
 *      ~/.mixshift/clients/<brand>/runs/<skill>/<date>/.
 *
 * Per-query failures don't abort the whole run — we capture the
 * failure shape in the output so the skill can decide how to react
 * (e.g., a missing-table error from one query shouldn't sink an entire
 * daily-health-check run). The runner returns a per-query result list
 * with `ok: true | false` so callers can branch.
 */

import { loadSkillManifest, resolveBatchPlan } from './manifest.js';
import { loadBrandContext } from '../context/load.js';
import { buildStandardParams } from './params.js';
import { readQuerySql } from './sql-library.js';
import { substituteParams, findReferencedParams } from './substitute.js';
import { runQuery, type DataQueryResult } from '../data/query-runner.js';
import { writePrefetchArtifacts, type QueryRunOutput } from './artifacts.js';

export interface PrefetchOptions {
  brand: string;
  skill: string;
  runDate: string; // YYYY-MM-DD
  /** Override `~/.mixshift/` (tests). */
  dataDirOverride?: string;
  /** Override standard params (per-skill tunables, e.g. lookback_days). */
  paramOverrides?: Record<string, unknown>;
}

export interface PrefetchQueryResult {
  id: string;
  status: 'ok' | 'failed' | 'missing_params';
  rowCount?: number;
  durationMs?: number;
  /** Friendly error message on failure / missing-params. */
  error?: string;
}

export interface PrefetchResult {
  brand_slug: string;
  skill_id: string;
  run_date: string;
  artifact_paths: {
    run_dir: string;
    data_json_path: string;
    data_md_path: string;
  };
  queries: PrefetchQueryResult[];
  total_duration_ms: number;
  /** True when at least one query failed. The skill decides how to react. */
  partial_failure: boolean;
}

export async function runPrefetch(opts: PrefetchOptions): Promise<PrefetchResult> {
  const t0 = Date.now();
  const manifest = await loadSkillManifest(opts.skill);
  const { context } = await loadBrandContext(opts.brand, opts.dataDirOverride);

  const params = buildStandardParams({
    context,
    runDate: opts.runDate,
    paramOverrides: opts.paramOverrides,
  });

  const rounds = resolveBatchPlan(manifest);
  const queryOutputs: QueryRunOutput[] = [];
  const perQueryResults: PrefetchQueryResult[] = [];

  for (const round of rounds) {
    const settled = await Promise.all(
      round.parallel.map((id) =>
        executeOne(id, params, opts.dataDirOverride).catch((err) => ({
          id,
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        })),
      ),
    );

    for (const r of settled) {
      if ('ok' in r && r.ok) {
        queryOutputs.push(r.output);
        perQueryResults.push({
          id: r.output.id,
          status: 'ok',
          rowCount: r.output.rows.length,
          durationMs: r.output.duration_ms,
        });
      } else if ('ok' in r && !r.ok && 'queryResult' in r) {
        // mysql / query failure with classified info
        perQueryResults.push({
          id: r.id,
          status: 'failed',
          error: r.queryResult.friendly,
        });
      } else if ('error' in r) {
        // Param-substitution / setup failure
        perQueryResults.push({
          id: r.id,
          status: r.error.includes('missing param') ? 'missing_params' : 'failed',
          error: r.error,
        });
      }
    }
  }

  const artifact_paths = await writePrefetchArtifacts({
    brand_slug: context.brand_slug,
    skill_id: manifest.skill_id,
    run_date: opts.runDate,
    query_outputs: queryOutputs,
    meta: {
      skill_version: manifest.version,
      schema_version: manifest.schema_version,
      run_kind: manifest.run_kind,
      account_count: context.accounts.length,
      primary_metric: context.management.primary_metric,
    },
    dataDirOverride: opts.dataDirOverride,
  });

  const partial_failure = perQueryResults.some((r) => r.status !== 'ok');

  return {
    brand_slug: context.brand_slug,
    skill_id: manifest.skill_id,
    run_date: opts.runDate,
    artifact_paths,
    queries: perQueryResults,
    total_duration_ms: Date.now() - t0,
    partial_failure,
  };
}

// -----------------------------------------------------------------------
// Per-query execution helper
// -----------------------------------------------------------------------

type ExecuteResult =
  | { id: string; ok: true; output: QueryRunOutput }
  | { id: string; ok: false; queryResult: DataQueryResult<Record<string, unknown>> & { ok: false } };

async function executeOne(
  id: string,
  allParams: Record<string, unknown>,
  dataDirOverride?: string,
): Promise<ExecuteResult> {
  const { sql: rawSql } = await readQuerySql(id);

  // Validate: every param referenced in the SQL must be defined (after
  // substitution + scalar fallback). We do this BEFORE running so the
  // skill gets a clean error rather than a mysql "missing key" complaint.
  const referenced = findReferencedParams(rawSql);
  const missing = referenced.filter((p) => !(p in allParams));
  if (missing.length > 0) {
    throw new Error(
      `Query ${id} references missing param(s): ${missing.join(', ')}. ` +
        `Either the brand context is incomplete (re-check context.yaml) ` +
        `or the skill needs paramOverrides for these values.`,
    );
  }

  const { sql, params } = substituteParams(rawSql, allParams);

  const result = await runQuery<Record<string, unknown>>(sql, params, {
    dataDirOverride,
  });

  if (!result.ok) {
    return { id, ok: false, queryResult: result };
  }

  return {
    id,
    ok: true,
    output: {
      id,
      rows: result.rows,
      duration_ms: result.durationMs,
      params,
      display_sql: sql,
    },
  };
}
