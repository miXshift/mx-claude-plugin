/**
 * Derived campaign labels: the fallback that makes the Objective and Item Group
 * breakdowns useful on accounts that never filled those columns in.
 *
 * THE PROBLEM (measured 2026-08-26 across 35 tenant warehouses, 388,165
 * campaigns): `campaign.Objective` is filled on 1.09% of campaigns, and only 7
 * of 35 tenants have ANY. `ItemGroup` is 2.99%. The columns are operator-typed
 * free text and almost nobody types them. DHC-07 and DHC-08 group by those
 * columns, so on a typical account the entire per-Objective table collapses to
 * one `(unclassified)` row: correct, and operationally useless, on an account
 * that may be spending thousands a day.
 *
 * THE FIX, and specifically why it is shaped this way (decision D-039):
 * campaign NAMES are not parseable positionally -- one tenant carries 4,429
 * distinct first tokens across four coexisting conventions, so no single
 * `naming_pattern` splits them -- but they are richly semantic, so an agent
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
 *     `campaign.Objective` (the legacy app has 60 references to it and zero
 *     writes), and substitution happens at READ time.
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

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableAlias)) {
    throw new UnsafeLabelError(`${tableAlias}.${column}`);
  }

  const raw = `NULLIF(${tableAlias}.${column}, '')`;
  const whens: string[] = [];
  for (const [label, ids] of entries) {
    if (!SAFE_LABEL.test(label)) throw new UnsafeLabelError(label);
    const safeIds = assertCampaignIds(ids, label);
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
  const original = new RegExp(
    `COALESCE\\(\\s*NULLIF\\(\\s*${tableAlias}\\.${column}\\s*,\\s*''\\s*\\)\\s*,\\s*'\\(unclassified\\)'\\s*\\)`,
    'g',
  );
  const matches = sql.match(original);
  if (!matches || matches.length < 2) {
    throw new Error(
      `Cannot apply derived labels to this query: expected the ` +
        `COALESCE(NULLIF(${tableAlias}.${column},''),'${UNCLASSIFIED}') expression in both the ` +
        `SELECT and the GROUP BY, found ${matches?.length ?? 0}. The pack's shape changed; update ` +
        'lib/labels/derived-labels.ts rather than shipping a query whose grouping and labelling disagree.',
    );
  }
  return sql.replace(original, expression);
}

/**
 * What share of SPEND carries a label once the raw column and the confirmed map
 * are both applied.
 *
 * Spend-weighted on purpose, and this is the whole reason the gate is usable: a
 * real account has thousands of campaigns and a long tail of dead ones, but the
 * money concentrates. One measured tenant has 16,055 campaigns of which 710
 * spent anything in 30 days, and 388 of those carry 95% of the spend. Gating on
 * row count would demand the user classify thousands of dead campaigns to clear
 * a threshold; gating on spend asks about the money they actually care about.
 */
export function labelCoverage(
  rows: Array<{ campaign_id?: unknown; id?: unknown; objective?: unknown; spend?: unknown }>,
  map: DerivedLabelMap | null | undefined,
  rawField = 'objective',
): { coveredSpend: number; totalSpend: number; ratio: number; unlabeledCampaigns: number[] } {
  const labeled = new Set<number>();
  for (const ids of Object.values(map?.buckets ?? {})) for (const id of ids ?? []) labeled.add(Number(id));

  let coveredSpend = 0;
  let totalSpend = 0;
  const unlabeled: number[] = [];

  for (const row of rows) {
    const spend = Number((row as Record<string, unknown>).spend ?? 0) || 0;
    totalSpend += spend;
    const id = Number(row.campaign_id ?? row.id);
    const rawValue = (row as Record<string, unknown>)[rawField];
    const hasRaw = typeof rawValue === 'string' && rawValue.trim() !== '';
    if (hasRaw || labeled.has(id)) coveredSpend += spend;
    else if (Number.isInteger(id)) unlabeled.push(id);
  }

  return {
    coveredSpend,
    totalSpend,
    // No spend is not a coverage failure -- there is nothing to attribute, so
    // reporting 0% would send the user to classify campaigns that spent nothing.
    ratio: totalSpend > 0 ? coveredSpend / totalSpend : 1,
    unlabeledCampaigns: unlabeled,
  };
}
