/**
 * The sub-brand LABEL LENS: turns a brand's `binding` block (lib/context/
 * schema.ts, mx-ops#6 P1) into the label-filter params the gateway's
 * label-aware named queries accept, and — just as important — into an honest,
 * per-query record of whether a lens was applied at all.
 *
 * Design contract (docs/subbrand-architecture.md in mx-legacy-auth):
 *   §2.1  the binding is the data lens: every warehouse read for a bound
 *         brand appends the label predicate.
 *   §3    label params are OPTIONAL on the gateway side; a query invoked
 *         WITHOUT them behaves account-wide, byte-identical to before. So an
 *         UNBOUND brand must send nothing at all.
 *   §11   a sub-brand read must never fall back to account-wide data
 *         SILENTLY. When a bound brand runs a query that has no label param
 *         (most of the pack: revenue baselines, keyword concentration, ...),
 *         that is a structural fact we surface loudly, not a bug we hide.
 *
 * WHY A STATIC MAP: which entries accept which param is a server-side fact
 * (mx-legacy-auth PR #106). The plugin's local catalog does not carry param
 * schemas, so the map below IS the client's copy of that contract — same
 * posture as the sbd-01..04 id/shape contract in lib/binding/discovery.ts.
 * If the gateway adds label params to more entries, extend this map (and the
 * gateway keeps tolerating clients that don't send the param, so the two
 * sides can never deadlock on ordering).
 */

import type { BindingBlock } from '../context/schema.js';

export type LensParamName = 'retail_brand_label' | 'ads_brand_label';

/**
 * Gateway entries that accept a label param, and which one — verified
 * against mx-legacy-auth src/querypack/entries at PR #106 (merged 7ef9bb3):
 * grep for `retail_brand_label|ads_brand_label` per entry.
 */
export const LABEL_LENS_PARAM_BY_QUERY: Readonly<Record<string, LensParamName>> = {
  'BRAIN-CATALOG-SC': 'retail_brand_label',
  'BRAIN-CATALOG-VC': 'retail_brand_label',
  'BRAIN-CAMPAIGN': 'ads_brand_label',
  'CS-09': 'retail_brand_label',
  'CS-11': 'retail_brand_label',
  'CS-12': 'retail_brand_label',
  'CS-13': 'retail_brand_label',
};

/** Per-query lens outcome for a BOUND brand. (Unbound brands produce no
 *  decisions at all — there is no lens question to answer.) */
export type LensOutcome =
  /** The query accepts a label param and the binding supplied the value:
   *  rows are scoped to this sub-brand. */
  | 'applied'
  /** The query has no label param at all: its rows are ACCOUNT-WIDE and
   *  must not be attributed to the sub-brand (design §11 — say it, don't
   *  hide it). */
  | 'account_wide'
  /** The query accepts a label param but the binding has no value for that
   *  side (e.g. no ads_label recorded): rows are account-wide on that side.
   *  Distinct from 'account_wide' because the FIX is different — record the
   *  missing label side on the binding, rather than wait for a gateway
   *  revision. */
  | 'missing_label_value';

export interface LensDecision {
  query_id: string;
  outcome: LensOutcome;
  /** Present when outcome === 'applied'. */
  param?: LensParamName;
  /** Present when outcome === 'applied'. Verbatim label value (labels are
   *  user-curated truth; never normalized). */
  value?: string;
}

export interface LensApplication {
  /** Params to MERGE into the query's native binds. Empty unless applied. */
  params: Readonly<Record<string, string>>;
  decision: LensDecision;
}

/**
 * Decide the lens for one query under one binding.
 *
 * Returns null when `binding` is absent — an unbound brand sends nothing
 * and records nothing (the gateway's absent-param behavior is byte-identical
 * account-wide, already regression-tested server-side).
 */
export function lensFor(
  queryId: string,
  binding: BindingBlock | null | undefined,
): LensApplication | null {
  if (!binding) return null;

  const param = LABEL_LENS_PARAM_BY_QUERY[queryId];
  if (!param) {
    return {
      params: {},
      decision: { query_id: queryId, outcome: 'account_wide' },
    };
  }

  const value =
    param === 'retail_brand_label'
      ? binding.retail_label?.value
      : binding.ads_label?.value;

  if (!value) {
    return {
      params: {},
      decision: { query_id: queryId, outcome: 'missing_label_value', param },
    };
  }

  return {
    params: { [param]: value },
    decision: { query_id: queryId, outcome: 'applied', param, value },
  };
}

export interface LensSummary {
  /** True whenever the brand is bound (decisions exist). */
  bound: boolean;
  applied: string[];
  account_wide: string[];
  missing_label_value: string[];
}

export function summarizeLens(decisions: readonly LensDecision[]): LensSummary {
  return {
    bound: decisions.length > 0,
    applied: decisions.filter((d) => d.outcome === 'applied').map((d) => d.query_id),
    account_wide: decisions.filter((d) => d.outcome === 'account_wide').map((d) => d.query_id),
    missing_label_value: decisions
      .filter((d) => d.outcome === 'missing_label_value')
      .map((d) => d.query_id),
  };
}

/**
 * One plain-language line for command output and run artifacts. Loud by
 * design: this line is the §11 mechanism that keeps account-wide rows from
 * being read as sub-brand rows. Returns null for unbound brands (nothing to
 * say — today's behavior, unchanged).
 */
export function renderLensNotice(summary: LensSummary, slug: string): string | null {
  if (!summary.bound) return null;
  const parts: string[] = [];
  if (summary.applied.length > 0) {
    parts.push(`label-scoped: ${summary.applied.join(', ')}`);
  }
  if (summary.account_wide.length > 0) {
    parts.push(
      `ACCOUNT-WIDE (no label filter exists for these; do not attribute their numbers to "${slug}"): ${summary.account_wide.join(', ')}`,
    );
  }
  if (summary.missing_label_value.length > 0) {
    parts.push(
      `ACCOUNT-WIDE (binding has no label value for that side; add it to context.yaml binding to scope these): ${summary.missing_label_value.join(', ')}`,
    );
  }
  return `Sub-brand label lens for "${slug}" -> ${parts.join(' | ')}`;
}
