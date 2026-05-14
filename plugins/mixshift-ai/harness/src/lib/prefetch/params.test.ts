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
});
