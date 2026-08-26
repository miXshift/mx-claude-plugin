/**
 * Derived campaign labels: the fallback that makes the Objective and Item Group
 * breakdowns useful on accounts that never filled those columns in.
 *
 * THE PROBLEM: `campaign.Objective` and `ItemGroup` are operator-typed free
 * text in the platform, and the large majority of accounts never fill them in
 * (measured across customer warehouses; see decision D-039 for the figures).
 * DHC-07 and DHC-08 group by those columns, so on a typical account the whole
 * per-Objective table collapses to one `(unclassified)` row: correct, and
 * operationally useless, on an account that may be spending thousands a day.
 *
 * THE FIX, and specifically why it is shaped this way (decision D-039):
 * campaign NAMES are not parseable positionally -- a single account can carry
 * thousands of distinct name shapes across several coexisting conventions, so
 * no one `naming_pattern` splits them -- but they are semantic, so an agent
 * classifies them on sight and the USER CONFIRMS the resulting scheme. Those
 * confirmed labels live in brand context. This module turns them into the
 * GROUPING EXPRESSION for the existing queries.
 *
 * Note what this deliberately does NOT do:
 *
 *   - It does not introduce a second dimension. The raw column still wins
 *     wherever it is filled; derived labels only fill the gap. Callers get one
 *     logical Objective, never `objective` beside `derived_objective`.
 *   - It does not write to the warehouse. There is no write path to
 *     `campaign.Objective` (the platform only ever reads and filters on that
 *     column), and substitution happens at READ time.
 *   - It does not build a CASE over campaign-NAME patterns. A hardcoded CASE
 *     over name literals is the exact anti-pattern removed from CS-24/CS-14 in
 *     the 2026-08-03 audit: it bakes one agency's convention into shared SQL.
 *     The CASE here is over campaign IDs from a confirmed map, which carries no
 *     convention at all.
 */

/** One dimension's confirmed map: bucket label -> the campaign ids in it. */
export interface DerivedLabelMap {
  /** Bucket label as the user confirmed it, e.g. 'Non-Brand'. */
  buckets: Record<string, number[]>;
  /** ISO date the user confirmed this scheme. Provenance, not logic. */
  confirmed_at?: string;
}

/** Which dimension a map applies to. Mirrors the two affected queries. */
export type LabelDimension = 'objective' | 'item_group';

/** The query ids this fallback applies to, and the column each one groups on. */
export const LABEL_QUERY_COLUMNS: Record<string, { dimension: LabelDimension; column: string }> = {
  'DHC-07': { dimension: 'objective', column: 'Objective' },
  'DHC-08': { dimension: 'item_group', column: 'ItemGroup' },
};

/**
 * The literal a campaign falls into when neither the raw column nor the
 * confirmed map covers it. Identical to what the packs already emit, so the
 * fallback never changes the shape of the output the skill reads.
 */
export const UNCLASSIFIED = '(unclassified)';

/**
 * Labels are user-supplied text that is about to be concatenated into SQL, so
 * they are validated against an ALLOWLIST rather than escaped. Escaping asks
 * "did I catch every dangerous character"; an allowlist asks "is this one of
 * the shapes I already understand", which is the question with a safe default.
 * Letters, digits, space, and a few separators that real bucket names use
 * (`Non-Brand`, `Brand Defense`, `Top of Funnel`, `Auto/Catch-All`).
 */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._/&+-]{0,63}$/;

/** Upper bound on ids in one dimension's map. See buildGroupingExpression. */
const MAX_MAPPED_CAMPAIGNS = 5000;

export class UnsafeLabelError extends Error {
  constructor(label: string) {
    super(
      `Refusing to build a query from the label ${JSON.stringify(label)}: labels may contain ` +
        'only letters, digits, spaces and . _ / & + - (max 64 chars). Rename the bucket and ' +
        're-confirm.',
    );
    this.name = 'UnsafeLabelError';
  }
}

/** A campaign id that is not a positive integer cannot have come from the warehouse. */
function assertCampaignIds(ids: unknown[], label: string): number[] {
  const out: number[] = [];
  for (const raw of ids) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n <= 0 || !Number.isSafeInteger(n)) {
      throw new UnsafeLabelError(`${label} -> campaign id ${String(raw)}`);
    }
    out.push(n);
  }
  return out;
}

/**
 * Build the grouping expression that replaces the pack's
 * `COALESCE(NULLIF(c.<col>,''), '(unclassified)')`.
 *
 * The raw column is kept FIRST and wins on every row where it is filled: an
 * operator who typed a label meant it, and a derived label must never overwrite
 * a human's own words. Derived labels are consulted only where the column is
 * empty -- which, on the accounts this exists for, is every row.
 *
 * Returns null when there is nothing to add, so the caller runs the untouched
 * pack rather than a hand-built query that means the same thing.
 */
export function buildGroupingExpression(
  map: DerivedLabelMap | null | undefined,
  column: string,
  tableAlias = 'c',
): string | null {
  if (!map) return null;
  const entries = Object.entries(map.buckets ?? {}).filter(([, ids]) => ids?.length);
  if (entries.length === 0) return null;

  assertIdentifier(column, tableAlias);

  // A ceiling on how much SQL a label map can generate. Real accounts sit well
  // below this even at the top end, so anything approaching it is a malformed
  // map rather than a real account; tens of thousands of ids would emit
  // hundreds of KB of query text.
  const totalIds = entries.reduce((n, [, ids]) => n + ids.length, 0);
  if (totalIds > MAX_MAPPED_CAMPAIGNS) {
    throw new UnsafeLabelError(
      `${totalIds} campaign ids across ${entries.length} buckets (limit ${MAX_MAPPED_CAMPAIGNS})`,
    );
  }

  const raw = `NULLIF(${tableAlias}.${column}, '')`;
  const whens: string[] = [];
  const claimed = new Map<number, string>();
  for (const [label, ids] of entries) {
    if (!SAFE_LABEL.test(label)) throw new UnsafeLabelError(label);
    const safeIds = assertCampaignIds(ids, label);
    // Overlap is refused at save time by the context schema, but this function
    // is exported and takes a raw map, so refuse it here too. Silently letting
    // the first WHEN win would attribute a campaign's spend to a bucket the
    // user was never shown, in a table that still foots to the account total.
    for (const id of safeIds) {
      const prior = claimed.get(id);
      if (prior && prior !== label) {
        throw new UnsafeLabelError(`campaign ${id} is in both ${prior} and ${label}`);
      }
      claimed.set(id, label);
    }
    whens.push(
      `WHEN ${tableAlias}.ID IN (${safeIds.join(',')}) THEN '${label}'`,
    );
  }

  return `COALESCE(${raw}, CASE ${whens.join(' ')} ELSE '${UNCLASSIFIED}' END)`;
}

/**
 * Rewrite a pack's SQL to group by the derived expression instead of the raw
 * column.
 *
 * Both affected packs repeat the full COALESCE in the SELECT and again in the
 * GROUP BY -- deliberately, per their own header comments, because the SELECT
 * alias shadows the bare column name in MySQL. So both occurrences have to move
 * together or the query groups by one thing and labels by another, which would
 * silently mis-attribute spend. Replacing every occurrence keeps them in step,
 * and the count is asserted so a future pack edit that changes the shape fails
 * loudly here rather than producing a quietly wrong table.
 */
export function applyDerivedGrouping(
  sql: string,
  column: string,
  expression: string,
  tableAlias = 'c',
): string {
  assertIdentifier(column, tableAlias);
  // Built FROM the constant, not from a hand-copied literal. The two used to be
  // written out separately, so changing UNCLASSIFIED would have left this regex
  // matching the old text: the rewrite would still "succeed" while emitting a
  // fallback row the skill's documented handling does not recognise.
  const original = new RegExp(
    `COALESCE\\(\\s*NULLIF\\(\\s*${tableAlias}\\.${column}\\s*,\\s*''\\s*\\)\\s*,\\s*` +
      `${escapeRegExp(`'${UNCLASSIFIED}'`)}\\s*\\)`,
    'g',
  );

  // Count only occurrences in EXECUTABLE SQL. Counting raw text let a query
  // pass this guard on a comment plus ONE real occurrence, rewriting the SELECT
  // and leaving the GROUP BY untouched: the exact grouping-and-labelling
  // disagreement the guard exists to prevent, producing a wrong table that
  // still foots to the account total.
  const executable = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const realMatches = executable.match(original);
  if (!realMatches || realMatches.length < 2) {
    throw new Error(
      `Cannot apply derived labels to this query: expected the ` +
        `COALESCE(NULLIF(${tableAlias}.${column},''),'${UNCLASSIFIED}') expression in both the ` +
        `SELECT and the GROUP BY, found ${realMatches?.length ?? 0} outside comments. The pack's ` +
        `shape changed; update lib/labels/derived-labels.ts rather than shipping a query whose ` +
        'grouping and labelling disagree.',
    );
  }

  // Function replacer, never a replacement STRING: `$&`, `` $` `` and `$'` are
  // special there and would splice parts of the query into the output. No label
  // can currently contain `$`, but this function is exported and `expression`
  // is just a string, so removing the class costs nothing.
  return sql.replace(original, () => expression);
}

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQL identifiers we interpolate must be plain identifiers. Enforced in BOTH
 * exported functions: previously only the builder checked, while the rewriter
 * interpolated the same values into a RegExp with the `.` unescaped.
 */
function assertIdentifier(...names: string[]): void {
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new UnsafeLabelError(n);
  }
}
