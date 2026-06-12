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
 *   dispatch: named  → POST {id, sellerIds, params} to /api/named-query.
 *                      The SQL body lives server-side in mx-legacy-auth's
 *                      private query pack, keyed by this catalog id; the
 *                      server validates scope + params and binds them.
 *                      This is the standard backend for library queries
 *                      (SP-MIGRATION.md, 2026-06-12 revision).
 *   dispatch: sproc  → build `CALL sp_<name>(?, ?)` with two positional
 *                      JSON args (params blob + seller-id scope) and POST
 *                      through the SAME /api/query. Superseded by `named`
 *                      (no catalog entry uses it after the brain cutover);
 *                      kept for transition use.
 *
 * Dev fallback (named + sproc entries): when MIXSHIFT_QUERY_PACK_DIR is
 * set and `<dir>/<catalog_id>.sql` exists (or, back-compat, when
 * MIXSHIFT_SPROC_SQL_DIR holds `<sproc_name>.sql`), the SQL text is read
 * from that LOCAL, git-ignored directory and routed as plain SQL with
 * :name substitution. This lets a new pack entry be developed and tested
 * before it deploys to the service. The mechanism is public-safe; the
 * SQL text itself never enters this repo.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getQueryEntry, readQuerySql, type QueryEntry } from '../prefetch/sql-library.js';
import { substituteParams, findReferencedParams } from '../prefetch/substitute.js';
import { runQuery, runNamedQuery, type DataQueryFailure } from './query-runner.js';

export const SPROC_SQL_DIR_ENV = 'MIXSHIFT_SPROC_SQL_DIR';
export const QUERY_PACK_DIR_ENV = 'MIXSHIFT_QUERY_PACK_DIR';

/** Which execution path actually ran (telemetry + artifact labeling). */
export type UsedDispatch =
  | 'sql'
  | 'named'
  | 'named_local_dev'
  | 'sproc'
  | 'sproc_local_dev';

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
  /** The statement that ran (post-substitution for sql; CALL for sproc;
   *  a non-secret placeholder for named, whose SQL is server-side). */
  displaySql: string;
  /** The params that accompanied the statement (artifact logging). */
  boundParams: Record<string, unknown>;
  /** Named dispatch only: the pack entry's SQL content hash, for artifact
   *  + telemetry attribution (the server-side text can change without a
   *  plugin release). Undefined for sql/sproc/local-dev paths. */
  revision?: string;
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
  return readLocalSql(env[SPROC_SQL_DIR_ENV], `${sprocName}.sql`);
}

/**
 * Local dev fallback for `dispatch: named` entries. Resolution order:
 * `<MIXSHIFT_QUERY_PACK_DIR>/<catalog_id>.sql` first (the pack-era
 * convention: files named by catalog id, mirroring the server-side
 * querypack entries), then `<MIXSHIFT_SPROC_SQL_DIR>/<sproc>.sql` when
 * the entry still carries its SP-era name (back-compat with dev dirs
 * created during the stored-procedure pilot).
 */
export async function resolveLocalNamedSql(
  catalogId: string,
  sprocName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const fromPack = await readLocalSql(env[QUERY_PACK_DIR_ENV], `${catalogId}.sql`);
  if (fromPack !== undefined) return fromPack;
  if (!sprocName) return undefined;
  return readLocalSql(env[SPROC_SQL_DIR_ENV], `${sprocName}.sql`);
}

async function readLocalSql(
  dir: string | undefined,
  fileName: string,
): Promise<string | undefined> {
  if (!dir) return undefined;
  const path = join(dir, fileName);
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

  if (entry.dispatch === 'named') {
    const localSql = await resolveLocalNamedSql(id, entry.sproc);
    if (localSql !== undefined) {
      return runSqlText<Row>(id, stripSqlHeader(localSql), opts, 'named_local_dev');
    }
    return runNamed<Row>(id, opts);
  }

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

async function runNamed<Row>(
  id: string,
  opts: DispatchOptions,
): Promise<DispatchResult<Row>> {
  // Same split as the sproc backend: seller_ids inside params routes to
  // the request's top-level seller scope, so callers pass one params map
  // regardless of backend.
  const { seller_ids: paramsSellerIds, ...restParams } = opts.params ?? {};
  const sellerIds =
    opts.sellerIds ?? (Array.isArray(paramsSellerIds) ? paramsSellerIds : []);

  const result = await runNamedQuery<Row>(id, {
    sellerIds,
    params: restParams,
    dataDirOverride: opts.dataDirOverride,
    queryTimeoutMs: opts.queryTimeoutMs,
  });

  if (!result.ok) {
    return { ok: false, id, usedDispatch: 'named', failure: result };
  }
  return {
    ok: true,
    id,
    rows: result.rows,
    rowCount: result.rowCount,
    durationMs: result.durationMs,
    usedDispatch: 'named',
    displaySql: `-- named query ${id}@${result.revision ?? '?'} (SQL executes server-side)`,
    boundParams: { id, seller_ids: sellerIds, params: restParams },
    revision: result.revision,
  };
}

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
