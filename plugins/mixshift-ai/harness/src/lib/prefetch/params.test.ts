import { describe, expect, it } from 'vitest';
import { buildStandardParams } from './params.js';
import type { BrandContext } from '../context/schema.js';

function makeContext(overrides?: Partial<BrandContext>): BrandContext {
  return {
    schema_version: 1,
    brand_slug: 'testbrand',
    brand_name: 'Test Brand',
    last_updated: '2026-04-25',
    accounts: [
      {
        seller_id: 111,
        seller_name: 'Test SC',
        account_type: 'SC',
        status: 'active',
        role: 'primary',
      },
      {
        seller_id: 222,
        seller_name: 'Test VC',
        account_type: 'VC',
        status: 'active',
        role: 'secondary',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    },
    management: {
      primary_metric: 'ACOS',
      acos_target_pct: 20,
      attribution_window_days: 14,
    },
    ...overrides,
  } as BrandContext;
}

describe('buildStandardParams', () => {
  it('extracts primary seller_id + full seller_id_list from context', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
    });
    expect(params.seller_id).toBe(111);
    expect(params.seller_id_list).toEqual([111, 222]);
  });

  it('derives yesterday / month_start / prior_month / prior_year_month for mid-month', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-15',
    });
    expect(params.yesterday).toBe('2026-04-14');
    expect(params.month_start).toBe('2026-04-01');
    expect(params.curr_month).toBe('2026-04-01'); // legacy alias
    expect(params.prior_month).toBe('2026-03-01');
    expect(params.prior_year_month).toBe('2025-04-01');
  });

  it('handles month boundary correctly (run_date = 1st)', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-01',
    });
    expect(params.yesterday).toBe('2026-03-31');
    expect(params.month_start).toBe('2026-04-01');
    expect(params.prior_month).toBe('2026-03-01');
  });

  it('handles year boundary correctly (run_date = Jan 1)', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-01-01',
    });
    expect(params.yesterday).toBe('2025-12-31');
    expect(params.month_start).toBe('2026-01-01');
    expect(params.prior_month).toBe('2025-12-01');
    expect(params.prior_year_month).toBe('2025-01-01');
  });

  it('honors paramOverrides for tunables like lookback_days', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
      paramOverrides: { lookback_days: 7, spend_floor: 25 },
    });
    expect(params.lookback_days).toBe(7);
    expect(params.spend_floor).toBe(25);
    // Standard defaults still set for the others:
    expect(params.limit).toBe(1000);
    expect(params.days_of_supply_threshold).toBe(14);
  });

  it('falls back to first account when no role: primary', () => {
    const ctx = makeContext({
      accounts: [
        {
          seller_id: 333,
          seller_name: 'Alpha',
          account_type: 'SC',
          status: 'active',
          role: 'secondary',
        },
        {
          seller_id: 444,
          seller_name: 'Beta',
          account_type: 'SC',
          status: 'active',
          role: 'secondary',
        },
      ],
    });
    const params = buildStandardParams({ context: ctx, runDate: '2026-04-25' });
    expect(params.seller_id).toBe(333);
  });

  it('rejects malformed run_date', () => {
    expect(() =>
      buildStandardParams({ context: makeContext(), runDate: '2026/04/25' }),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      buildStandardParams({ context: makeContext(), runDate: 'today' }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('rejects context with zero accounts', () => {
    const ctx = makeContext({ accounts: [] as BrandContext['accounts'] });
    expect(() =>
      buildStandardParams({ context: ctx, runDate: '2026-04-25' }),
    ).toThrow(/no accounts/i);
  });

  it('derives window_start/window_end/current_month_end from run_date + lookback_days', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-15',
    });
    // window_end = yesterday (T-1)
    expect(params.window_end).toBe('2026-04-14');
    // window_start = run_date - lookback_days (default 30)
    expect(params.window_start).toBe('2026-03-16');
    // current_month_end = last day of run_date's month
    expect(params.current_month_end).toBe('2026-04-30');
    // Legacy aliases match the canonical fields
    expect(params.start_date).toBe(params.window_start);
    expect(params.end_date).toBe(params.window_end);
    expect(params.prior_month_start).toBe(params.prior_month);
  });

  it('shrinks window_start when paramOverrides reduces lookback_days', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-15',
      paramOverrides: { lookback_days: 7 },
    });
    // 2026-04-15 - 7 days = 2026-04-08
    expect(params.window_start).toBe('2026-04-08');
    expect(params.window_end).toBe('2026-04-14');
  });

  it('current_month_end handles February in a leap year', () => {
    const leap = buildStandardParams({
      context: makeContext(),
      runDate: '2024-02-15',
    });
    expect(leap.current_month_end).toBe('2024-02-29');
  });

  it('current_month_end handles 30-day and 31-day months', () => {
    const april = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-15',
    });
    expect(april.current_month_end).toBe('2026-04-30');
    const december = buildStandardParams({
      context: makeContext(),
      runDate: '2026-12-15',
    });
    expect(december.current_month_end).toBe('2026-12-31');
  });

  it('reads lifetime_orders_threshold from context.negation.asin_negation', () => {
    const ctx = makeContext({
      negation: {
        protected_terms: [],
        lane_rules: {},
        asin_negation: { pre_check_lifetime_orders_threshold: 5 },
      },
    });
    const params = buildStandardParams({ context: ctx, runDate: '2026-04-25' });
    expect(params.lifetime_orders_threshold).toBe(5);
  });

  it('falls back to default lifetime_orders_threshold when context lacks it', () => {
    const params = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
    });
    expect(params.lifetime_orders_threshold).toBe(3);
  });

  it('sets vc_lag=2 when primary is VC, vc_lag=1 when primary is SC', () => {
    const sc = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
    });
    expect(sc.vc_lag).toBe(1);
    const vc = buildStandardParams({
      context: makeContext({
        accounts: [
          {
            seller_id: 555,
            seller_name: 'Vendor Co',
            account_type: 'VC',
            status: 'active',
            role: 'primary',
          },
        ],
      }),
      runDate: '2026-04-25',
    });
    expect(vc.vc_lag).toBe(2);
  });

  it('utilization_threshold defaults to 0.9 and is overridable', () => {
    const a = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
    });
    expect(a.utilization_threshold).toBe(0.9);
    const b = buildStandardParams({
      context: makeContext(),
      runDate: '2026-04-25',
      paramOverrides: { utilization_threshold: 0.75 },
    });
    expect(b.utilization_threshold).toBe(0.75);
  });
});
