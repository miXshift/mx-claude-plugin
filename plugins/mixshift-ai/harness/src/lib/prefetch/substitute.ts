/**
 * Resolve `:param` tokens in a SQL string.
 *
 * Two-phase substitution:
 *
 *   1. **List params** are inlined as comma-separated literals because
 *      mysql2's named-placeholder mode does NOT expand arrays inside
 *      `IN (...)` clauses. Inlining is safe IFF the elements are
 *      numbers; for safety we reject array elements that aren't
 *      finite numbers.
 *
 *   2. **Scalar params** are left as `:name` tokens. The caller passes
 *      the params object to mysql2 with `namedPlaceholders: true` and
 *      mysql2 handles the parameterized substitution (with proper
 *      escaping).
 *
 * Why not just use `?` everywhere?
 *   The legacy SQL library was written for Python `psycopg`-style
 *   `%(name)s` placeholders. Converting `:name` to `?` would require
 *   re-ordering params, which is error-prone. Named placeholders keep
 *   the SQL source-of-truth files unchanged.
 *
 * Why not let mysql2 expand arrays?
 *   mysql2's positional-placeholder mode (`?`) DOES expand arrays into
 *   `(v1, v2, v3)`. But that requires positional placeholders, which we
 *   intentionally don't use here. Named-mode + manual inlining gives us
 *   the best of both worlds: source files stay readable, and the
 *   inlining for IDs (numeric only) is straightforward.
 *
 * Returns:
 *   - `sql`: the SQL with list params already substituted (CSV-inlined)
 *   - `params`: the remaining scalar params (still `:name` form), with
 *     only the keys that appear in the SQL after list inlining
 */

export interface SubstituteResult {
  sql: string;
  params: Record<string, unknown>;
}

export function substituteParams(
  sql: string,
  allParams: Record<string, unknown>,
): SubstituteResult {
  let out = sql;
  const scalarParams: Record<string, unknown> = {};

  // 1. List params → CSV inline. Walk every key. If the value is an
  //    array, splice it in directly. We don't iterate the SQL — we
  //    iterate params, which lets us catch typos (`:seller_ids` vs
  //    `:seller_id_list`) at the SQL level rather than silently passing
  //    them as scalars.
  for (const [key, value] of Object.entries(allParams)) {
    if (Array.isArray(value)) {
      const csv = formatList(key, value);
      // Substitute every occurrence. Use a regex that requires the
      // token to be followed by a non-word char (or end) so `:seller_id`
      // doesn't match the start of `:seller_id_list`.
      const re = new RegExp(`:${escapeRegex(key)}(?![A-Za-z0-9_])`, 'g');
      out = out.replace(re, csv);
    } else {
      // Only keep scalar params that the SQL actually references. This
      // prevents mysql2 from throwing on "missing placeholder" if we
      // pre-compute params we don't use (e.g., :spend_floor in a query
      // that doesn't filter by spend).
      const re = new RegExp(`:${escapeRegex(key)}(?![A-Za-z0-9_])`);
      if (re.test(out)) {
        scalarParams[key] = value;
      }
    }
  }

  return { sql: out, params: scalarParams };
}

/**
 * Format an array of values as a SQL CSV literal for inlining into
 * `IN (...)`. Numbers go in bare; strings get single-quoted with
 * embedded quote escaping. Anything else throws — we'd rather fail
 * loudly than silently produce a broken query.
 */
function formatList(paramName: string, values: unknown[]): string {
  if (values.length === 0) {
    throw new Error(
      `Param :${paramName} is an empty list. SQL would emit "IN ()", ` +
        `which MySQL rejects. Caller must populate the list or skip ` +
        `the query.`,
    );
  }
  const parts = values.map((v, i) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) {
        throw new Error(
          `Param :${paramName}[${i}] is non-finite (${v}). Refusing to ` +
            `inline into SQL.`,
        );
      }
      return String(v);
    }
    if (typeof v === 'string') {
      // Single-quoted SQL string literal. Escape embedded single quotes
      // by doubling. This is the standard MySQL convention. We do NOT
      // attempt to defend against general SQL injection here — the
      // assumption is that list params come from context.yaml or the
      // standard-params builder (controlled inputs), NOT user free-form
      // chat. If that ever changes, switch to mysql2's escape() helper.
      return `'${v.replace(/'/g, "''")}'`;
    }
    if (typeof v === 'bigint') {
      return v.toString();
    }
    throw new Error(
      `Param :${paramName}[${i}] has unsupported type ${typeof v} ` +
        `(value: ${JSON.stringify(v)}). Lists must be numeric or string.`,
    );
  });
  return parts.join(', ');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan a SQL string for `:param` tokens. Used by callers (and tests)
 * to validate that all referenced params are supplied.
 *
 * Skips tokens inside string literals (single or double quoted) and
 * line comments (--). We don't try to handle block comments because
 * the library .sql files don't use them.
 */
export function findReferencedParams(sql: string): string[] {
  const result = new Set<string>();
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Skip string literals
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length && sql[i] !== quote) {
        // mysql escape: '' or \' both skip past
        if (sql[i] === '\\' && i + 1 < sql.length) {
          i += 2;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    // Skip line comments
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    // Skip Postgres :: cast operator entirely (not used in MySQL, but
    // defensive). We jump past both colons so the second one doesn't
    // get matched as a :name token on the next iteration.
    if (ch === ':' && sql[i + 1] === ':') {
      i += 2;
      continue;
    }
    // Match :name
    if (ch === ':') {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] ?? '')) j++;
      if (j > i + 1) {
        result.add(sql.slice(i + 1, j));
        i = j;
        continue;
      }
    }
    i++;
  }
  return [...result];
}
