/**
 * Pre-send column check for ad-hoc `mixshift data query` SQL.
 *
 * The widest failure in query telemetry is MySQL's ER_BAD_FIELD_ERROR: an
 * agent names a column that does not exist on the table (`spend` on
 * campaignmetric, `SellerName` on seller), gets a bare "Unknown column", and
 * guesses again. This check resolves the query's column references against the
 * table catalog the plugin ships (`shared/tables.yaml`) BEFORE the query is
 * sent, and when a name is absent it fails fast with the table's real columns
 * and the closest match, so the next attempt is a correction, not a guess.
 *
 * Conservative by design. It blocks only when it is certain:
 *   - the statement is a single plain SELECT over ONE catalogued table
 *     (no JOIN, no comma-join, no subquery, no UNION, no CTE);
 *   - every qualified name (`s.Cost`) resolves to that table or its alias;
 *   - the name is not a keyword, a function, an alias the query defines, a
 *     literal or a parameter;
 *   - and the column is not in the table's column list (case-insensitive,
 *     as MySQL compares column names).
 * Anything else (backticks, an unknown qualifier, an index hint, a table the
 * catalog does not list, a non-SELECT statement) is sent unchanged, so a
 * mistake here can only ever cost the one round trip the user already pays.
 *
 * It never rewrites the query. A blocked query is returned to the caller with
 * the hint; the agent re-runs it with the right column and says so.
 */

import type { SchemaCatalog, SchemaTable } from './schema-catalog.js';

export type ColumnCheck =
  | { verdict: 'ok'; table: string }
  | { verdict: 'skipped'; reason: SkipReason }
  | {
      verdict: 'unknown_column';
      table: string;
      column: string;
      /** Best guesses, best first; empty when nothing is close. */
      suggestions: string[];
      /** The table's real columns, dump order. */
      columns: string[];
      gotchas: string[];
    };

export type SkipReason =
  | 'empty'
  | 'not_select'
  | 'backtick'
  | 'cte'
  | 'subquery_or_union'
  | 'multi_table'
  | 'qualified_table'
  | 'index_hint'
  | 'unknown_table'
  | 'unknown_qualifier'
  | 'unparseable';

interface Tok {
  /** id = identifier/keyword, num, str = quoted literal, var = `?`/`:name`/`@x`, p = punctuation */
  t: 'id' | 'num' | 'str' | 'var' | 'p';
  v: string;
  /** Lowercased value for ids. */
  l: string;
}

/**
 * Words that can appear unquoted in a MySQL SELECT without being a column:
 * reserved and non-reserved keywords, type names, interval units, window and
 * set-operation vocabulary, and the keyword-functions that take no parens.
 * Missing a word here means a false block, so the list is broad on purpose;
 * an extra word only means a column with that name is not checked.
 */
const KEYWORDS = new Set(
  `
accessible add all alter analyze and as asc asensitive before between bigint binary blob both by call
cascade case change char character check collate column condition constraint continue convert create cross
cube cume_dist current_date current_time current_timestamp current_user cursor database databases day_hour
day_microsecond day_minute day_second declare default delayed delete dense_rank desc describe
deterministic distinct distinctrow div drop dual each else elseif empty enclosed end escaped except exists
exit explain false fetch first_value float float4 float8 for force foreign from fulltext function generated
get grant group grouping groups having high_priority hour_microsecond hour_minute hour_second if ignore in
index infile inner inout insensitive insert int1 int2 int3 int4 int8 intersect interval into
io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value lateral lead leading
leave left like limit linear lines load localtime localtimestamp lock long longblob longtext loop
low_priority master_bind master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext
middleint minute_microsecond minute_second mod modifies natural not no_write_to_binlog nth_value ntile null
of on optimize optimizer_costs option optionally or order out outer outfile over partition percent_rank
precision primary procedure purge range rank read reads read_write recursive references regexp release
rename repeat replace require resignal restrict return revoke right rlike row rows row_number schema schemas
second_microsecond select sensitive separator set show signal smallint spatial specific sql sqlexception
sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stored straight_join
system table terminated then tinyblob tinytext to trailing trigger true undo union unique unlock
update usage use using utc_date utc_time utc_timestamp values varbinary varcharacter
varying virtual when where while window with write xor year_month zerofill
any some unknown rollup offset ties only nulls first last preceding following unbounded current exclude
others group_concat separator escape soundex sounds like do begin
sql_no_cache sql_cache sql_buffer_result straight
ascii unicode character set charset collate
coalesce ifnull nullif greatest least isnull
share skip locked nowait dumpfile fields mode language query expansion against member returning at zone
error respect sql_tsi_frac_second sql_tsi_second sql_tsi_minute sql_tsi_hour sql_tsi_day sql_tsi_week
sql_tsi_month sql_tsi_quarter sql_tsi_year
`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Type names and interval units. These are keywords only in a type/unit
 * position (`CAST(x AS DATE)`, `INTERVAL 30 DAY`, `TIMESTAMPDIFF(DAY, a, b)`,
 * `CONVERT(x, CHAR)`), and plain column references anywhere else: `Date` is
 * the most-guessed missing column on the metric tables, and `DateTime d` is a
 * column with an implicit alias. They are therefore checked as columns except
 * in those positions.
 */
const CONTEXT_KEYWORDS = new Set([
  'date', 'datetime', 'time', 'timestamp', 'year', 'month', 'day', 'week', 'quarter', 'hour', 'minute', 'second',
  'microsecond', 'text', 'json', 'char', 'nchar', 'national', 'signed', 'unsigned', 'decimal', 'dec', 'numeric',
  'int', 'integer', 'bigint', 'smallint', 'tinyint', 'float', 'double', 'real', 'boolean', 'bool', 'varchar',
]);
/** Functions whose argument list carries a type name, interval unit or
 *  search modifier (`AGAINST ('x' IN BOOLEAN MODE)`). */
const TYPE_ARG_FUNCS = new Set([
  'cast', 'convert', 'extract', 'timestampdiff', 'timestampadd', 'date_add', 'date_sub', 'adddate', 'subdate',
  'get_format', 'json_value', 'json_table', 'against',
]);
/** `<keyword> <name>` where the name is never a column (a collation, charset,
 *  `AT TIME ZONE`). */
const NAME_AFTER = new Set(['collate', 'charset', 'character', 'using', 'set', 'at']);
/** Where an expression certainly ends when scanning back for an `INTERVAL`. */
const EXPR_BOUNDARY = new Set([
  'select', 'from', 'where', 'and', 'or', 'xor', 'not', 'group', 'order', 'having', 'limit', 'by', 'when', 'then',
  'else', 'case', 'end', 'on', 'as', 'between', 'in', 'like', 'is', 'window', 'partition', 'over',
]);

/** Keywords that end a FROM clause's table reference (so the word after the
 *  table is a clause, not an alias). */
const CLAUSE_AFTER_TABLE = new Set([
  'where', 'group', 'order', 'limit', 'having', 'window', 'union', 'for', 'lock', 'into', 'procedure', 'except', 'intersect',
]);
/** Table-list continuations that mean more than one table is involved. */
const MULTI_TABLE = new Set(['join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'straight_join', 'on', 'using', 'full']);
/** Keywords that end a value, so an implicit alias may directly follow them
 *  (`x IS NULL flag`, `CASE ... END bucket`, `CURRENT_DATE today`,
 *  `x + INTERVAL 1 DAY_HOUR later`). */
const LITERAL_KEYWORDS = new Set([
  'null', 'true', 'false', 'end', 'unknown',
  'current_date', 'current_time', 'current_timestamp', 'current_user', 'localtime', 'localtimestamp',
  'utc_date', 'utc_time', 'utc_timestamp',
  'day_hour', 'day_microsecond', 'day_minute', 'day_second', 'hour_microsecond', 'hour_minute', 'hour_second',
  'minute_microsecond', 'minute_second', 'second_microsecond', 'year_month',
]);

export function checkColumns(sql: string, catalog: SchemaCatalog): ColumnCheck {
  if (!sql || !sql.trim()) return { verdict: 'skipped', reason: 'empty' };
  if (sql.includes('`')) return { verdict: 'skipped', reason: 'backtick' };
  const toks = tokenize(stripComments(sql));
  if (toks.length === 0) return { verdict: 'skipped', reason: 'empty' };
  // Trailing semicolon is fine; anything after it is not.
  if (toks[toks.length - 1]!.t === 'p' && toks[toks.length - 1]!.v === ';') toks.pop();
  if (toks.length === 0) return { verdict: 'skipped', reason: 'empty' };
  if (toks[0]!.l === 'with') return { verdict: 'skipped', reason: 'cte' };
  if (toks[0]!.l !== 'select') return { verdict: 'skipped', reason: 'not_select' };

  let selects = 0;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i]!;
    if (k.t !== 'id') continue;
    if (k.l === 'select') selects++;
    if (k.l === 'union' || k.l === 'except' || k.l === 'intersect') return { verdict: 'skipped', reason: 'subquery_or_union' };
    if ((k.l === 'index' || k.l === 'key') && i > 0 && ['use', 'force', 'ignore'].includes(toks[i - 1]!.l)) {
      return { verdict: 'skipped', reason: 'index_hint' };
    }
  }
  if (selects > 1) return { verdict: 'skipped', reason: 'subquery_or_union' };

  // Locate the FROM at paren depth 0 (EXTRACT(YEAR FROM x) sits at depth 1).
  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i]!;
    if (k.t === 'p') {
      if (k.v === '(') depth++;
      else if (k.v === ')') depth--;
      continue;
    }
    if (depth === 0 && k.t === 'id' && k.l === 'from') {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx < 0) return { verdict: 'skipped', reason: 'not_select' };

  const tableTok = toks[fromIdx + 1];
  if (!tableTok || tableTok.t !== 'id') return { verdict: 'skipped', reason: 'unparseable' };
  let i = fromIdx + 2;
  if (toks[i]?.t === 'p' && toks[i]!.v === '.') return { verdict: 'skipped', reason: 'qualified_table' };
  const tableName = tableTok.l;
  const table = catalog.get(tableName);
  if (!table) return { verdict: 'skipped', reason: 'unknown_table' };

  // Optional alias: `FROM t AS a` or `FROM t a`.
  let alias: string | null = null;
  if (toks[i]?.t === 'id' && toks[i]!.l === 'as') {
    const a = toks[i + 1];
    if (!a || a.t !== 'id') return { verdict: 'skipped', reason: 'unparseable' };
    alias = a.l;
    i += 2;
  } else if (toks[i]?.t === 'id' && !CLAUSE_AFTER_TABLE.has(toks[i]!.l) && !MULTI_TABLE.has(toks[i]!.l)) {
    alias = toks[i]!.l;
    i += 1;
  }
  // What follows the table reference must be a clause or the end.
  const after = toks[i];
  if (after) {
    if (after.t !== 'id') return { verdict: 'skipped', reason: 'multi_table' }; // `,` comma-join etc.
    if (MULTI_TABLE.has(after.l)) return { verdict: 'skipped', reason: 'multi_table' };
    if (!CLAUSE_AFTER_TABLE.has(after.l)) return { verdict: 'skipped', reason: 'unparseable' };
  }
  // A JOIN anywhere else (defensive: the clause walk above should have caught it).
  for (const k of toks) if (k.t === 'id' && (k.l === 'join' || k.l === 'straight_join')) return { verdict: 'skipped', reason: 'multi_table' };

  const columns = new Map<string, string>();
  for (const c of table.columns) columns.set(c.toLowerCase(), c);
  const isKeyword = (l: string) => KEYWORDS.has(l) && !columns.has(l);

  // Innermost function call enclosing each token (`sum` for the x in SUM(x)),
  // so a type name inside CAST/EXTRACT/TIMESTAMPDIFF is read as a type.
  const enclosing: (string | null)[] = new Array(toks.length).fill(null);
  const callStack: (string | null)[] = [];
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]!;
    enclosing[k] = callStack[callStack.length - 1] ?? null;
    if (tok.t !== 'p') continue;
    if (tok.v === '(') {
      const name = toks[k - 1];
      callStack.push(name?.t === 'id' ? name.l : null);
    } else if (tok.v === ')') callStack.pop();
  }

  // Aliases the query itself defines: after AS anywhere, and implicit aliases
  // in the select list (`COUNT(*) n`, `Cost spend`, `DateTime d`, `x IS NULL flag`).
  // Named windows (`WINDOW w AS (...)`, used as `OVER w`) resolve anywhere.
  const aliases = new Set<string>();
  const aliasPositions = new Set<number>();
  const windowNames = new Set<string>();
  depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]!;
    if (tok.t === 'p') {
      if (tok.v === '(') depth++;
      else if (tok.v === ')') depth--;
      continue;
    }
    if (tok.t !== 'id') continue;
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (next?.t === 'id' && next.l === 'as' && toks[k + 2]?.t === 'p' && toks[k + 2]!.v === '(') {
      windowNames.add(tok.l); // `w AS (PARTITION BY ...)`
      aliasPositions.add(k);
      continue;
    }
    if (prev?.t === 'id' && prev.l === 'as') {
      aliases.add(tok.l);
      aliasPositions.add(k);
      continue;
    }
    if (k > 0 && k < fromIdx && depth === 0 && !isKeyword(tok.l) && prev) {
      const implicit =
        prev.t === 'num' ||
        prev.t === 'str' ||
        prev.t === 'var' ||
        (prev.t === 'p' && prev.v === ')') ||
        (prev.t === 'id' && (!isKeyword(prev.l) || LITERAL_KEYWORDS.has(prev.l)));
      if (implicit) {
        aliases.add(tok.l);
        aliasPositions.add(k);
      }
    }
  }

  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]!;
    if (tok.t !== 'id' || aliasPositions.has(k)) continue;
    const next = toks[k + 1];
    const prev = toks[k - 1];
    if (next?.t === 'p' && (next.v === '(' || next.v === '.')) continue; // function call / qualifier
    if (next?.t === 'str') continue; // typed literal or introducer: DATE '...', N'x', X'ff', _utf8mb4'x'
    // A charset introducer before a hex or bit literal: `_utf8mb4 X'61'`, `_binary 0x61`.
    if (tok.v.startsWith('_') && (next?.t === 'num' || (next?.t === 'id' && toks[k + 2]?.t === 'str'))) continue;
    if (windowNames.has(tok.l)) continue;
    if (prev?.t === 'p' && prev.v === '.') {
      const q = toks[k - 2];
      if (!q || q.t !== 'id') return { verdict: 'skipped', reason: 'unparseable' };
      if (q.l !== tableName && q.l !== alias) return { verdict: 'skipped', reason: 'unknown_qualifier' };
    } else {
      if (isKeyword(tok.l)) continue;
      if (prev?.t === 'id' && NAME_AFTER.has(prev.l)) continue;
      // A select-list alias resolves only in the clauses after FROM (GROUP BY,
      // HAVING, ORDER BY); inside the select list `MAX(Title) title` still
      // names a column `Title`, which MySQL resolves against the table.
      if (k > fromIdx && aliases.has(tok.l)) continue;
      if (tok.l === tableName || tok.l === alias) continue;
      if (CONTEXT_KEYWORDS.has(tok.l) && !columns.has(tok.l)) {
        const fn = enclosing[k];
        if ((fn && TYPE_ARG_FUNCS.has(fn)) || afterIntervalInExpression(toks, k)) continue;
      }
    }
    if (columns.has(tok.l)) continue;
    return {
      verdict: 'unknown_column',
      table: table.name,
      column: tok.v,
      suggestions: suggestColumns(tok.v, table),
      columns: table.columns,
      gotchas: table.gotchas,
    };
  }
  return { verdict: 'ok', table: table.name };
}

/**
 * Closest real columns for a name that does not exist, best first (at most 3).
 * Ranks, in order: the curated role hint (`spend` -> `Cost`), the same name
 * ignoring case and underscores, a small edit distance, and a shared prefix or
 * substring (`SellerName` -> `Name`, `DateKey` -> `DateTime`).
 */
export function suggestColumns(unknown: string, table: Pick<SchemaTable, 'columns' | 'keyColumns'> & { gotchas?: string[] }): string[] {
  // MySQL identifiers are at most 64 characters; anything longer is not a
  // near miss of any column, and the distance scoring is quadratic.
  if (unknown.length > 64) return [];
  const u = unknown.toLowerCase();
  const scored = new Map<string, number>();
  const bump = (col: string, score: number) => {
    const prevScore = scored.get(col) ?? 0;
    if (score > prevScore) scored.set(col, score);
  };
  const real = new Map(table.columns.map((c) => [c.toLowerCase(), c] as const));
  const role = table.keyColumns[u];
  if (role && real.has(role.toLowerCase())) bump(role, 10);
  // A gotcha that names the guessed column ("There is no `Title`; the item
  // name is `ItemName`") usually names the real one in the same line: the
  // first backticked name there that is a column of this table.
  for (const g of table.gotchas ?? []) {
    const names = [...g.matchAll(/`([A-Za-z_][\w$]*)`/g)].map((m) => m[1]!);
    if (!names.some((n) => n.toLowerCase() === u)) continue;
    const hit = names.find((n) => n.toLowerCase() !== u && real.has(n.toLowerCase()));
    if (hit) {
      bump(real.get(hit.toLowerCase())!, 8);
      break;
    }
  }

  const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, '');
  const nu = norm(unknown);
  for (const col of table.columns) {
    const c = col.toLowerCase();
    if (norm(col) === nu) {
      bump(col, 9);
      continue;
    }
    const d = editDistance(u, c);
    const tol = Math.max(2, Math.floor(u.length / 4));
    if (d <= tol) bump(col, 5 + (1 - d / Math.max(u.length, c.length)));
    const longer = Math.max(u.length, c.length);
    if (c.length >= 3 && u.length >= 3) {
      if (u.includes(c) || c.includes(u)) bump(col, 3 + Math.min(u.length, c.length) / longer);
    }
    if (c.length >= 2 && (u.endsWith(c) || c.endsWith(u) || u.startsWith(c) || c.startsWith(u))) {
      bump(col, 2 + Math.min(u.length, c.length) / longer);
    }
    const p = commonPrefix(u, c);
    if (p >= 4) bump(col, 1 + p / longer);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([col]) => col);
}

/**
 * The hint shown instead of the gateway's "Unknown column". Names the real
 * columns and the closest match, repeats the catalog's gotchas, and says the
 * query was not sent so the correction is visible. Copy rule: no em dashes.
 */
export function unknownColumnFriendly(r: Extract<ColumnCheck, { verdict: 'unknown_column' }>): string {
  const lines: string[] = [];
  const first = r.suggestions[0];
  const rest = r.suggestions.slice(1);
  lines.push(
    `No column \`${r.column}\` on \`${r.table}\`.` +
      (first
        ? ` Did you mean \`${first}\`` + (rest.length ? ` (or ${rest.map((s) => `\`${s}\``).join(', ')})` : '') + '?'
        : ''),
  );
  lines.push(`Columns on \`${r.table}\` (${r.columns.length}): ${r.columns.join(', ')}`);
  if (r.gotchas.length) {
    lines.push('Before you name a column:');
    for (const g of r.gotchas) lines.push(`- ${g}`);
  }
  lines.push(
    'The query was not sent. Re-run it with a column from this list, and tell the user ' +
      `which column you used in place of \`${r.column}\`. ` +
      'If you are certain the column exists (the shipped catalog can be behind the warehouse), ' +
      're-run with --no-column-check.',
  );
  return lines.join('\n');
}

/**
 * Is token `k` the unit of an `INTERVAL <expr> <unit>`? Scans back through
 * the same expression (balanced parens, stopping at a comma or a clause
 * keyword at this depth) for the `INTERVAL` word, so
 * `INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY` and `INTERVAL 7 * 24 HOUR`
 * read as units, while `x + INTERVAL 1 DAY, Year` still checks `Year`.
 */
function afterIntervalInExpression(toks: Tok[], k: number): boolean {
  let depth = 0;
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[j]!;
    if (t.t === 'p') {
      if (t.v === ')') depth++;
      else if (t.v === '(') {
        if (depth === 0) return false;
        depth--;
      } else if (t.v === ',' && depth === 0) return false;
      continue;
    }
    if (depth > 0 || t.t !== 'id') continue;
    if (t.l === 'interval') return true;
    if (t.l === 'end') {
      // A whole CASE expression as the INTERVAL operand: step over it.
      let nested = 1;
      while (nested > 0 && --j >= 0) {
        const c = toks[j]!;
        if (c.t !== 'id') continue;
        if (c.l === 'end') nested++;
        else if (c.l === 'case') nested--;
      }
      continue;
    }
    if (EXPR_BOUNDARY.has(t.l)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// lexing
// ---------------------------------------------------------------------------

/** Replace `--`, `#` and block comments with a space; quotes are honoured. */
function stripComments(sql: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < sql.length) out += sql[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]!))) {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      toks.push({ t: 'str', v: sql.slice(i, j + 1), l: '' });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9a-zA-Z_.]/.test(sql[j]!)) j++;
      toks.push({ t: 'num', v: sql.slice(i, j), l: '' });
      i = j;
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      const v = sql.slice(i, j);
      toks.push({ t: 'id', v, l: v.toLowerCase() });
      i = j;
      continue;
    }
    if (ch === '?') {
      toks.push({ t: 'var', v: '?', l: '' });
      i++;
      continue;
    }
    if ((ch === '@' || ch === ':') && /[A-Za-z_@]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_@.$]/.test(sql[j]!)) j++;
      toks.push({ t: 'var', v: sql.slice(i, j), l: '' });
      i = j;
      continue;
    }
    toks.push({ t: 'p', v: ch, l: '' });
    i++;
  }
  return toks;
}

/** Damerau-Levenshtein (adjacent transposition counts as one edit, so
 *  `DateTiem` is one step from `DateTime`). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const k = b.length;
  if (m === 0) return k;
  if (k === 0) return m;
  const rows: number[][] = [Array.from({ length: k + 1 }, (_, j) => j)];
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(k + 1);
    const prev = rows[i - 1]!;
    cur[0] = i;
    for (let j = 1; j <= k; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      cur[j] = best;
    }
    rows.push(cur);
  }
  return rows[m]![k]!;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
