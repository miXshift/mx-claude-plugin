/**
 * Compute the standard parameter map for SQL library queries.
 *
 * Every query in the library is parameterized by `:name` tokens. The
 * legacy `pre-fetch-data.py` defined a fixed set of standard params
 * derived from brand context + the run date:
 *
 *   :seller_id                primary account's SellerID (int)
 *   :seller_id_list           ALL account SellerIDs in this brand (int[])
 *   :run_date                 ISO date string (YYYY-MM-DD)
 *   :yesterday                run_date - 1 day (ISO)
 *   :lookback_days            default 30, override via paramOverrides
 *   :limit                    default 1000, override via paramOverrides
 *   :spend_floor              default 5, override via paramOverrides
 *   :month_start              first day of run_date's month (ISO)
 *   :curr_month               alias for :month_start (legacy compat)
 *   :prior_month              first day of previous month (ISO)
 *   :prior_year_month         first day of same month one year prior (ISO)
 *   :days_of_supply_threshold default 14, override via paramOverrides
 *
 * Skill-specific or per-query overrides are merged in via `paramOverrides`.
 *
 * The output is a plain object suitable for mysql2 with
 * `namedPlaceholders: true`. Arrays are kept as arrays — the substitution
 * step inlines them as CSV before the SQL hits mysql2.
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

  const runDateD = isoToDate(runDate);
  const yesterday = isoFromDate(addDays(runDateD, -1));
  const monthStart = isoFromDate(firstOfMonth(runDateD));
  const priorMonthStart = isoFromDate(firstOfMonth(addMonths(runDateD, -1)));
  const priorYearMonthStart = isoFromDate(
    firstOfMonth(addMonths(runDateD, -12)),
  );

  const standard: ParamMap = {
    seller_id: Number(primary.seller_id),
    seller_id_list: sellerIdList,
    run_date: runDate,
    yesterday,
    lookback_days: 30,
    limit: 1000,
    spend_floor: 5,
    month_start: monthStart,
    curr_month: monthStart, // legacy alias
    prior_month: priorMonthStart,
    prior_year_month: priorYearMonthStart,
    days_of_supply_threshold: 14,
  };

  return { ...standard, ...paramOverrides };
}

// -----------------------------------------------------------------------
// Date helpers
//
// Why home-grown instead of pulling in date-fns:
// - Single-purpose, ~15 lines total, easy to test deterministically
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
