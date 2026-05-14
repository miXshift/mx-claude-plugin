/**
 * Compute the standard parameter map for SQL library queries.
 *
 * Every query in the library is parameterized by `:name` tokens. The
 * legacy `pre-fetch-data.py` defined a fixed set of standard params
 * derived from brand context + the run date.
 *
 * Categories of standard params:
 *
 * **Account identity (from brand context):**
 *   :seller_id                   primary account's SellerID (int)
 *   :seller_id_list              ALL account SellerIDs in this brand (int[])
 *
 * **Date axes (from run_date):**
 *   :run_date                    ISO date string (YYYY-MM-DD)
 *   :yesterday                   run_date - 1 day (ISO)
 *   :window_start                start of the lookback window (ISO)
 *                                = yesterday - (lookback_days - 1)
 *   :window_end                  alias for :yesterday (legacy compat)
 *   :start_date                  alias for :window_start (legacy compat)
 *   :end_date                    alias for :window_end (legacy compat)
 *   :month_start                 first day of run_date's month (ISO)
 *   :curr_month                  alias for :month_start (legacy compat)
 *   :prior_month                 first day of previous month (ISO)
 *   :prior_month_start           alias for :prior_month (legacy compat)
 *   :prior_year_month            first day of same month one year prior (ISO)
 *   :current_month_end           last day of run_date's month (ISO)
 *
 * **Tunables (defaults, override via paramOverrides):**
 *   :lookback_days               default 30
 *   :limit                       default 1000
 *   :spend_floor                 default 5
 *   :days_of_supply_threshold    default 14
 *   :lifetime_orders_threshold   default 3 -- read from
 *                                context.negation.asin_negation.pre_check_lifetime_orders_threshold
 *                                when present
 *   :utilization_threshold       default 0.9 (90% budget utilization)
 *   :vc_lag                      default 2 if VC primary, 1 if SC primary
 *
 * Skill-specific or per-query overrides are merged in via `paramOverrides`.
 *
 * The output is a plain object suitable for mysql2 with
 * `namedPlaceholders: true`. Arrays are kept as arrays — the substitution
 * step inlines them as CSV before the SQL hits mysql2.
 *
 * Params that depend on a prior query's results (e.g. ANEG-04's
 * `:window_asin_set` from ANEG-02 output, STDP-04..06's `:search_term_list`
 * from STDP-03 output) are NOT in standard params. The skill model is
 * expected to supply them via paramOverrides between prefetch passes, or
 * run the dependent queries inline via `mixshift data query` after the
 * initial batch completes.
 */

import type { BrandContext } from '../context/schema.js';

export interface BuildParamsOptions {
  context: BrandContext;
  runDate: string; // YYYY-MM-DD
  /**
   * Per-call overrides (merged on top of the standard params).
   * Use this for query-specific scalars like :keyword_id or per-skill
   * tunables.
   */
  paramOverrides?: Record<string, unknown>;
}

export type ParamMap = Record<string, unknown>;

export function buildStandardParams(opts: BuildParamsOptions): ParamMap {
  const { context, runDate, paramOverrides = {} } = opts;

  if (!isIsoDate(runDate)) {
    throw new Error(
      `runDate must be a YYYY-MM-DD string, got "${runDate}".`,
    );
  }
  if (context.accounts.length === 0) {
    throw new Error(
      `Brand "${context.brand_slug}" has no accounts in context.yaml. ` +
        `Re-run brand discovery / bootstrap.`,
    );
  }

  // Primary is the first account flagged as `role: primary`, else the
  // first account in the list. (The bootstrap orderer already puts the
  // primary at index 0, so the find() is a safety net.)
  const primary =
    context.accounts.find((a) => a.role === 'primary') ?? context.accounts[0]!;

  const sellerIdList = context.accounts.map((a) => Number(a.seller_id));

  // Resolve `lookback_days` early so window_start can be derived from it.
  // Order of precedence: paramOverrides > standard default (30).
  const lookbackDays =
    typeof paramOverrides.lookback_days === 'number'
      ? paramOverrides.lookback_days
      : 30;

  const runDateD = isoToDate(runDate);
  const yesterday = isoFromDate(addDays(runDateD, -1));
  const windowStart = isoFromDate(
    addDays(runDateD, -1 * Math.max(lookbackDays, 1)),
  );
  const monthStart = isoFromDate(firstOfMonth(runDateD));
  const priorMonthStart = isoFromDate(firstOfMonth(addMonths(runDateD, -1)));
  const priorYearMonthStart = isoFromDate(
    firstOfMonth(addMonths(runDateD, -12)),
  );
  const currentMonthEnd = isoFromDate(lastOfMonth(runDateD));

  // Brand-context-derived thresholds. The Zod schema permits skill_config
  // and negation.asin_negation as `unknown` so the runtime cast is
  // intentional — these are config dictionaries, not strictly typed.
  const lifetimeOrdersThreshold = readNumberFromUnknownObject(
    context.negation?.asin_negation,
    'pre_check_lifetime_orders_threshold',
    3,
  );

  // SC = 1-day lag, VC = 2-day lag (per data-source convention)
  const vcLag = primary.account_type === 'VC' ? 2 : 1;

  const standard: ParamMap = {
    // Account identity
    seller_id: Number(primary.seller_id),
    seller_id_list: sellerIdList,

    // Date axes (canonical names)
    run_date: runDate,
    yesterday,
    window_start: windowStart,
    window_end: yesterday,
    month_start: monthStart,
    prior_month: priorMonthStart,
    prior_year_month: priorYearMonthStart,
    current_month_end: currentMonthEnd,

    // Legacy aliases (for queries that haven't standardized yet)
    start_date: windowStart,
    end_date: yesterday,
    curr_month: monthStart,
    prior_month_start: priorMonthStart,

    // Tunables
    lookback_days: lookbackDays,
    limit: 1000,
    spend_floor: 5,
    days_of_supply_threshold: 14,
    lifetime_orders_threshold: lifetimeOrdersThreshold,
    utilization_threshold: 0.9,
    vc_lag: vcLag,
  };

  return { ...standard, ...paramOverrides };
}

// -----------------------------------------------------------------------
// Date helpers
//
// Why home-grown instead of pulling in date-fns:
// - Single-purpose, ~25 lines total, easy to test deterministically
// - Avoids adding a runtime dep + bundle size
// - ISO date strings are how we serialize anyway — Date objects only
//   exist transiently in this module
// -----------------------------------------------------------------------

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isoToDate(s: string): Date {
  // Append T00:00:00Z so it's UTC midnight (no DST shifting). Output is
  // also UTC-based, so adding/subtracting whole days stays stable.
  return new Date(`${s}T00:00:00Z`);
}

function isoFromDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

function firstOfMonth(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(1);
  return out;
}

function lastOfMonth(d: Date): Date {
  // Roll forward to the first of next month, then back one day.
  const next = firstOfMonth(addMonths(d, 1));
  return addDays(next, -1);
}

/**
 * Defensive accessor for nested context-config values. The Zod schema
 * permits `negation.asin_negation` (and other config blocks) as `unknown`
 * so callers can shape them per-skill. Reads return a number when valid,
 * fallback otherwise.
 */
function readNumberFromUnknownObject(
  obj: unknown,
  key: string,
  fallback: number,
): number {
  if (typeof obj !== 'object' || obj === null) return fallback;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
