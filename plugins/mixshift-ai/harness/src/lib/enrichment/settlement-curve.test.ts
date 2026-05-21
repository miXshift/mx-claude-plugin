import { describe, it, expect } from 'vitest';
import { computeSettlementCurve, type CS28Row } from './settlement-curve.js';

describe('computeSettlementCurve — empty input', () => {
  it('returns null for empty rows', () => {
    expect(computeSettlementCurve([])).toBeNull();
  });
});

describe('computeSettlementCurve — basic math', () => {
  /**
   * Single SP campaign, single DOW.
   * spend $100, sales_1day $200, sales_7day $400, sales_14day $500.
   *   ACOS 1d = 100/200 * 100 = 50%
   *   ACOS 7d = 100/400 * 100 = 25%
   *   ACOS 14d = 100/500 * 100 = 20%
   *   improvement_1_to_7 = 50 - 25 = 25
   *   improvement_1_to_14 = 50 - 20 = 30
   *   settled_pct_at_1day = 200/500 * 100 = 40%
   */
  it('computes per-CT ACoS at 1d/7d/14d', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'sponsoredProducts',
        dow: 2, // monday
        spend: 100,
        sales_1day: 200,
        sales_7day: 400,
        sales_14day: 500,
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts).toMatchObject({
      acos_1day: 50,
      acos_7day: 25,
      acos_14day: 20,
      improvement_pts_1_to_7: 25,
      improvement_pts_1_to_14: 30,
      settled_pct_at_1day: 40,
      status: 'computed',
    });
  });

  it('marks insufficient_data when 14-day sales are zero', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'sponsoredProducts',
        dow: 2,
        spend: 100,
        sales_1day: 200,
        sales_7day: 0,
        sales_14day: 0,
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts.status).toBe('insufficient_data');
    expect(curve.by_campaign_type.sponsoredProducts.acos_14day).toBeNull();
  });

  it('emits insufficient_data slots for CTs not present in input', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'sponsoredProducts',
        dow: 2,
        spend: 100,
        sales_1day: 200,
        sales_7day: 400,
        sales_14day: 500,
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredBrands.status).toBe('insufficient_data');
    expect(curve.by_campaign_type.sponsoredDisplay.status).toBe('insufficient_data');
  });
});

describe('computeSettlementCurve — DOW offsets', () => {
  it('computes per-DOW improvement and deviates from global mean', () => {
    // Build rows for all 7 DOWs with the same shape — global mean of
    // improvements is constant, so offsets should all be ~0.
    const rows: CS28Row[] = [];
    for (let dow = 1; dow <= 7; dow++) {
      rows.push({
        campaign_type: 'sponsoredProducts',
        dow,
        spend: 100,
        sales_1day: 200,
        sales_7day: 400,
        sales_14day: 500,
      });
    }
    const curve = computeSettlementCurve(rows)!;
    // All DOWs have the same improvement → offsets ≈ 0
    for (const name of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
      expect(Math.abs((curve.dow_offset_pts as Record<string, number>)[name]!)).toBeLessThan(0.01);
    }
  });

  it('flags positive offsets for DOWs that settle slower', () => {
    // Monday: high gap (slow settlement, big improvement from fresh→settled)
    // Other days: low gap. Monday offset should be positive (above mean).
    const rows: CS28Row[] = [];
    // Monday: 1d ACOS 80%, 14d ACOS 20% → improvement 60
    rows.push({
      campaign_type: 'sponsoredProducts',
      dow: 2,
      spend: 100,
      sales_1day: 125,
      sales_14day: 500,
    });
    // Sun, Tue-Sat: 1d ACOS 30%, 14d ACOS 25% → improvement 5
    for (const dow of [1, 3, 4, 5, 6, 7]) {
      rows.push({
        campaign_type: 'sponsoredProducts',
        dow,
        spend: 100,
        sales_1day: 333.33,
        sales_14day: 400,
      });
    }
    const curve = computeSettlementCurve(rows)!;
    const monOffset = (curve.dow_offset_pts as Record<string, number>).monday!;
    // Mean of improvements = (60 + 5*6)/7 = 12.86 → monday offset = 60 - 12.86 = ~47
    expect(monOffset).toBeGreaterThan(40);
    const tueOffset = (curve.dow_offset_pts as Record<string, number>).tuesday!;
    expect(tueOffset).toBeLessThan(0); // below the high-monday-driven mean
  });
});

describe('computeSettlementCurve — stability score', () => {
  it('returns "low" when fewer than 5 DOWs have computable improvement', () => {
    const rows: CS28Row[] = [];
    for (const dow of [1, 2, 3]) {
      rows.push({
        campaign_type: 'sponsoredProducts',
        dow,
        spend: 100,
        sales_1day: 200,
        sales_14day: 500,
      });
    }
    const curve = computeSettlementCurve(rows)!;
    expect(curve.stability_score).toBe('low');
  });

  it('returns "high" when DOW improvements are tightly clustered', () => {
    // All 7 DOWs with same improvement → stddev = 0 → high
    const rows: CS28Row[] = [];
    for (let dow = 1; dow <= 7; dow++) {
      rows.push({
        campaign_type: 'sponsoredProducts',
        dow,
        spend: 100,
        sales_1day: 200,
        sales_14day: 500,
      });
    }
    const curve = computeSettlementCurve(rows)!;
    expect(curve.stability_score).toBe('high');
  });
});

describe('computeSettlementCurve — input tolerance', () => {
  it('handles string-encoded numbers from JSON dumps', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'sponsoredProducts',
        dow: '2', // string
        spend: '100.00',
        sales_1day: '200',
        sales_7day: '400',
        sales_14day: '500',
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts.acos_14day).toBe(20);
  });

  it('drops rows with unknown campaign_type', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'somethingElse',
        dow: 2,
        spend: 100,
        sales_1day: 200,
        sales_14day: 500,
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts.status).toBe('insufficient_data');
  });

  it('accepts SP/SB/SD shorthand', () => {
    const rows: CS28Row[] = [
      { campaign_type: 'SP', dow: 2, spend: 100, sales_1day: 200, sales_14day: 500 },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts.status).toBe('computed');
  });

  it('handles null sales fields gracefully', () => {
    const rows: CS28Row[] = [
      {
        campaign_type: 'sponsoredProducts',
        dow: 2,
        spend: 100,
        sales_1day: null as unknown,
        sales_7day: null as unknown,
        sales_14day: null as unknown,
      },
    ];
    const curve = computeSettlementCurve(rows)!;
    expect(curve.by_campaign_type.sponsoredProducts.status).toBe('insufficient_data');
  });
});
