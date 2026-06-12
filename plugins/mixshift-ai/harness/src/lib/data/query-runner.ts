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
 *     sample/preview where N is bounded.
 *   - `streamQuery` — pass each row through a callback as it arrives.
 *     Use for exports where N could be 100K+ rows.
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
  // the request failed the entry's seller-scope or param spec.
  | 'unknown_query'
  | 'bad_params'
  | 'unknown';

export interface DataQuerySuccess<Row> {
  ok: true;
  rows: Row[];
  rowCount: number;
  durationMs: number;
}

export interface DataQueryFailure {
  ok: false;
  kind: DataQueryFailureKind;
  table_name?: string;
  raw_code?: string;
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

export async function runQuery<Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] | Record<string, unknown> = [],
  options: RunQueryOptions & RunQueryTelemetry = {},
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
          },
        },
        options.dataDirOverride,
      );
      return { ok: true, rows, rowCount, durationMs: serverDuration };
    }

    const failure: DataQueryFailure = {
      ok: false,
      kind: (json.kind ?? 'unknown') as DataQueryFailureKind,
      table_name: json.table_name,
      raw_code: json.raw_code,
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

// Note: a row-by-row streaming variant lived here but was buggy under
// mysql2/promise (the .stream() API requires the callback connection).
// For exports under ~100K rows the buffered runQuery is fine; switch to
// true streaming when we see real users pulling million-row datasets.

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
