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
import { intentHeader } from '../auth/intent.js';
import { track, EventName } from '../telemetry/index.js';
import { networkErrorMessage } from '../net/classify.js';
import { resolveApiBaseHost } from '../net/api-base.js';

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
  /** Named-query pack only, on SUCCESS: the sorted param NAMES this
   *  execution actually bound (mx-legacy-auth PR #107, gateway
   *  `applied_params`). Entry param schemas are non-strict, so an optional
   *  filter key the deployed entry doesn't declare is silently STRIPPED —
   *  this is the only way to tell "my filter was honored" from "my filter
   *  was dropped by an older deploy" from the response alone. A caller that
   *  sent an optional filter param must check it appears here before
   *  describing the result as filtered (see lib/binding/lens.ts's
   *  reconcileLensDecision, the sub-brand label lens's evidence step).
   *  Undefined when the executing gateway predates the field (treat as
   *  "unproven", never as "applied") or for raw-SQL / mysql paths, which
   *  carry no such contract. */
  appliedParams?: string[];
  /** Set by the pager ONLY when a multi-page result had to fall back to a
   *  positional (`ORDER BY 1..N`) output order because the user's ORDER BY
   *  could not be reliably carried to the outer paging query. The delivered
   *  ROW SET is still exactly correct (the user's top-N); only the row ORDER
   *  in the output differs from the user's ORDER BY. Callers surface this in a
   *  user-facing note. Undefined for single-shot results (whose order is
   *  exactly what the server returned) and for paged results whose user order
   *  was preserved. */
  outputOrderPositional?: boolean;
  /** Set by the pager when a CAPPED result (the user carried a bare `LIMIT N`)
   *  ALSO has a top-level user `ORDER BY`. The delivered top-N is exactly the
   *  rows the server returns, but rows that TIE at the Nth position under a
   *  non-total ORDER BY can differ between runs. That boundary nondeterminism
   *  is inherent to `ORDER BY ... LIMIT N` (it exists without pagination too);
   *  we do NOT rewrite the user's statement, only surface an honest note.
   *  Undefined when the result is not capped or carries no user ORDER BY. */
  boundaryTiesMayVary?: boolean;
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
  /** Gateway cap-rejection size hints (typed fields the service now returns on
   *  `too_many_rows` / `response_too_large`). Let the pager size its first page
   *  directly from the real serialized width instead of binary-searching it.
   *  Undefined when the service predates the fields, so the pager falls back to
   *  its FIRST_PAGE_PROBE_ROWS probe. */
  actualRowCount?: number;
  actualBytes?: number;
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
  /** Normalized shape of the USER's query (table + SELECT-* + projected-col
   *  count), computed ONCE from the original statement at the runQuery /
   *  streamQuery entry point and threaded through so the per-page telemetry emit
   *  reflects the user-level shape, not the pager's wrapped page SQL. Callers
   *  normally leave this unset and let runQuery/streamQuery derive it. */
  query_shape?: QueryShape;
}

/**
 * Normalized, PII-free shape of a user query, stamped onto QueryExecuted /
 * QueryFailed telemetry so a pack-candidate report can group by table +
 * SELECT-* without regex-parsing raw SQL after the fact. Table name +
 * booleans/counts only. Library queries are identified by `query_id` and never
 * include SQL text in telemetry because their executed statement may contain
 * resolved list parameters.
 */
export interface QueryShape {
  /** Primary table in the outer query's FROM clause (lowercased, schema
   *  qualifier dropped). null when not confidently extractable (subquery in
   *  FROM, no FROM, or an unparseable reference). */
  table: string | null;
  /** True when the user's top-level projection is `SELECT *` (or `SELECT t.*`). */
  select_star: boolean;
  /** Count of top-level projected columns when NOT select_star (best-effort);
   *  null when select_star or when the projection cannot be determined. */
  projected_cols: number | null;
}

/** How many times a PRE-RESPONSE network failure (DNS, TLS, connection
 *  refused, connect timeout, socket hang-up) is replayed against the gateway
 *  before it surfaces to the caller. Deliberately small: this exists to ride
 *  out a single bad connect, not to paper over a service that is genuinely
 *  down — two extra attempts, then the caller's fail-loud path takes over.
 *  A request that DID reach the service and blew its time budget is never
 *  replayed (see DatahubNetworkError.retryable). */
export const TRANSIENT_NETWORK_RETRIES = 2;
/** Backoff before each replay, indexed by attempt number. Short, because the
 *  failure being ridden out is usually a ~10s connect timeout that has
 *  already cost the user that long. */
export const TRANSIENT_RETRY_BACKOFF_MS = [250, 1_000];

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

/**
 * Ad-hoc queries retain the beta's documented normalized-SQL telemetry.
 * Library queries never do: list parameters are substituted into their SQL
 * before execution, so recording that statement would leak resolved values
 * despite the presence of a stable query id.
 */
function querySqlTelemetry(
  sql: string,
  queryId: string | undefined,
): { sql_normalized?: string } {
  if (queryId) return {};
  return {
    sql_normalized: sql.length > 2000 ? `${sql.slice(0, 2000)}...` : sql,
  };
}

/**
 * Educational user-facing message for the datahub gateway's two output-size
 * caps. These arrive as the failure envelope's `kind` from POST /api/query:
 *   - 'too_many_rows'      the 50k-row cap
 *   - 'response_too_large' the 10 MB byte cap
 * They are server-side values NOT in DataQueryFailureKind's client union, and
 * telemetry buckets on them verbatim, so this ONLY improves the human-readable
 * `friendly` text and never touches `kind`. For every other kind it returns the
 * server's friendly unchanged. Copy rule: no em dashes (customer-facing).
 */
export function capFriendlyMessage(kind: string, serverFriendly: string): string {
  if (kind === 'too_many_rows') {
    return (
      'This query returns more than the 50,000-row service cap. ' +
      'To pull it, narrow the result: select only the columns you need instead ' +
      'of SELECT * on a wide table, add or lower a LIMIT, or stream the full ' +
      'result to a file with --out (which pages past the cap for you).'
    );
  }
  if (kind === 'response_too_large') {
    return (
      "This query's result is over the 10 MB service cap. " +
      'To pull it, trim the result: select only the columns you need instead of ' +
      'SELECT * on a wide table, add or lower a LIMIT, or stream the full result ' +
      'to a file with --out (which pages past the cap for you).'
    );
  }
  return serverFriendly;
}

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
 * otherwise fail outright and starve downstream skills. The user's FULL
 * statement (ORDER BY + LIMIT included) becomes the inner derived table, so the
 * delivered ROW SET is always exactly what the user asked for — a ranked
 * `ORDER BY spend DESC LIMIT N` yields the true top-N. We page over that
 * derived table with a deterministic outer order (the user's ORDER BY when it
 * can be carried, else positional `ORDER BY 1..N`) so OFFSET windows neither
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
  const opts = withQueryShape(sql, options);
  const first = await runOnce<Row>(sql, params, opts);
  if (!isServiceCapFailure(first)) return first;
  return paginateOverCap<Row>(
    sql,
    (pageSql) => runOnce<Row>(pageSql, params, opts),
    { sizeHint: sizeHintFromFailure(first) },
  );
}

/** Extract the gateway's cap-rejection size hint (Track B) from the first
 *  (cap-failing) response, so the pager can size its first page from the real
 *  serialized width. Returns undefined when neither field is present (older
 *  service deploy) — the pager then probes as before. */
function sizeHintFromFailure(
  first: DataQueryResult<unknown>,
): { rowCount?: number; bytes?: number } | undefined {
  if (first.ok) return undefined;
  const { actualRowCount, actualBytes } = first;
  if (actualRowCount === undefined && actualBytes === undefined) return undefined;
  return { rowCount: actualRowCount, bytes: actualBytes };
}

/**
 * Attach the user query's normalized `query_shape` to the telemetry options if a
 * caller didn't already supply one. Derived ONCE here from the user's ORIGINAL
 * `sql`; the same object is threaded to every per-page emit inside
 * paginateOverCap, so a paged query reports the user-level shape (its real
 * table + SELECT-*) rather than the pager's wrapped `_mx_page` page SQL.
 */
function withQueryShape<T extends RunQueryOptions & RunQueryTelemetry>(
  sql: string,
  options: T,
): T {
  if (options.query_shape !== undefined) return options;
  return { ...options, query_shape: deriveQueryShape(sql) };
}

export interface StreamedQueryResult {
  ok: boolean;
  rowCount: number;
  durationMs: number;
  /** True when the result exceeded a single-request cap and was paged. A
   *  single-shot result (fits under both caps) reports false. */
  paginated: boolean;
  /** True only for a PAGED result whose output row order fell back to
   *  positional (`ORDER BY 1..N`) because the user's ORDER BY could not be
   *  carried to the outer paging query. The ROW SET is still exactly correct;
   *  only the ordering differs. Callers surface this in a user-facing note. */
  outputOrderPositional?: boolean;
  /** True only for a PAGED, CAPPED result (user bare `LIMIT N`) that ALSO has a
   *  top-level user ORDER BY: rows tied exactly at the Nth position may differ
   *  between runs (inherent to `ORDER BY ... LIMIT`, not the paging). Callers
   *  surface an honest boundary-ties note. */
  boundaryTiesMayVary?: boolean;
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
  const opts = withQueryShape(sql, options);
  const first = await runOnce<Row>(sql, params, opts);
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
    (pageSql) => runOnce<Row>(pageSql, params, opts),
    { onPage, sizeHint: sizeHintFromFailure(first) },
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
    outputOrderPositional: paged.outputOrderPositional,
    boundaryTiesMayVary: paged.boundaryTiesMayVary,
  };
}

export interface PaginateOptions<Row> {
  /** Stream each non-empty page as it arrives instead of buffering. When set,
   *  rows are NOT retained in memory and the returned `rows` array is empty
   *  (read `rowCount` for the total delivered). */
  onPage?: (rows: Row[], pageIndex: number) => void | Promise<void>;
  /** Hard cap on total rows DELIVERED by the pager, independent of any user
   *  LIMIT (which is enforced inside the derived table). A bounded result — a
   *  caller maxRows OR a user LIMIT — opts out of the MAX_PAGINATED_ROWS
   *  ceiling (the request is explicitly finite). */
  maxRows?: number;
  /** Cap-rejection size hint from the gateway (Track B): the whole result's
   *  serialized `bytes` and `rowCount`. When both are present, the FIRST page is
   *  sized directly from the real bytes/row instead of starting at
   *  FIRST_PAGE_PROBE_ROWS and halving on a wide `SELECT *`, which cost ~log2(N)
   *  wasted round-trips (each a `query.failed` emit). Absent → probe as before. */
  sizeHint?: { rowCount?: number; bytes?: number };
}

/** Result of statically analyzing the top-level SELECT before paging. */
interface OuterAnalysis {
  /** The user's FULL statement, trimmed and with a trailing semicolon removed
   *  and NOTHING stripped. This (ORDER BY + LIMIT included) becomes the inner
   *  derived table, so the materialized ROW SET is exactly what the user's
   *  query specifies — a ranked `ORDER BY x DESC LIMIT N` yields the true
   *  top-N, and the LIMIT makes OFFSET paging stop at N on a short page. */
  innerSql: string;
  /** `innerSql` with only the statement-final LIMIT/OFFSET removed, used solely
   *  to locate the user's trailing ORDER BY for output-order preservation. */
  sqlWithoutLimit: string;
  /** True when the statement carries an explicit statement-final LIMIT. The
   *  result is then BOUNDED (the user asked for exactly that many rows) and
   *  opts out of the MAX_PAGINATED_ROWS safety ceiling. This flag governs the
   *  unbounded ceiling; whether the LIMIT is stripped is decided separately (see
   *  `bareLimitRowCap` + the no-ORDER-BY branch in paginateOverCap). */
  hasLimit: boolean;
  /** True when the statement has a TOP-LEVEL (depth-0) `ORDER BY`. Governs the
   *  pagination strategy: a statement with a user ORDER BY keeps its LIMIT inside
   *  the derived table (true top-N); one WITHOUT a top-level ORDER BY but with a
   *  bare `LIMIT N` has that LIMIT stripped and paged under a positional total
   *  order instead (see paginateOverCap). */
  hasOrderBy: boolean;
  /** The row count N of a BARE statement-final `LIMIT N` — a single integer with
   *  no OFFSET and no `off, count` comma form. Undefined for the offset-bearing
   *  forms (whose window a positional page-from-0 cannot reproduce) and when
   *  there is no LIMIT. Only consumed for the no-ORDER-BY branch, where N becomes
   *  a hard row cap after the LIMIT is stripped from the inner query. */
  bareLimitRowCap?: number;
}

/**
 * True when `sql` has a TOP-LEVEL (depth-0) `ORDER BY`. Parenthesis depth and
 * string/identifier quoting are tracked so a subquery's or window function's
 * `ORDER BY` (always nested inside parens, e.g. `(SELECT ... ORDER BY x)` or
 * `OVER (ORDER BY x)`) is never mistaken for a statement-level one. A CTE's
 * inner ORDER BY is likewise parenthesized and ignored. Used to choose the
 * pagination strategy in paginateOverCap.
 */
function hasTopLevelOrderBy(sql: string): boolean {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      // Backslash escapes apply inside string literals, not backtick identifiers.
      if ((quote === "'" || quote === '"') && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    // Skip line comments (`-- ...` to end of line): a comment containing the
    // words "ORDER BY" must never be mistaken for a real clause.
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    // Skip block comments (`/* ... */`), same reason.
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && (ch === 'o' || ch === 'O')) {
      const prev = i > 0 ? sql[i - 1]! : ' ';
      if (!/[\w$]/.test(prev) && /^order\s+by\b/i.test(sql.slice(i))) return true;
    }
  }
  return false;
}

/**
 * Statically analyze a SELECT for pagination. Detects the statement-final
 * `LIMIT`/`OFFSET` (both MySQL forms) to know whether the result is BOUNDED and
 * whether it is a bare `LIMIT N`, and detects a top-level `ORDER BY`. Trailing
 * position guarantees the LIMIT match is top-level: a subquery's LIMIT is always
 * followed by a closing paren or more SQL, never the end of the string. Only
 * integer-literal LIMITs are detected; a parameterized `LIMIT ?` is treated as
 * no explicit limit (rare on this raw-SQL path).
 */
function analyzeOuterQuery(sql: string): OuterAnalysis {
  const innerSql = sql.trim().replace(/;\s*$/, '');
  // MySQL forms: `LIMIT count [OFFSET off]` and `LIMIT off, count`.
  const m = /\blimit\s+(\d+)(?:\s*,\s*(\d+))?(?:\s+offset\s+(\d+))?\s*$/i.exec(innerSql);
  if (!m) {
    return {
      innerSql,
      sqlWithoutLimit: innerSql,
      hasLimit: false,
      hasOrderBy: hasTopLevelOrderBy(innerSql),
    };
  }
  const sqlWithoutLimit = innerSql.slice(0, m.index).trimEnd();
  // Only a bare `LIMIT N` (single count, no `off, count` comma form m[2], no
  // `OFFSET off` m[3]) converts to a hard row cap in the no-ORDER-BY branch: the
  // offset-bearing forms carry a skip whose window a positional page-from-0
  // cannot reproduce, so they keep the user's LIMIT inside the derived table.
  const bareLimitRowCap =
    m[2] === undefined && m[3] === undefined ? Number(m[1]) : undefined;
  return {
    innerSql,
    sqlWithoutLimit,
    hasLimit: true,
    hasOrderBy: hasTopLevelOrderBy(sqlWithoutLimit),
    bareLimitRowCap,
  };
}

/**
 * Derive the deterministic OUTER `ORDER BY` for paging over the derived table.
 *
 * The correct ROW SET is already guaranteed by keeping the user's LIMIT inside
 * the derived table; the outer order only decides (a) that OFFSET windows are
 * stable and (b) the row order in the OUTPUT. We PREFER to preserve the user's
 * ordering in the output: if the trailing `ORDER BY` is a simple list of column
 * references (or positional integers), each term is mapped to its 1-based
 * OUTPUT column position — positional references are unambiguous over a derived
 * table even when two output columns share a name — and emitted first, followed
 * by every column position as deterministic tiebreakers. If the ORDER BY cannot
 * be reliably parsed and mapped (an expression, a function, a non-output
 * column, or any parenthesis in the clause), we fall back to a purely positional
 * `ORDER BY 1..N`: the ROW SET is still exactly correct — only the output order
 * differs from the user's intent, which callers flag in a user-facing note.
 *
 * `columns` are the output column names in order (from the probe row).
 */
function deriveOuterOrder(
  sqlWithoutLimit: string,
  columns: string[],
): { orderBy: string; userOrderPreserved: boolean } {
  const positional = columns.map((_, i) => String(i + 1));
  const fallback = { orderBy: positional.join(', '), userOrderPreserved: false };

  // Trailing `ORDER BY <list>` with NO parenthesis in the clause — the paren
  // exclusion both keeps the match from swallowing a subquery's `)` and rejects
  // expression/function order terms we would not carry anyway.
  const m = /\border\s+by\s+([^()]+?)\s*$/i.exec(sqlWithoutLimit);
  if (!m) return fallback;

  const terms = m[1]!.split(',').map((t) => t.trim()).filter(Boolean);
  if (terms.length === 0) return fallback;

  const mapped: string[] = [];
  for (const term of terms) {
    // A simple term: optional `table.` qualifier, an identifier (or integer),
    // an optional ASC/DESC. Anything else → positional fallback.
    const tm = /^(?:`?[\w$]+`?\.)?`?([\w$]+)`?(?:\s+(asc|desc))?$/i.exec(term);
    if (!tm) return fallback;
    const ident = tm[1]!;
    const dir = tm[2] ? ` ${tm[2].toUpperCase()}` : '';
    let pos: number;
    if (/^\d+$/.test(ident)) {
      pos = Number(ident);
      if (pos < 1 || pos > columns.length) return fallback;
    } else {
      const idx = columns.findIndex((c) => c.toLowerCase() === ident.toLowerCase());
      if (idx < 0) return fallback;
      pos = idx + 1;
    }
    mapped.push(`${pos}${dir}`);
  }
  // User order (as positions) first, then all positions as total-order tiebreak.
  return { orderBy: [...mapped, ...positional].join(', '), userOrderPreserved: true };
}

/**
 * Page a cap-exceeding SELECT through repeated LIMIT/OFFSET windows. `exec`
 * runs one already-param-bound statement (LIMIT/OFFSET are inlined integers,
 * so the original `?`/`:name` params bind unchanged per page). Exported for
 * unit testing. Non-SELECT statements can't be wrapped — but they don't return
 * rows, so they never hit the cap.
 *
 * Correctness turns on whether the user statement has a TOP-LEVEL ORDER BY:
 *
 *   - HAS a user ORDER BY: the user's FULL statement (ORDER BY + LIMIT) is the
 *     inner derived table, so the materialized set is exactly what the query
 *     specifies — a ranked `ORDER BY spend DESC LIMIT N` materializes the true
 *     top-N by spend, and the inner LIMIT makes OFFSET paging stop at N on a
 *     short page (the "hard cap" is honored for free). The outer paging order
 *     is the user's ORDER BY when it can be safely carried (output rows match
 *     intent), else positional `ORDER BY 1..N` (still a correct SET, only the
 *     row order differs — surfaced via `outputOrderPositional`).
 *
 *   - NO user ORDER BY, but a bare `LIMIT N` (e.g. `data export --max-rows N`,
 *     whose SQL is `SELECT * FROM t WHERE ... LIMIT N`): keeping that `LIMIT N`
 *     inside the derived table is NOT safe. With no ORDER BY, MySQL may pick a
 *     DIFFERENT arbitrary N-row set each time the derived table is materialized,
 *     so OFFSET windows over it skip/duplicate rows and the delivered file
 *     silently loses rows. Because there is no ordering to disturb, we STRIP the
 *     trailing LIMIT, page the UNLIMITED inner query under the positional total
 *     order `ORDER BY 1..N`, and honor N as a hard row cap. The positional total
 *     order fixes which rows fall in [0,N), so the delivered set is
 *     deterministic and complete across page re-executions.
 *
 * Boundary ties: a user `ORDER BY x LIMIT N` whose order is non-total can return
 * different rows AT the Nth position between runs. That is the user's own query
 * nondeterminism (it exists without pagination); we do not rewrite their
 * statement, and surface it via `boundaryTiesMayVary` for an honest caller note.
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
  const { innerSql, sqlWithoutLimit, hasLimit, hasOrderBy, bareLimitRowCap } =
    analyzeOuterQuery(sql);
  if (!/^\s*(select|with)\b/i.test(innerSql)) {
    const message =
      'Result exceeds the 50,000-row service cap and the statement is not a ' +
      'SELECT, so it cannot be paginated. Narrow the query.';
    return { ok: false, kind: 'unknown', message, friendly: message, durationMs: Date.now() - t0 };
  }

  // Choose the inner query to page. With NO top-level user ORDER BY but a bare
  // `LIMIT N`, page the LIMIT-STRIPPED query under the positional total order and
  // convert N to a hard row cap — keeping the LIMIT inside would let MySQL pick a
  // different arbitrary N-row set per page re-execution and skip/duplicate rows.
  // With a user ORDER BY, keep the full statement (LIMIT inside) so the derived
  // table materializes the true top-N (verified-correct path, unchanged).
  const stripBareLimit = !hasOrderBy && bareLimitRowCap !== undefined;
  const pageInner = stripBareLimit ? sqlWithoutLimit : innerSql;
  const limitRowCap = stripBareLimit ? bareLimitRowCap : undefined;

  // Probe the output columns off the query we will actually page.
  const probe = await exec(`SELECT * FROM (${pageInner}) AS _mx_page LIMIT 1`);
  if (!probe.ok) return probe;
  const columns = probe.rows.length
    ? Object.keys(probe.rows[0] as Record<string, unknown>)
    : [];
  if (columns.length === 0) {
    return { ok: true, rows: [], rowCount: 0, durationMs: Date.now() - t0 };
  }
  const { orderBy, userOrderPreserved } = deriveOuterOrder(sqlWithoutLimit, columns);
  const outputOrderPositional = !userOrderPreserved;
  // A CAPPED result (a user bare `LIMIT N`) that ALSO carries a top-level user
  // ORDER BY has the user's own boundary nondeterminism: rows tied at the Nth
  // position under a non-total ORDER BY can vary between runs. Not applicable
  // once the bare LIMIT is stripped (positional total order is tie-free) or when
  // there is no LIMIT.
  const boundaryTiesMayVary = hasOrderBy && hasLimit;

  // The pager's OWN row cap. For a user ORDER BY, the user's LIMIT is NOT applied
  // here — it lives inside the derived table and self-terminates via a short
  // page. For the stripped no-ORDER-BY case, the user's N becomes this hard cap.
  // A caller maxRows OR a user LIMIT makes the result BOUNDED → skip the
  // MAX_PAGINATED_ROWS safety ceiling.
  const callerMax = opts.maxRows ?? Infinity;
  const maxRows = Math.min(callerMax, limitRowCap ?? Infinity);
  const bounded = hasLimit || Number.isFinite(callerMax);

  const all: Row[] = [];
  // Byte budget: start conservative to measure the real serialized row width,
  // then size the next page as clamp(floor(PAGE_BYTE_BUDGET / bytesPerRow), 1,
  // PAGE_MAX_ROWS). Ultra-wide rows drive the page far below 1000 — there is no
  // floor (the old 1000-row floor is exactly what made wide SELECT * fail).
  //
  // When the gateway's cap rejection carried a size hint (Track B), size the
  // FIRST page from the real bytes/row up front instead of starting at
  // FIRST_PAGE_PROBE_ROWS and halving down on a wide result — that halving cost
  // ~log2(N) failed round-trips. The per-page re-measure + shrink-retry below
  // still correct any estimate error, so a stale/rough hint is never unsafe.
  let pageSize = FIRST_PAGE_PROBE_ROWS;
  const hint = opts.sizeHint;
  if (hint?.bytes && hint.bytes > 0 && hint.rowCount && hint.rowCount > 0) {
    const bytesPerRow = Math.max(1, Math.ceil(hint.bytes / hint.rowCount));
    pageSize = Math.max(1, Math.min(PAGE_MAX_ROWS, Math.floor(PAGE_BYTE_BUDGET / bytesPerRow)));
  }
  // Outer OFFSET always starts at 0: any user OFFSET is already applied inside
  // the derived table, so re-applying it here would double-skip.
  let offset = 0;
  let delivered = 0;
  let pageIndex = 0;
  // `completed` distinguishes a legitimate finish (short page or maxRows cap
  // reached) from exhausting the iteration guard without converging.
  let completed = false;
  for (let iter = 0; iter < 100_000; iter++) {
    const remaining = maxRows - delivered;
    if (remaining <= 0) {
      // Reached the caller's maxRows cap exactly — the requested set is done.
      completed = true;
      break;
    }
    const cap = Number.isFinite(maxRows) ? Math.min(PAGE_MAX_ROWS, remaining) : PAGE_MAX_ROWS;
    const requestSize = Math.max(1, Math.min(pageSize, cap));
    const r = await exec(
      `SELECT * FROM (${pageInner}) AS _mx_page ORDER BY ${orderBy} ` +
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
    // Observe the serialized width of this page to size the NEXT one, estimating
    // bytes/row from a small SAMPLE rather than the whole page: serializing a
    // full 50k-row page every iteration just to measure it would build a ~50 MB
    // string and defeat the point of streaming. Up to 100 rows gives an accurate
    // average at negligible cost; the 2 MB headroom under the 10 MB cap plus the
    // shrink-retry above absorb any sampling error.
    if (r.rows.length > 0) {
      const sampleSize = Math.min(r.rows.length, 100);
      const sampleBytes = Buffer.byteLength(JSON.stringify(r.rows.slice(0, sampleSize)), 'utf8');
      const bytesPerRow = Math.max(1, Math.ceil(sampleBytes / sampleSize));
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
      completed = true;
      break;
    }
    if (!bounded && delivered >= MAX_PAGINATED_ROWS) {
      const m =
        `Result exceeds ${MAX_PAGINATED_ROWS} rows even after pagination; ` +
        `narrow the query (add a WHERE filter, aggregate, or pass an explicit LIMIT).`;
      return { ok: false, kind: 'unknown', message: m, friendly: m, durationMs: Date.now() - t0 };
    }
  }
  if (!completed) {
    // Fell out of the loop by exhausting the iteration guard WITHOUT reaching a
    // short page or the maxRows cap — the query did not converge (pathological:
    // pages never shrink to a short final page). Fail rather than silently
    // returning a truncated tail as if it were the complete result.
    const m =
      'Pagination did not converge (exceeded the internal iteration limit); ' +
      'narrow the query (add a WHERE filter, aggregate, or pass an explicit LIMIT).';
    return { ok: false, kind: 'unknown', message: m, friendly: m, durationMs: Date.now() - t0 };
  }
  return {
    ok: true,
    rows: all,
    rowCount: delivered,
    durationMs: Date.now() - t0,
    outputOrderPositional,
    boundaryTiesMayVary,
  };
}

// ---------------------------------------------------------------------------
// Query-shape derivation (PII-free telemetry enrichment)
// ---------------------------------------------------------------------------

/**
 * Derive a normalized, PII-free {@link QueryShape} from a SQL statement so
 * telemetry can group by table + SELECT-* without regex-parsing raw SQL later.
 *
 * Tolerant, dependency-free tokenizer (NOT a SQL parser). It:
 *   - skips `--` line and `/* *\/` block comments (mirrors hasTopLevelOrderBy);
 *   - UNWRAPS the pager's `SELECT * FROM (<inner>) AS _mx_page ...` wrapper and
 *     analyzes the INNER user SQL — a belt-and-suspenders guard so even a shape
 *     derived from a wrapped page reports the user's real table, not `_mx_page`
 *     (the primary defense is threading the shape from the user SQL entry point);
 *   - treats a leading CTE (`WITH x AS (...) SELECT ... FROM t`) correctly: the
 *     CTE bodies are parenthesized (depth > 0), so the first depth-0 SELECT is
 *     the OUTER query and its FROM is the primary table, not the CTE's. When the
 *     OUTER FROM is itself a CTE alias (`... SELECT * FROM x`), the name is a
 *     query-local binding, not a warehouse table, so `table` is null;
 *   - returns nulls rather than a wrong guess when the FROM is a subquery, is
 *     absent, or the reference cannot be parsed.
 *
 * The `table` is lowercased with any schema qualifier dropped (`db.tbl` → `tbl`)
 * so the warehouse's single-DB rows group cleanly.
 */
export function deriveQueryShape(sql: string): QueryShape {
  const nulls: QueryShape = { table: null, select_star: false, projected_cols: null };
  if (!sql) return nulls;
  const clean = stripSqlComments(sql).trim().replace(/;\s*$/, '').trim();
  if (!clean) return nulls;

  // Pager wrapper → analyze the user's inner SQL instead.
  const inner = unwrapPagerWrapper(clean);
  if (inner !== null) return deriveQueryShape(inner);

  // Outer SELECT (skips parenthesized CTE bodies, which sit at depth > 0).
  const selIdx = firstKeywordAtDepth0(clean, 0, 'select');
  if (selIdx < 0) return nulls;
  const afterSelect = selIdx + 'select'.length;

  const fromIdx = firstKeywordAtDepth0(clean, afterSelect, 'from');
  let projection = (fromIdx < 0 ? clean.slice(afterSelect) : clean.slice(afterSelect, fromIdx)).trim();
  // Drop a leading DISTINCT / ALL quantifier before classifying the projection.
  projection = projection.replace(/^(?:distinct|all)\s+/i, '').trim();

  const selectStar = isStarProjection(projection);
  const projectedCols = selectStar ? null : countTopLevelTerms(projection);

  let table = fromIdx < 0 ? null : parsePrimaryTable(clean, fromIdx + 'from'.length);

  // A leading WITH defines query-local CTE aliases. If the OUTER FROM's primary
  // name is one of them, it is a CTE reference, not a warehouse table — report
  // null (a phantom table pollutes pack-candidate grouping worse than null).
  // Only the outer FROM matters; we never descend into subqueries.
  if (table !== null && /^with\b/i.test(clean)) {
    const cteNames = collectCteNames(clean);
    if (cteNames.includes(table)) table = null;
  }

  return { table, select_star: selectStar, projected_cols: projectedCols };
}

/**
 * Collect the CTE names a leading `WITH` (or `WITH RECURSIVE`) clause defines:
 * the `<name> AS ( ... )` bindings at depth 0, comma-separated. Names are
 * lowercased with backticks stripped, matching `parsePrimaryTable`'s output so
 * an outer-FROM name can be compared case-insensitively. Dependency-free,
 * quote/paren-aware; returns [] when `clean` has no leading WITH. Only the
 * depth-0 WITH bindings are collected — nested CTEs inside a body are ignored.
 */
function collectCteNames(clean: string): string[] {
  const head = /^with\s+(?:recursive\s+)?/i.exec(clean);
  if (!head) return [];
  const names: string[] = [];
  const len = clean.length;
  let i = head[0].length;
  const skipWs = () => {
    while (i < len && /\s/.test(clean[i]!)) i++;
  };
  for (;;) {
    skipWs();
    // CTE name (identifier, optionally backtick-quoted).
    const nameMatch = /^(`[^`]+`|[\w$]+)/.exec(clean.slice(i));
    if (!nameMatch) break;
    const name = nameMatch[1]!.replace(/`/g, '').toLowerCase();
    i += nameMatch[0].length;
    skipWs();
    // Optional explicit column list `(a, b)` before AS.
    if (clean[i] === '(') {
      const close = matchingParen(clean, i);
      if (close < 0) break;
      i = close + 1;
      skipWs();
    }
    // Require `AS` as a whole word, then the parenthesized body.
    if (!/^as\b/i.test(clean.slice(i))) break;
    i += 2;
    skipWs();
    if (clean[i] !== '(') break;
    const bodyClose = matchingParen(clean, i);
    if (bodyClose < 0) break;
    // Record only after confirming a well-formed `name AS ( ... )` binding.
    names.push(name);
    i = bodyClose + 1;
    skipWs();
    if (clean[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return names;
}

/**
 * Return `sql` with `--` and `/* *\/` comments replaced by a space, preserving
 * string literals and backtick identifiers (a comment marker inside a quote is
 * NOT a comment). Same quote/escape rules as hasTopLevelOrderBy.
 */
function stripSqlComments(sql: string): string {
  let out = '';
  let quote: "'" | '"' | '`' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if ((quote === "'" || quote === '"') && ch === '\\') {
        if (i + 1 < sql.length) out += sql[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      out += ' ';
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

/**
 * Find the first `keyword` (a whole word) at parenthesis depth 0, scanning from
 * `start`. Tracks quotes/backticks so a keyword inside a literal or identifier
 * is ignored. Returns the keyword's index, or -1. `sql` is assumed already
 * comment-stripped.
 */
function firstKeywordAtDepth0(sql: string, start: number, keyword: string): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  const kw = keyword.toLowerCase();
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if ((quote === "'" || quote === '"') && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && (ch === kw[0] || ch === kw[0]!.toUpperCase())) {
      const prev = i > 0 ? sql[i - 1]! : ' ';
      const next = sql[i + kw.length];
      if (
        !/[\w$]/.test(prev) &&
        sql.slice(i, i + kw.length).toLowerCase() === kw &&
        (next === undefined || !/[\w$]/.test(next))
      ) {
        return i;
      }
    }
  }
  return -1;
}

/** Index of the `)` matching the `(` at `openIdx`, or -1. Quote-aware. */
function matchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      if ((quote === "'" || quote === '"') && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * If `clean` is the pager's `SELECT * FROM (<inner>) AS _mx_page ...` wrapper,
 * return the inner user SQL; else null. Robust to the exact wrappers this file
 * emits (the `LIMIT 1` probe and the `ORDER BY ... LIMIT ... OFFSET ...` page).
 */
function unwrapPagerWrapper(clean: string): string | null {
  const m = /^select\s+\*\s+from\s*\(/i.exec(clean);
  if (!m) return null;
  const openIdx = m[0].length - 1;
  const closeIdx = matchingParen(clean, openIdx);
  if (closeIdx < 0) return null;
  const after = clean.slice(closeIdx + 1).trim();
  if (!/^as\s+_mx_page\b/i.test(after)) return null;
  return clean.slice(openIdx + 1, closeIdx).trim();
}

/**
 * True when ANY top-level (depth-0) projection term is exactly `*` or
 * `<qualifier>.*` (e.g. `t.*`). This catches the mixed forms `SELECT *, DATE(x)`
 * and `SELECT t.*, y` too: they still pull every column, so they are star
 * projections for pack-candidate grouping — not just a bare `SELECT *`.
 */
function isStarProjection(projection: string): boolean {
  if (!projection) return false;
  return splitTopLevelTerms(projection).some(
    (t) => t === '*' || /^`?[\w$]+`?\s*\.\s*\*$/.test(t),
  );
}

/**
 * Count top-level (depth-0) comma-separated terms in a projection list, so
 * commas inside function calls (`COUNT(a, b)`) or subqueries don't inflate the
 * count. Returns null for an empty projection.
 */
function countTopLevelTerms(projection: string): number | null {
  if (!projection) return null;
  return splitTopLevelTerms(projection).length;
}

/**
 * Split a projection list on depth-0 commas, returning each trimmed term.
 * Commas inside function calls (`COUNT(a, b)`), subqueries, string literals, or
 * backtick identifiers are ignored, so `IFNULL(a, 0)` stays one term. A
 * non-empty projection always yields at least one term.
 */
function splitTopLevelTerms(projection: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let start = 0;
  for (let i = 0; i < projection.length; i++) {
    const ch = projection[i]!;
    if (quote) {
      if ((quote === "'" || quote === '"') && ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      terms.push(projection.slice(start, i).trim());
      start = i + 1;
    }
  }
  terms.push(projection.slice(start).trim());
  return terms;
}

/**
 * Parse the primary table reference immediately after the FROM keyword. Returns
 * the table name (lowercased, backticks stripped, schema qualifier dropped), or
 * null when the FROM opens a subquery `(...)` or the reference can't be parsed.
 */
function parsePrimaryTable(sql: string, fromEnd: number): string | null {
  const rest = sql.slice(fromEnd).replace(/^\s+/, '');
  if (rest.startsWith('(')) return null; // subquery / derived table in FROM
  const m = /^(`[^`]+`|[\w$]+)(?:\s*\.\s*(`[^`]+`|[\w$]+))?/.exec(rest);
  if (!m) return null;
  const raw = (m[2] ?? m[1])!.replace(/`/g, '').trim();
  if (!raw) return null;
  return raw.toLowerCase();
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
          ...querySqlTelemetry(sql, options.query_id),
          query_shape: options.query_shape,
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
          ...querySqlTelemetry(sql, options.query_id),
          table_name: failure.table_name,
          query_shape: options.query_shape,
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
  // Cap-rejection size hints (Track B). Optional: absent on older service deploys.
  actualRowCount?: number;
  actualBytes?: number;
}

/**
 * POST a JSON body to a datahub endpoint with the stored bearer token,
 * force-refreshing and retrying exactly once on a mid-session 401.
 * Throws DatahubNetworkError on network / DNS / TLS failure (callers map
 * it to `host_unreachable`) and a plain Error when the session cannot be
 * refreshed. Shared by the raw-SQL gateway (/api/query) and the named
 * query pack (/api/named-query).
 *
 * A pre-response network failure is replayed up to TRANSIENT_NETWORK_RETRIES
 * times before it surfaces — see the comment on `doFetch` below.
 */
async function datahubAuthedPost(
  creds: DatahubCreds,
  path: string,
  body: Record<string, unknown>,
  timeoutBudgetMs: number,
  dataDirOverride?: string,
): Promise<Response> {
  const doFetchOnce = async (bearer: string): Promise<Response> => {
    try {
      return await fetch(`${creds.api_base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          ...intentHeader(),
        },
        body: JSON.stringify(body),
        // Give the server a small grace window beyond its own timeout so
        // we don't AbortError before it has a chance to return the
        // classified timeout envelope.
        signal: AbortSignal.timeout(timeoutBudgetMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Classify HERE, while `err` still carries the raw fetch failure shape
      // (undici's `.cause` with its `code`/`message`) — DatahubNetworkError
      // below flattens to a plain string, and by the time the two call
      // sites below (runDatahubQuery, runNamedQuery) catch it that shape is
      // gone. `creds.api_base` is the exact host this request targeted.
      const friendly = networkErrorMessage(err, resolveApiBaseHost(creds.api_base));
      // AbortSignal.timeout rejects with a TimeoutError DOMException. That
      // means the service HAD the request and we stopped waiting — a
      // different situation from never reaching it, and not worth replaying.
      const budgetExpired = err instanceof Error && err.name === 'TimeoutError';
      throw new DatahubNetworkError(message, friendly, !budgetExpired);
    }
  };

  /**
   * Replay a pre-response network failure a couple of times before giving up.
   *
   * Both callers here are read-only SELECT paths (`/api/query`,
   * `/api/named-query`), so a replay cannot double-apply anything.
   *
   * Why this exists (mx-ops#6): callers that fan several
   * queries out concurrently open several NEW connections at once, and on a
   * network where each fresh connect is slow one of them can exceed undici's
   * 10s connect timeout and die while its siblings succeed. Gateway metering
   * confirmed the dropped request never arrived. The caller then has a
   * partial result set through no fault of the query. One cheap retry turns
   * that into a completed read; the fail-loud classification downstream is
   * the backstop for when it genuinely cannot be completed.
   */
  const doFetch = async (bearer: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await doFetchOnce(bearer);
      } catch (err) {
        const transient = err instanceof DatahubNetworkError && err.retryable;
        if (!transient || attempt >= TRANSIENT_NETWORK_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_BACKOFF_MS[attempt]));
      }
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
            ...querySqlTelemetry(sql, options.query_id),
            query_shape: options.query_shape,
          },
        },
        options.dataDirOverride,
      );
      return { ok: true, rows, rowCount, durationMs: serverDuration };
    }

    // Failure envelope. `message` stays the raw server text (isServiceCapFailure
    // matches it to trigger pagination); only `friendly` is upgraded to the
    // educational cap guidance for the two output-size caps, and `kind` is kept
    // verbatim so telemetry buckets are unchanged.
    const serverKind = json.kind ?? 'unknown';
    const serverFriendly = json.friendly ?? json.message ?? 'Query failed';
    const failure: DataQueryFailure = {
      ok: false,
      kind: serverKind as DataQueryFailureKind,
      table_name: json.table_name,
      raw_code: json.raw_code,
      message: json.message ?? 'Query failed',
      friendly: capFriendlyMessage(serverKind, serverFriendly),
      durationMs,
      // Cap-rejection size hints (Track B), when the service provides them.
      ...(typeof json.actualRowCount === 'number' ? { actualRowCount: json.actualRowCount } : {}),
      ...(typeof json.actualBytes === 'number' ? { actualBytes: json.actualBytes } : {}),
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
          ...querySqlTelemetry(sql, options.query_id),
          table_name: failure.table_name,
          query_shape: options.query_shape,
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
        // Sandbox-aware + doctor-pointing (classified in datahubAuthedPost,
        // where the raw fetch failure's shape was still intact).
        friendly: err.friendly,
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
          ...querySqlTelemetry(sql, options.query_id),
          query_shape: options.query_shape,
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
  /** Success only: sorted param names the gateway actually bound
   *  (mx-legacy-auth PR #107). See DataQuerySuccess.appliedParams. */
  applied_params?: string[];
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
            applied_params: json.applied_params,
          },
        },
        options.dataDirOverride,
      );
      return {
        ok: true,
        rows,
        rowCount,
        durationMs: serverDuration,
        revision: json.revision,
        appliedParams: json.applied_params,
      };
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
        // Sandbox-aware + doctor-pointing (classified in datahubAuthedPost,
        // where the raw fetch failure's shape was still intact).
        friendly: err.friendly,
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
  /** Sandbox-aware, doctor-pointing text classified from the raw fetch
   *  failure at the point it was thrown (see datahubAuthedPost's doFetch) —
   *  computed there because this class itself only carries a flattened
   *  string message, losing the `.cause` classify.ts needs. */
  readonly friendly: string;
  /** False when the request DID reach the service and we gave up waiting on
   *  its answer (the AbortSignal.timeout budget fired). Retrying that just
   *  spends the budget again on a query the server is already struggling
   *  with, so only genuinely pre-response failures — DNS, TLS, connection
   *  refused, connect timeout, socket hang-up — are replayed.
   *
   *  Defaulted rather than required: every call site that constructs this
   *  for a real fetch failure is pre-response, and defaulting keeps the
   *  friendly-message change (#141) and the replay (mx-ops#6) independent. */
  readonly retryable: boolean;
  constructor(msg: string, friendly: string, retryable = true) {
    super(msg);
    this.name = 'DatahubNetworkError';
    this.friendly = friendly;
    this.retryable = retryable;
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
    // Red-team fix 4: NOT routed through classify.ts's
    // describeFetchFailure/networkErrorMessage, and deliberately NOT
    // pointed at `mixshift doctor` either — `mixshift doctor` only probes
    // the datahub/API host, never the warehouse mysql host, so pointing a
    // warehouse-unreachable user at it would diagnose the wrong thing. A
    // raw mysql2 connection error also carries its `code` directly on the
    // error object over a different transport (a direct TCP connection, not
    // an HTTP fetch through the sandbox egress proxy) — forcing it through
    // the fetch classifier would either fail to match (no `.cause`) or,
    // worse, falsely claim the sandbox-proxy/403 narrative for a failure
    // that never went near it. Accurate, self-contained guidance instead:
    // this fleet's warehouse connections are commonly gated by a VPN or IP
    // allowlist, so name that as the likely next thing to check.
    return {
      ok: false,
      kind: 'host_unreachable',
      raw_code: code,
      message,
      friendly:
        'Could not reach the warehouse host. Check your network and, if you ' +
        "connect through a VPN or allowlist, that this machine's IP is still allowed.",
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
