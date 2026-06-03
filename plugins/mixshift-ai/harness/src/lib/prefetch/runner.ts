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
 * mx-daily-health-check run). The runner returns a per-query result list
 * with `ok: true | false` so callers can branch.
 */

import { loadSkillManifest, resolveBatchPlan } from './manifest.js';
import { loadBrandContext } from '../context/load.js';
import { buildStandardParams } from './params.js';
import { readQuerySql } from './sql-library.js';
import { substituteParams, findReferencedParams } from './substitute.js';
import { runQuery, type DataQueryResult } from '../data/query-runner.js';
import { writePrefetchArtifacts, type QueryRunOutput } from './artifacts.js';
import { track, EventName } from '../telemetry/index.js';

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
  /**
   * Status:
   *   - ok:        query ran, rows captured
   *   - failed:    query ran but errored (SQL syntax, access denied, etc.)
   *   - deferred:  query references params the runner couldn't fill (e.g.
   *                cross-query dependencies like ANEG-04's :window_asin_set
   *                that comes from ANEG-02's output, or conditional params
   *                like LIB-PT-01's price-test windows). The skill model
   *                is expected to provide these via paramOverrides on a
   *                follow-up prefetch, or run the query inline via
   *                `mixshift data query`.
   *   - failed:    everything else (real errors).
   */
  status: 'ok' | 'failed' | 'deferred';
  rowCount?: number;
  durationMs?: number;
  /** Names of missing params (deferred status only). */
  missing_params?: string[];
  /** Friendly error message on failure / deferred. */
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
  /**
   * True when at least one query ACTUALLY failed (status='failed').
   * Queries with status='deferred' do NOT set this — deferred is an
   * expected outcome for cross-query-dependent SQL.
   */
  partial_failure: boolean;
  /** True when at least one query was deferred (skill must handle it). */
  has_deferred: boolean;
}

export async function runPrefetch(opts: PrefetchOptions): Promise<PrefetchResult> {
  const t0 = Date.now();
  const manifest = await loadSkillManifest(opts.skill);
  const { context } = await loadBrandContext(opts.brand, opts.dataDirOverride);

  await track(
    {
      event_name: EventName.PrefetchStarted,
      skill_id: opts.skill,
      payload: { brand: opts.brand, run_date: opts.runDate, sql_ids: manifest.sql_ids },
    },
    opts.dataDirOverride,
  );

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
        executeOne(id, params, opts.dataDirOverride).catch((err) => {
          // Carry missing_params through so the classifier below can flag
          // this as `deferred` instead of `failed`.
          if (err instanceof MissingParamsError) {
            return {
              id,
              ok: false as const,
              error: err.message,
              missing_params: err.missing_params,
            };
          }
          return {
            id,
            ok: false as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }),
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
        // Param-substitution / setup failure. Missing-params errors are
        // common for queries that depend on the output of another query
        // (ANEG-04 needs ANEG-02's ASIN set; STDP-04..07 need STDP-03's
        // search-term list; LIB-PT-01 needs structural_events.price_test
        // dates). These are *deferred*, not failed — the skill model is
        // expected to supply the params via paramOverrides on a follow-up
        // call (or run the query inline via `mixshift data query`).
        if ('missing_params' in r && r.missing_params) {
          perQueryResults.push({
            id: r.id,
            status: 'deferred',
            missing_params: r.missing_params,
            error: r.error,
          });
        } else {
          perQueryResults.push({
            id: r.id,
            status: 'failed',
            error: r.error,
          });
        }
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

  const partial_failure = perQueryResults.some((r) => r.status === 'failed');
  const has_deferred = perQueryResults.some((r) => r.status === 'deferred');

  await track(
    {
      event_name: EventName.PrefetchCompleted,
      skill_id: opts.skill,
      outcome: partial_failure ? 'failed' : has_deferred ? 'deferred' : 'ok',
      duration_ms: Date.now() - t0,
      payload: {
        brand: opts.brand,
        run_date: opts.runDate,
        ok_count: perQueryResults.filter((r) => r.status === 'ok').length,
        failed_count: perQueryResults.filter((r) => r.status === 'failed').length,
        deferred_count: perQueryResults.filter((r) => r.status === 'deferred').length,
      },
    },
    opts.dataDirOverride,
  );

  return {
    brand_slug: context.brand_slug,
    skill_id: manifest.skill_id,
    run_date: opts.runDate,
    artifact_paths,
    queries: perQueryResults,
    total_duration_ms: Date.now() - t0,
    partial_failure,
    has_deferred,
  };
}

// -----------------------------------------------------------------------
// Per-query execution helper
// -----------------------------------------------------------------------

type ExecuteResult =
  | { id: string; ok: true; output: QueryRunOutput }
  | { id: string; ok: false; queryResult: DataQueryResult<Record<string, unknown>> & { ok: false } };

/**
 * Thrown when a query references params we couldn't compute. Carries
 * the list of missing names so the runner can classify the outcome as
 * `deferred` (skill provides them) vs. `failed` (real misconfiguration).
 */
class MissingParamsError extends Error {
  missing_params: string[];
  constructor(id: string, missing: string[]) {
    super(
      `Query ${id} references missing param(s): ${missing.join(', ')}. ` +
        `The skill must provide these via paramOverrides on a follow-up ` +
        `prefetch, or run the query inline via \`mixshift data query\`. ` +
        `Common cases: cross-query dependency (e.g. ANEG-04 needs ANEG-02's ` +
        `ASIN set), or a conditional query (LIB-PT-01 only applies during ` +
        `an active price_test event).`,
    );
    this.missing_params = missing;
  }
}

async function executeOne(
  id: string,
  allParams: Record<string, unknown>,
  dataDirOverride?: string,
): Promise<ExecuteResult> {
  const { sql: rawSql } = await readQuerySql(id);

  // Validate: every param referenced in the SQL must be defined.
  // Missing params throw a specially-typed error so the caller can
  // classify the outcome as `deferred` rather than `failed`.
  const referenced = findReferencedParams(rawSql);
  const missing = referenced.filter((p) => !(p in allParams));
  if (missing.length > 0) {
    throw new MissingParamsError(id, missing);
  }

  const { sql, params } = substituteParams(rawSql, allParams);

  // Pass the catalog ID into runQuery so the QueryExecuted event gets
  // tagged with query_id (vs ad-hoc / mx-data-explore queries which leave
  // query_id unset). Lets us group library-SQL performance separately.
  const result = await runQuery<Record<string, unknown>>(sql, params, {
    dataDirOverride,
    query_id: id,
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
