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
import { loadCredentials } from '../auth/credentials.js';
import type { MysqlCreds } from '../auth/schema.js';

export type DataQueryFailureKind =
  | 'access_denied_table'
  | 'access_denied_db'
  | 'unknown_table'
  | 'syntax_error'
  | 'timeout'
  | 'host_unreachable'
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
  creds?: MysqlCreds;
  dataDirOverride?: string;
  /** Statement timeout. Defaults to 60s (Sam's call). */
  queryTimeoutMs?: number;
  /** Connection timeout. Defaults to 10s. */
  connectTimeoutMs?: number;
}

export async function runQuery<Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] | Record<string, unknown> = [],
  options: RunQueryOptions = {},
): Promise<DataQueryResult<Row>> {
  const t0 = Date.now();
  let conn: mysql.Connection | undefined;
  try {
    const creds = await resolveCreds(options);

    // If params is an object (not an array), flip on mysql2's
    // namedPlaceholders mode so `:name` in SQL gets bound to params[name].
    // Lists are inlined upstream (see lib/prefetch/substitute.ts), so we
    // never need positional-mode array expansion here.
    const useNamed = !Array.isArray(params) && params !== null && typeof params === 'object';

    conn = await mysql.createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.database,
      connectTimeout: options.connectTimeoutMs ?? 10_000,
      namedPlaceholders: useNamed,
    });
    // Statement-level timeout via SET so it applies to this query only.
    const timeoutMs = options.queryTimeoutMs ?? 60_000;
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ?`, [timeoutMs]);

    // mysql2's QueryValues type doesn't model object-form params even when
    // namedPlaceholders is on. Cast through unknown — the runtime accepts
    // either shape, and we've already verified the shape above.
    const [rows] = await conn.query<RowDataPacket[]>(
      sql,
      params as unknown as unknown[],
    );
    return {
      ok: true,
      rows: rows as unknown as Row[],
      rowCount: rows.length,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return classify(err);
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

async function resolveCreds(options: RunQueryOptions): Promise<MysqlCreds> {
  if (options.creds) return options.creds;
  const { credentials } = await loadCredentials(options.dataDirOverride);
  if (!credentials || !credentials.mysql) {
    throw new Error('No MySQL credentials configured. Run `mixshift auth setup` first.');
  }
  return credentials.mysql;
}
