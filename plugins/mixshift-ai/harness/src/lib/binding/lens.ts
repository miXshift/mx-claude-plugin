/**
 * The sub-brand LABEL LENS: turns a brand's `binding` block (lib/context/
 * schema.ts, mx-ops#6 P1) into the label-filter params the gateway's
 * label-aware named queries accept, and — just as important — into an honest,
 * per-query record of whether a lens was actually applied.
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
 *         that is a structural fact we surface loudly, not a bug we hide —
 *         and the SAME is true when we sent a filter and cannot prove it was
 *         honored (dropped / unverified / the query never came back at all).
 *
 * WHY A STATIC MAP: which entries accept which param is a server-side fact
 * (mx-legacy-auth PR #106). The plugin's local catalog does not carry param
 * schemas, so the map below IS the client's copy of that contract — same
 * posture as the sbd-01..04 id/shape contract in lib/binding/discovery.ts.
 * If the gateway adds label params to more entries, extend this map (and the
 * gateway keeps tolerating clients that don't send the param, so the two
 * sides can never deadlock on ordering).
 *
 * -----------------------------------------------------------------------
 * EVIDENCE, NOT INTENT (mx-legacy-auth PR #107 — applied_params)
 * -----------------------------------------------------------------------
 * Sending a label param proves nothing by itself: the deployed gateway
 * entry might not declare that param yet, in which case it is silently
 * STRIPPED by the entry's non-strict zod schema and the query runs
 * unfiltered — `ok:true`, rows returned, and no client-visible sign the
 * filter never took effect. mx-legacy-auth PR #107 closes that hole by
 * echoing `applied_params` (the sorted param NAMES the execution actually
 * bound) on every successful `/api/named-query` response.
 *
 * That means a lens decision can only be RESOLVED once the query returns:
 *   1. `lensFor()` decides the INTENT before dispatch — what param (if any)
 *      to send, and whether the decision is even reconcilable (a value was
 *      sent to a label-aware query) or already final (structural: no param
 *      exists, or the binding has no value for that side). A reconcilable
 *      decision starts life with outcome `'unverified'` — a placeholder,
 *      not a claim, until evidence says otherwise.
 *   2. `reconcileLensDecision()` / `reconcileLensDecisions()` resolve every
 *      reconcilable decision from the query's actual outcome, AFTER it
 *      settles: 'applied' only when `applied_params` demonstrably contains
 *      the key we sent; 'dropped' when it came back WITHOUT our key (the
 *      P0 case — the deploy silently stripped our filter); 'unverified'
 *      (stays) when the response carried no `applied_params` at all (an
 *      older gateway); 'query_failed' when the query failed or was
 *      deferred (no rows came back, so there is no scoping claim to make).
 *
 * Callers MUST call the reconcile step before a decision reaches a summary,
 * an artifact, the brain document, or any CLI output — an un-reconciled
 * decision is not evidence, it's a hope.
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
  /** EVIDENCE-BASED: the response's `applied_params` demonstrably contained
   *  the key we sent. Rows are scoped to this sub-brand. */
  | 'applied'
  /** We sent the param, but the response carried NO `applied_params` field
   *  at all — an older gateway deploy that predates PR #107. NOT proven
   *  label-scoped; never render as confirmed. */
  | 'unverified'
  /** We sent the param and `applied_params` came back WITHOUT it: the
   *  deployed entry silently stripped our filter. Rows are ACCOUNT-WIDE
   *  right now despite the binding — the P0 case. Loud by design. */
  | 'dropped'
  /** The query has no label param at all: its rows are ACCOUNT-WIDE and
   *  must not be attributed to the sub-brand (design §11 — say it, don't
   *  hide it). Structural; independent of any query outcome. */
  | 'account_wide'
  /** The query accepts a label param but the binding has no value for that
   *  side (e.g. no ads_label recorded): rows are account-wide on that side.
   *  Distinct from 'account_wide' because the FIX is different — record the
   *  missing label side on the binding, rather than wait for a gateway
   *  revision. Structural; independent of any query outcome. */
  | 'missing_label_value'
  /** The query failed or was deferred: no rows came back, so there is no
   *  scoping claim to make either way. Never resolves to 'applied'. */
  | 'query_failed';

export interface LensDecision {
  query_id: string;
  outcome: LensOutcome;
  /** Present when a value was (or would be) sent: 'applied' / 'dropped' /
   *  'unverified' / 'missing_label_value'. */
  param?: LensParamName;
  /** Present when a value was actually sent ('applied' / 'dropped' /
   *  'unverified'). Verbatim label value (labels are user-curated truth;
   *  never normalized). */
  value?: string;
}

export interface LensIntent {
  /** Params to MERGE into the query's native binds. Empty unless a value
   *  is being sent. */
  params: Readonly<Record<string, string>>;
  /** The decision, PRE-QUERY. For 'account_wide' and 'missing_label_value'
   *  this is already final — those outcomes describe the query/binding's
   *  shape, not what the server did, so they never need reconciliation.
   *  For anything else, this is a PLACEHOLDER (outcome 'unverified') that
   *  the caller MUST run through `reconcileLensDecision` /
   *  `reconcileLensDecisions` once the query's result is known — see
   *  `pendingVerification`. */
  decision: LensDecision;
  /** True when `decision` is a placeholder that requires post-query
   *  reconciliation (a value was sent to a label-aware query and whether
   *  the gateway actually honored it is not yet known). False for the two
   *  structural outcomes, which are already final. */
  pendingVerification: boolean;
}

/** @deprecated Old name for {@link LensIntent}. Kept as an alias so any
 *  external import doesn't break on the rename. */
export type LensApplication = LensIntent;

/**
 * Decide the lens INTENT for one query under one binding — what to send,
 * before the query runs. Returns null when `binding` is absent — an unbound
 * brand sends nothing and records nothing (the gateway's absent-param
 * behavior is byte-identical account-wide, already regression-tested
 * server-side).
 *
 * The returned decision is FINAL only for the two structural outcomes
 * (`account_wide`, `missing_label_value`). Otherwise it is a placeholder
 * (`unverified`) — see `pendingVerification` and the module doc for why a
 * decision cannot claim 'applied' before the query has actually run.
 */
export function lensFor(
  queryId: string,
  binding: BindingBlock | null | undefined,
): LensIntent | null {
  if (!binding) return null;

  const param = LABEL_LENS_PARAM_BY_QUERY[queryId];
  if (!param) {
    return {
      params: {},
      pendingVerification: false,
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
      pendingVerification: false,
      decision: { query_id: queryId, outcome: 'missing_label_value', param },
    };
  }

  return {
    params: { [param]: value },
    pendingVerification: true,
    // Placeholder — NOT a claim. reconcileLensDecision resolves this once
    // the query returns.
    decision: { query_id: queryId, outcome: 'unverified', param, value },
  };
}

/** What actually happened to a query the lens sent a value to, so
 *  `reconcileLensDecision` can resolve its placeholder outcome from
 *  evidence rather than intent. */
export type QueryLensOutcome =
  | { status: 'ok'; appliedParams?: string[] }
  | { status: 'failed' }
  | { status: 'deferred' };

/**
 * Resolve ONE decision's final outcome from what the query actually did.
 *
 * A no-op for the two structural outcomes (`account_wide`,
 * `missing_label_value`) and for anything already resolved — only a
 * pending placeholder (`outcome === 'unverified'` with a `param`, fresh out
 * of `lensFor`) is ever changed, so calling this twice on an
 * already-reconciled decision is safe.
 */
export function reconcileLensDecision(
  decision: LensDecision,
  outcome: QueryLensOutcome | undefined,
): LensDecision {
  if (decision.outcome !== 'unverified' || !decision.param) return decision;

  if (!outcome || outcome.status !== 'ok') {
    // Failed or deferred: no rows, no scoping claim either way.
    return { ...decision, outcome: 'query_failed' };
  }
  if (outcome.appliedParams === undefined) {
    // No evidence either way (older gateway) — stays 'unverified'.
    return decision;
  }
  return outcome.appliedParams.includes(decision.param)
    ? { ...decision, outcome: 'applied' }
    : { ...decision, outcome: 'dropped' };
}

/**
 * Batch form of {@link reconcileLensDecision}: resolve every decision whose
 * query id has a known outcome. Decisions with no matching entry in
 * `outcomes` (the query never ran) pass through unchanged — in practice
 * that never happens for a decision `lensFor` produced, since a decision is
 * only ever pushed at the same call site that dispatches the query.
 */
export function reconcileLensDecisions(
  decisions: readonly LensDecision[],
  outcomes: ReadonlyMap<string, QueryLensOutcome>,
): LensDecision[] {
  return decisions.map((d) => reconcileLensDecision(d, outcomes.get(d.query_id)));
}

export interface LensSummary {
  /** True whenever the brand is bound (decisions exist). */
  bound: boolean;
  applied: string[];
  /** P0: we sent the filter, the gateway did not honor it. These rows are
   *  ACCOUNT-WIDE despite the binding. */
  dropped: string[];
  /** We sent the filter but cannot prove it was honored (older gateway). */
  unverified: string[];
  account_wide: string[];
  missing_label_value: string[];
  /** The query failed or was deferred — no scoping claim was possible. */
  query_failed: string[];
}

/**
 * Summarize a RECONCILED decision list. Callers must reconcile first
 * (`reconcileLensDecisions`) — summarizing pre-reconciliation decisions
 * would report every pending placeholder as 'unverified' regardless of
 * what actually happened, defeating the point of the evidence step.
 */
export function summarizeLens(decisions: readonly LensDecision[]): LensSummary {
  const byOutcome = (outcome: LensOutcome): string[] =>
    decisions.filter((d) => d.outcome === outcome).map((d) => d.query_id);
  return {
    bound: decisions.length > 0,
    applied: byOutcome('applied'),
    dropped: byOutcome('dropped'),
    unverified: byOutcome('unverified'),
    account_wide: byOutcome('account_wide'),
    missing_label_value: byOutcome('missing_label_value'),
    query_failed: byOutcome('query_failed'),
  };
}

/**
 * One plain-language line for command output and run artifacts. Loud by
 * design: this line is the §11 mechanism that keeps account-wide (or
 * unproven) rows from being read as sub-brand rows. Returns null for
 * unbound brands, or a bound brand with nothing to report (no decisions —
 * should not happen in practice, but is not an error).
 */
export function renderLensNotice(summary: LensSummary, slug: string): string | null {
  if (!summary.bound) return null;
  const parts: string[] = [];
  if (summary.applied.length > 0) {
    parts.push(`label-scoped: ${summary.applied.join(', ')}`);
  }
  if (summary.dropped.length > 0) {
    parts.push(
      `DROPPED (the gateway did not honor this label filter; these rows are ACCOUNT-WIDE ` +
        `despite "${slug}"'s binding; flag to MixShift ops): ${summary.dropped.join(', ')}`,
    );
  }
  if (summary.unverified.length > 0) {
    parts.push(
      `UNVERIFIED (the gateway did not confirm the label filter applied; treat as NOT proven ` +
        `label-scoped, never as confirmed): ${summary.unverified.join(', ')}`,
    );
  }
  if (summary.query_failed.length > 0) {
    parts.push(
      `no scoping claim possible, query failed or was deferred: ${summary.query_failed.join(', ')}`,
    );
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
  if (parts.length === 0) return null;
  return `Sub-brand label lens for "${slug}" -> ${parts.join(' | ')}`;
}
