/**
 * Dispatch registry: resolve a catalog query ID to its execution
 * backend and run it. The single seam serving three goals (see
 * internal/SP-MIGRATION.md "Dual-mode during transition"):
 *
 *   - Query security: `dispatch: sproc` entries ship NO SQL text in this
 *     public repo. The body lives warehouse-side as a stored procedure
 *     (private mx-warehouse-sprocs repo); the harness only knows the SP
 *     name, and names are not sensitive.
 *   - MixShift 2.0 portability: skills and pipelines reference logical
 *     query IDs only. When the 2.0 backend lands, it becomes a new
 *     branch here + per-entry catalog flips. Skill code doesn't change.
 *   - Brand-brain fetch (#64): the brain pulls are born dispatch:sproc;
 *     the first consumers with no raw-SQL ancestor in the repo.
 *
 * Backends today:
 *
 *   dispatch: sql    → read `.sql` body from shared/sql-library, apply
 *                      :name substitution, POST through /api/query.
 *   dispatch: sproc  → build `CALL sp_<name>(?, ?)` with two positional
 *                      JSON args (params blob + seller-id scope) and POST
 *                      through the SAME /api/query. MySQL EXECUTE grants
 *                      are the allowlist; the SP body validates its own
 *                      params (SIGNAL SQLSTATE '45000' on bad input).
 *
 * Dev fallback (sproc entries only): when MIXSHIFT_SPROC_SQL_DIR is set
 * and `<dir>/<sproc_name>.sql` exists, the SQL text is read from that
 * LOCAL, git-ignored directory and routed as plain SQL with :name
 * substitution. This unblocks plugin development before the
 * warehouse-side SPs are deployed. The mechanism is public-safe; the
 * SQL text itself never enters this repo.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getQueryEntry, readQuerySql, type QueryEntry } from '../prefetch/sql-library.js';
import { substituteParams, findReferencedParams } from '../prefetch/substitute.js';
import { runQuery, type DataQueryFailure } from './query-runner.js';

export const SPROC_SQL_DIR_ENV = 'MIXSHIFT_SPROC_SQL_DIR';

/** Which execution path actually ran (telemetry + artifact labeling). */
export type UsedDispatch = 'sql' | 'sproc' | 'sproc_local_dev';

export interface DispatchOptions {
  /**
   * Named parameters. For `sql` dispatch (and the sproc local-dev
   * fallback) these substitute `:name` placeholders in the SQL text.
   * For `sproc` dispatch they become the SP's first JSON argument
   * (minus `seller_ids`, which routes to the second argument).
   */
  params?: Record<string, unknown>;
  /**
   * Seller scope. For `sproc` dispatch this is the SP's second JSON
   * argument (the universal row-scope arg per the SP signature
   * convention). For `sql` dispatch, pass seller ids inside `params`
   * instead (the SQL references them as :seller_ids).
   */
  sellerIds?: Array<number | string>;
  dataDirOverride?: string;
  queryTimeoutMs?: number;
}

export interface DispatchSuccess<Row> {
  ok: true;
  id: string;
  rows: Row[];
  rowCount: number;
  durationMs: number;
  usedDispatch: UsedDispatch;
  /** The statement that ran (post-substitution for sql; CALL for sproc). */
  displaySql: string;
  /** The params that accompanied the statement (artifact logging). */
  boundParams: Record<string, unknown>;
}

export interface DispatchFailure {
  ok: false;
  id: string;
  usedDispatch: UsedDispatch;
  /** Classified failure from the query runner. */
  failure: DataQueryFailure;
}

export type DispatchResult<Row> = DispatchSuccess<Row> | DispatchFailure;

/**
 * Thrown when SQL-text execution (sql dispatch or sproc local fallback)
 * references :params the caller didn't provide. Carries the missing
 * names so the prefetch runner can classify the outcome as `deferred`
 * (cross-query dependency) rather than `failed`.
 */
export class MissingParamsError extends Error {
  missing_params: string[];
  constructor(id: string, missing: string[]) {
    super(
      `Query ${id} references missing param(s): ${missing.join(', ')}. ` +
        `Provide them via paramOverrides on a follow-up call, or run the ` +
        `query inline via \`mixshift data query\`. Common cases: ` +
        `cross-query dependency (e.g. ANEG-04 needs ANEG-02's ASIN set), ` +
        `or a conditional query (LIB-PT-01 only applies during an active ` +
        `price_test event).`,
    );
    this.missing_params = missing;
  }
}

/**
 * Resolve `<MIXSHIFT_SPROC_SQL_DIR>/<sproc>.sql` if the env var is set
 * and the file exists. Returns the SQL text, or undefined when the
 * fallback doesn't apply (the normal case for real users).
 */
export async function resolveLocalSprocSql(
  sprocName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const dir = env[SPROC_SQL_DIR_ENV];
  if (!dir) return undefined;
  const path = join(dir, `${sprocName}.sql`);
  try {
    await access(path);
  } catch {
    return undefined;
  }
  return readFile(path, 'utf-8');
}

/**
 * The uniform SP invocation statement. Two positional JSON args per the
 * SP signature convention (internal/SP-MIGRATION.md): a params blob and
 * the seller-id scope. One client path serves every SP.
 */
export function buildCallSql(sprocName: string): string {
  return `CALL ${sprocName}(?, ?)`;
}

/**
 * Execute a catalog query by logical ID through whichever backend its
 * catalog entry declares. The only public entry point; callers never
 * branch on dispatch themselves.
 */
export async function runDispatched<Row = Record<string, unknown>>(
  id: string,
  opts: DispatchOptions = {},
): Promise<DispatchResult<Row>> {
  const entry = await getQueryEntry(id);

  if (entry.dispatch === 'sproc') {
    const localSql = await resolveLocalSprocSql(entry.sproc!);
    if (localSql !== undefined) {
      return runSqlText<Row>(id, stripSqlHeader(localSql), opts, 'sproc_local_dev');
    }
    return runSproc<Row>(id, entry, opts);
  }

  // dispatch: sql, the original path.
  const { sql } = await readQuerySql(id);
  return runSqlText<Row>(id, sql, opts, 'sql');
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

async function runSproc<Row>(
  id: string,
  entry: QueryEntry,
  opts: DispatchOptions,
): Promise<DispatchResult<Row>> {
  // seller_ids inside params would silently duplicate the second arg;
  // route it there instead so callers can pass one params map.
  const { seller_ids: paramsSellerIds, ...restParams } = opts.params ?? {};
  const sellerIds =
    opts.sellerIds ?? (Array.isArray(paramsSellerIds) ? paramsSellerIds : []);

  const sql = buildCallSql(entry.sproc!);
  const bound = [JSON.stringify(restParams), JSON.stringify(sellerIds)];

  const result = await runQuery<Row>(sql, bound, {
    dataDirOverride: opts.dataDirOverride,
    queryTimeoutMs: opts.queryTimeoutMs,
    query_id: id,
  });

  if (!result.ok) {
    return { ok: false, id, usedDispatch: 'sproc', failure: result };
  }
  return {
    ok: true,
    id,
    rows: result.rows,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    usedDispatch: 'sproc',
    displaySql: sql,
    boundParams: { p_params: restParams, p_seller_ids: sellerIds },
  };
}

async function runSqlText<Row>(
  id: string,
  rawSql: string,
  opts: DispatchOptions,
  usedDispatch: UsedDispatch,
): Promise<DispatchResult<Row>> {
  const allParams = opts.params ?? {};
  const referenced = findReferencedParams(rawSql);
  const missing = referenced.filter((p) => !(p in allParams));
  if (missing.length > 0) {
    throw new MissingParamsError(id, missing);
  }

  const { sql, params } = substituteParams(rawSql, allParams);
  const result = await runQuery<Row>(sql, params, {
    dataDirOverride: opts.dataDirOverride,
    queryTimeoutMs: opts.queryTimeoutMs,
    query_id: id,
  });

  if (!result.ok) {
    return { ok: false, id, usedDispatch, failure: result };
  }
  return {
    ok: true,
    id,
    rows: result.rows,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    usedDispatch,
    displaySql: sql,
    boundParams: params,
  };
}

/**
 * Local dev .sql files follow the same convention as the library files:
 * a leading `--` comment header, then the statement. Strip the header so
 * what we send is just executable SQL.
 */
function stripSqlHeader(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('--') || line.trim() === '') {
      headerEnd = i + 1;
    } else {
      break;
    }
  }
  return lines.slice(headerEnd).join('\n').trim();
}
