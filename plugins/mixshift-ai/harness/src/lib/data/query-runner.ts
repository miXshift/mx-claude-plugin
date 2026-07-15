/**
 * Run queries against the warehouse with friendly error classification.
 *
 * The harness uses read-only MySQL credentials, so destructive writes
 * are impossible at the DB level. What CAN go wrong:
 *
 *   - User isn't granted SELECT on the table they're trying to query →
 *     ER_TABLEACCESS_DENIED_ERROR (code 1142). We surface this as a
 *     classified failure with the offending table name so the skill
 *     can offer to send a table-access-request webhook.
 *   - User exceeds the connect/query timeout (default 60s per Sam) →
 *     PROTOCOL_SEQUENCE_TIMEOUT or similar. We surface as `timeout`.
 *   - Syntax errors, unknown columns, etc. → surface raw.
 *
 * Two execution modes:
 *   - `runQuery` — buffered. Returns all rows in memory. Use for
 *     sample/preview and joins where N is bounded.
 *   - `streamQuery` — hand each capped PAGE to a callback as it arrives, then
 *     drop it. Peak memory is one page, not the whole result. Use for `--out`
 *     delivery where N could be tens of thousands of (arbitrarily wide) rows.
 */

import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { type MysqlCreds, type DatahubCreds, isDatahubCreds } from '../auth/schema.js';
import { track, EventName } from '../telemetry/index.js';

export type DataQueryFailureKind =
  | 'access_denied_table'
  | 'access_denied_db'
  | 'unknown_table'
  | 'syntax_error'
  | 'timeout'
  | 'host_unreachable'
  // Named-query surface (POST /api/named-query) only: the pack has no
  // entry for the requested id (plugin release ahead of service deploy) /
  // the request was malformed against the entry's spec / a required param
  // was absent. `missing_params` is distinct from `bad_params` because the
  // prefetch runner maps it to `deferred` (a cross-query dependency the
  // skill supplies on a follow-up pass), mirroring the client-side
  // MissingParamsError contract from the dispatch:sql era.
  | 'unknown_query'
  | 'bad_params'
  | 'missing_params'
  | 'unknown';

export interface DataQuerySuccess<Row> {
  ok: true;
  rows: Row[];
  rowCount: number;
  durationMs: number;
  /** Named-query pack only: the executed entry's 8-hex SQL content hash.
   *  Stamped into prefetch artifacts + telemetry so a result is
   *  attributable to the exact server-side query text, which can change
   *  without a plugin release. Undefined for raw-SQL / mysql paths. */
  revision?: string;
}

export interface DataQueryFailure {
  ok: false;
  kind: DataQueryFailureKind;
  table_name?: string;
  raw_code?: string;
  /** kind 'missing_params' only: the required param names that were absent. */
  missing_params?: string[];
  message: string;
  /** Friendly, user-facing message — distinct from `message` which is raw. */
  friendly: string;
  /** Duration up to the point of failure (0 if not measured). */
  durationMs?: number;
}

export type DataQueryResult<Row> = DataQuerySuccess<Row> | DataQueryFailure;

export interface RunQueryOptions {
  /** Override the resolved credentials. Accepts either flavor (legacy
   *  mysql or datahub token-based). Tests pass a fixture; production
   *  callers leave this unset and let resolveCreds read from disk. */
  creds?: MysqlCreds | DatahubCreds;
  dataDirOverride?: string;
  /** Statement timeout. Defaults to 60s (Sam's call). */
  queryTimeoutMs?: number;
  /** Connection timeout. Defaults to 10s. */
  connectTimeoutMs?: number;
}

export interface RunQueryTelemetry {
  /** Library SQL ID (e.g. 'DHC-01') if this query came from the SQL library, else undefined. */
  query_id?: string;
  /** Primary table touched (best-effort; surface what callers know cheaply). */
  query_table?: string;
}

/** Server-side per-request row cap on the datahub gateway (`/api/query`). A
 *  single request returning MORE than this is REJECTED outright, not
 *  truncated — so a large mask/export must be paged. */
export const SERVICE_ROW_CAP = 50_000;
/** Target serialized-bytes budget per paged request. Held safely under the
 *  server's 10 MB response cap (2 MB headroom) so a page stays under the byte
 *  cap by construction; the shrink-retry handles any residual overshoot. */
export const PAGE_BYTE_BUDGET = 8 * 1024 * 1024;
/** Upper bound on rows per page: never request more than the server row cap. */
export const PAGE_MAX_ROWS = SERVICE_ROW_CAP;
/** Conservative first-page size: measure the real serialized row width before
 *  committing to a large page. We deliberately do NOT start at PAGE_MAX_ROWS. */
export const FIRST_PAGE_PROBE_ROWS = 5_000;
/** Hard ceiling on assembled rows before we tell the caller to narrow. A high
 *  safety net for UNBOUNDED queries, not a normal failure — an explicit user
 *  LIMIT (or a caller maxRows) is honored past nothing here because it opts
 *  out of the ceiling. */
export const MAX_PAGINATED_ROWS = 2_000_000;

/** Detects EITHER gateway cap rejection — the 50k-row cap ("…service cap is
 *  50000") OR the 10 MB byte cap ("…service cap of 10.0 MB"). Matched across
 *  both `message` (raw) and `friendly` because the phrasing differs between
 *  the two fields. The mysql backend never emits these. */
export function isServiceCapFailure(r: DataQueryResult<unknown>): boolean {
  if (r.ok) return false;
  return /service cap/i.test(`${r.message ?? ''} ${r.friendly ?? ''}`);
}

/** Resolve creds + route one query to the datahub or mysql backend. The raw
 *  single shot; `runQuery` wraps this with cap-aware pagination. */
async function runOnce<Row>(
  sql: string,
  params: unknown[] | Record<string, unknown>,
  options: RunQueryOptions & RunQueryTelemetry,
): Promise<DataQueryResult<Row>> {
  let creds: MysqlCreds | DatahubCreds;
  try {
    creds = await resolveCreds(options);
  } catch (err) {
    // resolveCreds throws when no creds file exists. Surface as a
    // failure envelope so callers see the same shape they get for
    // every other failure mode.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: 'unknown',
      message,
      friendly: message,
      durationMs: 0,
    };
  }
  if (isDatahubCreds(creds)) {
    return runDatahubQuery<Row>(creds, sql, params, options);
  }
  return runMysqlQuery<Row>(creds, sql, params, options);
}

/**
 * Execute a query, transparently paginating when the result exceeds a datahub
 * gateway per-request cap (50k rows OR 10 MB). Both are hard rejects, so a
 * large pull (e.g. an account's full negative-keyword exclusion mask) would
 * otherwise fail outright and starve downstream skills. We page with a STABLE
 * order (ORDER BY every output column by position) so OFFSET windows neither
 * skip nor duplicate rows, sizing each window against a BYTE BUDGET so wide
 * rows page small and narrow rows page large, then concatenate. Only the
 * datahub backend caps; the mysql backend returns the single shot unchanged.
 *
 * Buffered: returns all rows in memory. For disk delivery that must not hold
 * the whole result set, use `streamQuery` instead.
 */
export async function runQuery<Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] | Record<string, unknown> = [],
  options: RunQueryOptions & RunQueryTelemetry = {},
): Promise<DataQueryResult<Row>> {
  const first = await runOnce<Row>(sql, params, options);
  if (!isServiceCapFailure(first)) return first;
  return paginateOverCap<Row>(sql, (pageSql) =>
    runOnce<Row>(pageSql, params, options),
  );
}

export interface StreamedQueryResult {
  ok: boolean;
  rowCount: number;
  durationMs: number;
  /** True when the result exceeded a single-request cap and was paged. A
   *  single-shot result (fits under both caps) reports false. */
  paginated: boolean;
  /** Present only when ok === false — the classified failure envelope, whose
   *  `kind` feeds the same telemetry `error_class` as the buffered path. */
  failure?: DataQueryFailure;
}

/**
 * Stream a query's rows to a sink WITHOUT buffering the whole result set. Each
 * page is handed to `onPage(rows, pageIndex)` as it arrives and then dropped,
 * so peak memory is one page, not the full result. A result that fits under
 * the server caps arrives as a single page (pageIndex 0, `paginated: false`);
 * a larger result is paged transparently (byte-budgeted OFFSET windows,
 * `paginated: true`). `pageIndex` counts only non-empty pages, starting at 0.
 *
 * Use for `--out` delivery and any path that writes to disk. Callers that need
 * the rows in memory (sample/preview, joins, prefetch) use `runQuery`.
 */
export async function streamQuery<Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] | Record<string, unknown> = [],
  options: RunQueryOptions & RunQueryTelemetry = {},
  onPage: (rows: Row[], pageIndex: number) => void | Promise<void>,
): Promise<StreamedQueryResult> {
  const t0 = Date.now();
  const first = await runOnce<Row>(sql, params, options);
  if (first.ok) {
    // Single shot: the server returned the whole result under both caps.
    if (first.rows.length > 0) await onPage(first.rows, 0);
    return {
      ok: true,
      rowCount: first.rowCount,
      durationMs: first.durationMs,
      paginated: false,
    };
  }
  if (!isServiceCapFailure(first)) {
    return {
      ok: false,
      rowCount: 0,
      durationMs: first.durationMs ?? Date.now() - t0,
      paginated: false,
      failure: first,
    };
  }
  const paged = await paginateOverCap<Row>(
    sql,
    (pageSql) => runOnce<Row>(pageSql, params, options),
    { onPage },
  );
  if (!paged.ok) {
    return {
      ok: false,
      rowCount: 0,
      durationMs: paged.durationMs ?? Date.now() - t0,
      paginated: true,
      failure: paged,
    };
  }
  return {
    ok: true,
    rowCount: paged.rowCount,
    durationMs: paged.durationMs ?? Date.now() - t0,
    paginated: true,
  };
}

export interface PaginateOptions<Row> {
  /** Stream each non-empty page as it arrives instead of buffering. When set,
   *  rows are NOT retained in memory and the returned `rows` array is empty
   *  (read `rowCount` for the total delivered). */
  onPage?: (rows: Row[], pageIndex: number) => void | Promise<void>;
  /** Hard cap on total rows delivered, combined (min) with any user LIMIT
   *  parsed off the SQL. A bounded result opts out of the MAX_PAGINATED_ROWS
   *  ceiling (the caller explicitly asked for that many). */
  maxRows?: number;
}

/** A statement-final LIMIT/OFFSET parsed off the top-level query. */
interface OuterLimit {
  innerSql: string;
  limit?: number;
  offset?: number;
}

/**
 * Split a statement-final `LIMIT`/`OFFSET` off a SELECT so the pager can honor
 * it as a hard total-row cap rather than leaving it inside the wrapped derived
 * table. Left in place, a user LIMIT would be RE-EXECUTED on every page's
 * derived-table materialization — and without a stable inner order MySQL is
 * free to pick a different subset each time, so OFFSET windows would skip and
 * duplicate rows (silently wrong results). Trailing position guarantees the
 * match is top-level: a subquery's LIMIT is always followed by a closing paren
 * or more SQL, never the end of the string. Only integer-literal LIMITs are
 * detected; a parameterized `LIMIT ?` is left in the subquery unchanged (rare
 * on this raw-SQL path).
 */
function extractOuterLimit(sql: string): OuterLimit {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  // MySQL forms: `LIMIT count [OFFSET off]` and `LIMIT off, count`.
  const m = /\blimit\s+(\d+)(?:\s*,\s*(\d+))?(?:\s+offset\s+(\d+))?\s*$/i.exec(trimmed);
  if (!m) return { innerSql: trimmed };
  const innerSql = trimmed.slice(0, m.index).trimEnd();
  const first = Number(m[1]);
  const second = m[2] !== undefined ? Number(m[2]) : undefined;
  const offsetKeyword = m[3] !== undefined ? Number(m[3]) : undefined;
  if (second !== undefined) {
    // `LIMIT off, count`
    return { innerSql, limit: second, offset: first };
  }
  // `LIMIT count [OFFSET off]`
  return { innerSql, limit: first, offset: offsetKeyword };
}

/**
 * Page a cap-exceeding SELECT through repeated LIMIT/OFFSET windows. `exec`
 * runs one already-param-bound statement (LIMIT/OFFSET are inlined integers,
 * so the original `?`/`:name` params bind unchanged per page). Exported for
 * unit testing. Non-SELECT statements can't be wrapped — but they don't return
 * rows, so they never hit the cap.
 *
 * OFFSET paging over a derived table is correct and adequate at the target
 * scale (tens of thousands of rows). We deliberately do NOT implement keyset
 * paging here — it is out of scope for this phase and unnecessary until we see
 * genuinely deep (million-row+) unbounded pulls.
 */
export async function paginateOverCap<Row>(
  sql: string,
  exec: (pageSql: string) => Promise<DataQueryResult<Row>>,
  opts: PaginateOptions<Row> = {},
): Promise<DataQueryResult<Row>> {
  const t0 = Date.now();
  const { innerSql, limit: userLimit, offset: userOffset } = extractOuterLimit(sql);
  if (!/^\s*(select|with)\b/i.test(innerSql)) {
    const message =
      'Result exceeds the 50,000-row service cap and the statement is not a ' +
      'SELECT, so it cannot be paginated. Narrow the query.';
    return { ok: false, kind: 'unknown', message, friendly: message, durationMs: Date.now() - t0 };
  }
  // Probe the output column count for a positional, deterministic ORDER BY.
  const probe = await exec(`SELECT * FROM (${innerSql}) AS _mx_page LIMIT 1`);
  if (!probe.ok) return probe;
  const ncols = probe.rows.length
    ? Object.keys(probe.rows[0] as Record<string, unknown>).length
    : 0;
  if (ncols === 0) {
    return { ok: true, rows: [], rowCount: 0, durationMs: Date.now() - t0 };
  }
  const orderBy = Array.from({ length: ncols }, (_, i) => String(i + 1)).join(', ');

  // A user LIMIT and/or a caller maxRows makes the result BOUNDED: honor the
  // smaller as a hard cap on rows delivered, and opt out of the safety ceiling.
  const maxRows = Math.min(userLimit ?? Infinity, opts.maxRows ?? Infinity);
  const bounded = Number.isFinite(maxRows);

  const all: Row[] = [];
  // Byte budget: start conservative to measure the real serialized row width,
  // then size the next page as clamp(floor(PAGE_BYTE_BUDGET / bytesPerRow), 1,
  // PAGE_MAX_ROWS). Ultra-wide rows drive the page far below 1000 — there is no
  // floor (the old 1000-row floor is exactly what made wide SELECT * fail).
  let pageSize = FIRST_PAGE_PROBE_ROWS;
  let offset = userOffset ?? 0;
  let delivered = 0;
  let pageIndex = 0;
  // Bounded: page advances + shrinks are both finite; the iteration cap is a
  // safety net (real results converge in a handful of iterations).
  for (let iter = 0; iter < 100_000; iter++) {
    const remaining = maxRows - delivered;
    if (remaining <= 0) break; // hit the bounded cap
    const cap = bounded ? Math.min(PAGE_MAX_ROWS, remaining) : PAGE_MAX_ROWS;
    const requestSize = Math.max(1, Math.min(pageSize, cap));
    const r = await exec(
      `SELECT * FROM (${innerSql}) AS _mx_page ORDER BY ${orderBy} ` +
        `LIMIT ${requestSize} OFFSET ${offset}`,
    );
    if (!r.ok) {
      // A page can still trip the 10 MB byte cap for very wide rows. Halve the
      // window and retry the SAME offset — the stable ORDER BY keeps offsets
      // consistent across page sizes. Shrink all the way to 1 row if needed.
      if (isServiceCapFailure(r) && requestSize > 1) {
        pageSize = Math.max(1, Math.floor(requestSize / 2));
        continue;
      }
      return r;
    }
    // Observe the serialized width of this page to size the NEXT one. Measuring
    // rows-only JSON bytes tracks the server's response size closely enough,
    // and the 2 MB headroom under the 10 MB cap absorbs the difference.
    if (r.rows.length > 0) {
      const bytes = Buffer.byteLength(JSON.stringify(r.rows), 'utf8');
      const bytesPerRow = Math.max(1, Math.ceil(bytes / r.rows.length));
      pageSize = Math.max(1, Math.min(PAGE_MAX_ROWS, Math.floor(PAGE_BYTE_BUDGET / bytesPerRow)));
    }
    if (opts.onPage) {
      if (r.rows.length > 0) await opts.onPage(r.rows, pageIndex++);
    } else {
      all.push(...r.rows);
    }
    delivered += r.rows.length;
    offset += r.rows.length;
    if (r.rows.length < requestSize) {
      // Short page → end of the (possibly bounded) result.
      return { ok: true, rows: all, rowCount: delivered, durationMs: Date.now() - t0 };
    }
    if (!bounded && delivered >= MAX_PAGINATED_ROWS) {
      const m =
        `Result exceeds ${MAX_PAGINATED_ROWS} rows even after pagination; ` +
        `narrow the query (add a WHERE filter, aggregate, or pass an explicit LIMIT).`;
      return { ok: false, kind: 'unknown', message: m, friendly: m, durationMs: Date.now() - t0 };
    }
  }
  // Loop exited by hitting the bounded cap (remaining <= 0).
  return { ok: true, rows: all, rowCount: delivered, durationMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// MySQL path (legacy raw-creds)
// ---------------------------------------------------------------------------

async function runMysqlQuery<Row>(
  creds: MysqlCreds,
  sql: string,
  params: unknown[] | Record<string, unknown>,
  options: RunQueryOptions & RunQueryTelemetry,
): Promise<DataQueryResult<Row>> {
  const t0 = Date.now();
  let conn: mysql.Connection | undefined;
  try {
    // If params is an object (not an array), flip on mysql2's
    // namedPlaceholders mode so `:name` in SQL gets bound to params[name].
    // Lists are inlined upstream (see lib/prefetch/substitute.ts), so we
    // never need positional-mode array expansion here.
    const useNamed =
      !Array.isArray(params) && params !== null && typeof params === 'object';

    conn = await mysql.createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.database,
      connectTimeout: options.connectTimeoutMs ?? 10_000,
      namedPlaceholders: useNamed,
      // BIGINT columns exceed JS safe-integer range; return them as strings so
      // ids (DSP advertiserId, orderId, ...) are never silently rounded.
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    const timeoutMs = options.queryTimeoutMs ?? 60_000;
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ?`, [timeoutMs]);

    const [rows] = await conn.query<RowDataPacket[]>(
      sql,
      params as unknown as unknown[],
    );
    const durationMs = Date.now() - t0;
    void track(
      {
        event_name: EventName.QueryExecuted,
        outcome: 'ok',
        duration_ms: durationMs,
        row_count: rows.length,
        query_id: options.query_id,
        query_table: options.query_table,
        payload: {
          auth_path: 'mysql',
          sql_normalized: sql.length > 2000 ? sql.slice(0, 2000) + '...' : sql,
        },
      },
      options.dataDirOverride,
    );
    return {
      ok: true,
      rows: rows as unknown as Row[],
      rowCount: rows.length,
      durationMs,
    };
  } catch (err) {
    const failure = classify(err);
    void track(
      {
        event_name: EventName.QueryFailed,
        outcome: 'failed',
        duration_ms: Date.now() - t0,
        query_id: options.query_id,
        query_table: options.query_table,
        error_class: failure.kind,
        payload: {
          auth_path: 'mysql',
          raw_code: failure.raw_code,
          sql_normalized: sql.length > 2000 ? sql.slice(0, 2000) + '...' : sql,
          table_name: failure.table_name,
        },
      },
      options.dataDirOverride,
    );
    return failure;
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // ignore close errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Datahub path (token-based, mx-legacy-auth)
// ---------------------------------------------------------------------------

interface DatahubQueryWire {
  ok: boolean;
  // Success shape
  rows?: unknown[];
  rowCount?: number;
  durationMs?: number;
  // Failure shape
  kind?: DataQueryFailureKind;
  table_name?: string;
  raw_code?: string;
  message?: string;
  friendly?: string;
}

/**
 * POST a JSON body to a datahub endpoint with the stored bearer token,
 * force-refreshing and retrying exactly once on a mid-session 401.
 * Throws DatahubNetworkError on network / DNS / TLS failure (callers map
 * it to `host_unreachable`) and a plain Error when the session cannot be
 * refreshed. Shared by the raw-SQL gateway (/api/query) and the named
 * query pack (/api/named-query).
 */
async function datahubAuthedPost(
  creds: DatahubCreds,
  path: string,
  body: Record<string, unknown>,
  timeoutBudgetMs: number,
  dataDirOverride?: string,
): Promise<Response> {
  const doFetch = async (bearer: string): Promise<Response> => {
    try {
      return await fetch(`${creds.api_base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Give the server a small grace window beyond its own timeout so
        // we don't AbortError before it has a chance to return the
        // classified timeout envelope.
        signal: AbortSignal.timeout(timeoutBudgetMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DatahubNetworkError(message);
    }
  };

  let token = await getValidAccessToken(dataDirOverride);
  let res = await doFetch(token);

  // Mid-session 401: token looked fresh client-side but the server
  // rejected it. Force-refresh and retry exactly once.
  if (res.status === 401) {
    token = await getValidAccessToken(dataDirOverride, true);
    res = await doFetch(token);
    if (res.status === 401) {
      throw new Error(
        'Your MixShift session expired and could not be refreshed. ' +
          'Run `mixshift auth login` to re-authenticate.',
      );
    }
  }
  return res;
}

async function runDatahubQuery<Row>(
  creds: DatahubCreds,
  sql: string,
  params: unknown[] | Record<string, unknown>,
  options: RunQueryOptions & RunQueryTelemetry,
): Promise<DataQueryResult<Row>> {
  const t0 = Date.now();
  const queryTimeoutMs = options.queryTimeoutMs ?? 60_000;

  try {
    const res = await datahubAuthedPost(
      creds,
      '/api/query',
      { sql, params, queryTimeoutMs },
      queryTimeoutMs + 5_000,
      options.dataDirOverride,
    );

    // Server returns the same envelope shape as DataQueryResult — just
    // pass through. Type assertion is safe because the schema is
    // shared with the plugin (DataQueryFailureKind kinds match).
    const json = (await res.json()) as DatahubQueryWire;
    const durationMs = Date.now() - t0;

    if (json.ok === true) {
      const rows = (json.rows ?? []) as Row[];
      const rowCount = json.rowCount ?? rows.length;
      const serverDuration = json.durationMs ?? durationMs;
      void track(
        {
          event_name: EventName.QueryExecuted,
          outcome: 'ok',
          duration_ms: durationMs,
          row_count: rowCount,
          query_id: options.query_id,
          query_table: options.query_table,
          payload: {
            auth_path: 'datahub',
            server_duration_ms: serverDuration,
            sql_normalized:
              sql.length > 2000 ? sql.slice(0, 2000) + '...' : sql,
          },
        },
        options.dataDirOverride,
      );
      return { ok: true, rows, rowCount, durationMs: serverDuration };
    }

    // Failure envelope
    const failure: DataQueryFailure = {
      ok: false,
      kind: (json.kind ?? 'unknown') as DataQueryFailureKind,
      table_name: json.table_name,
      raw_code: json.raw_code,
      message: json.message ?? 'Query failed',
      friendly: json.friendly ?? json.message ?? 'Query failed',
      durationMs,
    };
    void track(
      {
        event_name: EventName.QueryFailed,
        outcome: 'failed',
        duration_ms: durationMs,
        query_id: options.query_id,
        query_table: options.query_table,
        error_class: failure.kind,
        payload: {
          auth_path: 'datahub',
          raw_code: failure.raw_code,
          sql_normalized:
            sql.length > 2000 ? sql.slice(0, 2000) + '...' : sql,
          table_name: failure.table_name,
        },
      },
      options.dataDirOverride,
    );
    return failure;
  } catch (err) {
    const durationMs = Date.now() - t0;
    let failure: DataQueryFailure;
    if (err instanceof DatahubNetworkError) {
      failure = {
        ok: false,
        kind: 'host_unreachable',
        message: err.message,
        friendly:
          'The MixShift auth service is unreachable. Check your network ' +
          'or try again in a minute.',
        durationMs,
      };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      failure = {
        ok: false,
        kind: 'unknown',
        message,
        friendly: message,
        durationMs,
      };
    }
    void track(
      {
        event_name: EventName.QueryFailed,
        outcome: 'failed',
        duration_ms: durationMs,
        query_id: options.query_id,
        query_table: options.query_table,
        error_class: failure.kind,
        payload: {
          auth_path: 'datahub',
          sql_normalized:
            sql.length > 2000 ? sql.slice(0, 2000) + '...' : sql,
        },
      },
      options.dataDirOverride,
    );
    return failure;
  }
}

// ---------------------------------------------------------------------------
// Named query pack (token-based only; POST /api/named-query)
// ---------------------------------------------------------------------------

export interface NamedQueryOptions {
  /** Seller scope, bound server-side as the entry's IN-list. Omitted when
   *  empty so unscoped entries (e.g. PING) send a minimal body. */
  sellerIds?: Array<number | string>;
  /** Entry-specific named params, validated server-side against the pack
   *  entry's strict schema. */
  params?: Record<string, unknown>;
  queryTimeoutMs?: number;
  dataDirOverride?: string;
  /** Tests inject creds; production resolves from disk. */
  creds?: MysqlCreds | DatahubCreds;
}

interface NamedQueryWire extends DatahubQueryWire {
  id?: string;
  /** Success: the entry's SQL content hash. */
  revision?: string;
  /** kind 'missing_params': the absent required param names. */
  missing_params?: string[];
}

/**
 * Execute a library query by pack id through POST /api/named-query. The
 * SQL text lives server-side in mx-legacy-auth's query pack; the harness
 * only ever sends the id plus bind values. Same envelope contract as
 * /api/query, plus the named-only failure kinds `unknown_query` and
 * `bad_params`.
 *
 * Token-based sessions only: with legacy raw-MySQL credentials there is
 * no SQL text client-side to run, so this fails with a sign-in pointer
 * instead of attempting a direct connection.
 */
export async function runNamedQuery<Row = Record<string, unknown>>(
  id: string,
  options: NamedQueryOptions = {},
): Promise<DataQueryResult<Row>> {
  let creds: MysqlCreds | DatahubCreds;
  try {
    creds = await resolveCreds({
      creds: options.creds,
      dataDirOverride: options.dataDirOverride,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'unknown', message, friendly: message, durationMs: 0 };
  }
  if (!isDatahubCreds(creds)) {
    return {
      ok: false,
      kind: 'unknown',
      message: `Named query ${id} requires a token-based session; legacy raw-MySQL credentials cannot run it.`,
      friendly:
        'Library queries now run server-side and need the token-based sign-in. ' +
        'Run `mixshift auth login` (or `mixshift auth service-setup` for unattended use).',
      durationMs: 0,
    };
  }

  const t0 = Date.now();
  const queryTimeoutMs = options.queryTimeoutMs ?? 60_000;
  const sellerIds =
    options.sellerIds && options.sellerIds.length > 0 ? options.sellerIds : undefined;

  try {
    const res = await datahubAuthedPost(
      creds,
      '/api/named-query',
      { id, sellerIds, params: options.params, queryTimeoutMs },
      queryTimeoutMs + 5_000,
      options.dataDirOverride,
    );
    const json = (await res.json()) as NamedQueryWire;
    const durationMs = Date.now() - t0;

    if (json.ok === true) {
      const rows = (json.rows ?? []) as Row[];
      const rowCount = json.rowCount ?? rows.length;
      const serverDuration = json.durationMs ?? durationMs;
      void track(
        {
          event_name: EventName.QueryExecuted,
          outcome: 'ok',
          duration_ms: durationMs,
          row_count: rowCount,
          query_id: id,
          payload: {
            auth_path: 'datahub',
            named_query: true,
            server_duration_ms: serverDuration,
            revision: json.revision,
          },
        },
        options.dataDirOverride,
      );
      return { ok: true, rows, rowCount, durationMs: serverDuration, revision: json.revision };
    }

    const failure: DataQueryFailure = {
      ok: false,
      kind: (json.kind ?? 'unknown') as DataQueryFailureKind,
      table_name: json.table_name,
      raw_code: json.raw_code,
      missing_params: json.missing_params,
      message: json.message ?? `Named query ${id} failed`,
      friendly: json.friendly ?? json.message ?? `Named query ${id} failed`,
      durationMs,
    };
    void track(
      {
        event_name: EventName.QueryFailed,
        outcome: 'failed',
        duration_ms: durationMs,
        query_id: id,
        error_class: failure.kind,
        payload: {
          auth_path: 'datahub',
          named_query: true,
          raw_code: failure.raw_code,
        },
      },
      options.dataDirOverride,
    );
    return failure;
  } catch (err) {
    const durationMs = Date.now() - t0;
    let failure: DataQueryFailure;
    if (err instanceof DatahubNetworkError) {
      failure = {
        ok: false,
        kind: 'host_unreachable',
        message: err.message,
        friendly:
          'The MixShift auth service is unreachable. Check your network ' +
          'or try again in a minute.',
        durationMs,
      };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      failure = { ok: false, kind: 'unknown', message, friendly: message, durationMs };
    }
    void track(
      {
        event_name: EventName.QueryFailed,
        outcome: 'failed',
        duration_ms: durationMs,
        query_id: id,
        error_class: failure.kind,
        payload: { auth_path: 'datahub', named_query: true },
      },
      options.dataDirOverride,
    );
    return failure;
  }
}

class DatahubNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'DatahubNetworkError';
  }
}

// Note: an earlier row-by-row streaming variant using mysql2's .stream() API
// was removed (it required the callback connection). Streaming is now done a
// PAGE at a time via `streamQuery` + `paginateOverCap({ onPage })`: each capped
// page is handed to the sink and dropped, so `--out` delivery never holds the
// whole result set in memory. This works uniformly across the datahub and
// mysql backends because it rides the same cap-aware pagination path.

// -----------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------

function classify(err: unknown): DataQueryFailure {
  const e = err as { code?: string; errno?: number; message?: string; sqlMessage?: string };
  const message = e.sqlMessage ?? e.message ?? String(err);
  const code = e.code;

  if (code === 'ER_TABLEACCESS_DENIED_ERROR') {
    const tableName = extractTableFromAccessDenied(message);
    return {
      ok: false,
      kind: 'access_denied_table',
      table_name: tableName,
      raw_code: code,
      message,
      friendly:
        tableName
          ? `Your MySQL user does not have SELECT permission on \`${tableName}\`. ` +
            `Send a table-access request to MixShift ops to be granted access.`
          : `Your MySQL user does not have SELECT permission on a table referenced in this query.`,
    };
  }
  if (code === 'ER_DBACCESS_DENIED_ERROR' || code === 'ER_ACCESS_DENIED_ERROR') {
    return {
      ok: false,
      kind: 'access_denied_db',
      raw_code: code,
      message,
      friendly:
        'Your MySQL user is not authorized for this database. ' +
        'Re-run `mixshift auth setup` to fix the credentials, or contact MixShift ops.',
    };
  }
  if (code === 'ER_NO_SUCH_TABLE') {
    const tableName = extractTableFromNoSuchTable(message);
    return {
      ok: false,
      kind: 'unknown_table',
      table_name: tableName,
      raw_code: code,
      message,
      friendly: tableName
        ? `Table \`${tableName}\` does not exist in the warehouse. Run \`mixshift data list-tables\` to see what's available.`
        : `One of the tables in this query does not exist. Run \`mixshift data list-tables\` to see available tables.`,
    };
  }
  if (code === 'ER_PARSE_ERROR' || code === 'ER_BAD_FIELD_ERROR') {
    return {
      ok: false,
      kind: 'syntax_error',
      raw_code: code,
      message,
      friendly: `SQL error: ${message}`,
    };
  }
  if (code === 'ER_QUERY_TIMEOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || /max_execution_time/i.test(message)) {
    return {
      ok: false,
      kind: 'timeout',
      raw_code: code,
      message,
      friendly:
        'Query exceeded the 60s timeout. Try narrowing the date range or filtering by seller_id.',
    };
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return {
      ok: false,
      kind: 'host_unreachable',
      raw_code: code,
      message,
      friendly: 'Could not reach the warehouse host. Check your network.',
    };
  }
  return {
    ok: false,
    kind: 'unknown',
    raw_code: code,
    message,
    friendly: `Query failed: ${message}`,
  };
}

function extractTableFromAccessDenied(message: string): string | undefined {
  // MySQL message: "SELECT command denied to user 'foo'@'1.2.3.4' for table 'bar'"
  const m = /for table '([^']+)'/.exec(message);
  return m?.[1];
}

function extractTableFromNoSuchTable(message: string): string | undefined {
  // "Table 'db.table' doesn't exist"
  const m = /Table '([^']+)' doesn't exist/.exec(message);
  if (!m) return undefined;
  const full = m[1]!;
  return full.includes('.') ? full.split('.').pop() : full;
}

async function resolveCreds(
  options: RunQueryOptions,
): Promise<MysqlCreds | DatahubCreds> {
  if (options.creds) return options.creds;
  const { credentials } = await loadCredentials(options.dataDirOverride);
  // Prefer datahub when both blocks exist (the rollout pattern: legacy
  // mysql stays around as a fallback for the same install, but new
  // logins are token-based).
  if (credentials?.datahub) return credentials.datahub;
  // Service (machine) credential: same token-based query path as datahub.
  // Only api_base is consumed here; the Bearer comes from
  // getValidAccessToken, which handles the client_credentials mint.
  if (credentials?.service) {
    return { api_base: credentials.service.api_base, access_token: 'service' } as DatahubCreds;
  }
  if (credentials?.mysql) return credentials.mysql;
  throw new Error(
    'No credentials configured. Run `mixshift auth login` (recommended), ' +
      '`mixshift auth service-setup` for unattended runs, ' +
      'or `mixshift auth setup` for the legacy path.',
  );
}
