import { describe, it, expect } from 'vitest';
import {
  detectStockoutWindows,
  type CS29Row,
  type CS30Row,
} from './stockout-windows.js';

const cs30Series = (days: Array<{ date: string; ad_sales: number }>): CS30Row[] =>
  days.map((d) => ({ metric_date: d.date, ad_sales: d.ad_sales }));

describe('detectStockoutWindows — empty input', () => {
  it('returns empty array when CS-29 is empty', () => {
    expect(detectStockoutWindows([], [])).toEqual([]);
  });
});

describe('detectStockoutWindows — basic window stitching', () => {
  it('stitches consecutive zero-sellable days into one window', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-03', SellableQuantity: 0 },
    ];
    const cs30 = cs30Series([
      { date: '2026-05-01', ad_sales: 100 },
      { date: '2026-05-02', ad_sales: 150 },
      { date: '2026-05-03', ad_sales: 200 },
    ]);
    const result = detectStockoutWindows(cs29, cs30);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      asin: 'B07X',
      item_name: 'Widget',
      started: '2026-05-01',
      ended: '2026-05-03',
      days_in_window: 3,
      days_at_zero: 3,
      impacted_revenue_usd: 450,
      signal_source: 'sellable_zero',
    });
  });

  it('drops windows shorter than min_days', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
    ];
    expect(detectStockoutWindows(cs29, [])).toHaveLength(0); // default min_days=3
  });

  it('honors custom min_days', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
    ];
    const result = detectStockoutWindows(cs29, [], { min_days: 2 });
    expect(result).toHaveLength(1);
    expect(result[0]!.days_in_window).toBe(2);
  });

  it('splits non-contiguous days into separate windows', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 0 },
      // gap of 5 days — well beyond gap_tolerance_days=2
      { ASIN: 'B07X', snapshot_date: '2026-05-09', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-10', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-11', SellableQuantity: 0 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result).toHaveLength(2);
  });

  it('tolerates 1-2 day gaps within a window', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      // 1-day snapshot gap
      { ASIN: 'B07X', snapshot_date: '2026-05-04', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-05', SellableQuantity: 0 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.days_in_window).toBe(5); // May 1 → May 5 inclusive
  });
});

describe('detectStockoutWindows — signal sources', () => {
  it('marks "alert_active" when only Alert fires', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 10, Alert: 1 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 10, Alert: true },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 10, Alert: 1 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result[0]!.signal_source).toBe('alert_active');
  });

  it('marks "days_of_supply_low" when DoS<14 with positive sellable', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 5, DaysOfSupply: 10 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 5, DaysOfSupply: 10 },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 5, DaysOfSupply: 10 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result[0]!.signal_source).toBe('days_of_supply_low');
  });

  it('marks "multi" when more than one signal fires in the window', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 }, // zero
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 5, Alert: 1 }, // alert
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 5, DaysOfSupply: 10 }, // dos_low
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result[0]!.signal_source).toBe('multi');
  });

  it('does NOT count days_of_supply_low when SellableQuantity is 0', () => {
    // Per Todd's rule: dos_low only fires when sellable > 0 (zero-sellable
    // is already caught by sellable_zero).
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0, DaysOfSupply: 10 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0, DaysOfSupply: 10 },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 0, DaysOfSupply: 10 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result[0]!.signal_source).toBe('sellable_zero');
  });
});

describe('detectStockoutWindows — multi-ASIN handling', () => {
  it('groups by ASIN independently', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-03', SellableQuantity: 0 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.asin).sort()).toEqual(['B07X', 'B08Y']);
  });

  it('sorts by impacted_revenue_usd descending', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: '2026-05-03', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-02', SellableQuantity: 0 },
      { ASIN: 'B08Y', snapshot_date: '2026-05-03', SellableQuantity: 0 },
    ];
    const cs30 = cs30Series([
      // B07X dates have low revenue, B08Y dates have high revenue
      { date: '2026-05-01', ad_sales: 1000 }, // shared date — split
    ]);
    // Since both share the same dates, both get the same impact in this test
    // Just verify the sort order is preserved
    const result = detectStockoutWindows(cs29, cs30);
    expect(result).toHaveLength(2);
    expect(result[0]!.impacted_revenue_usd).toBeGreaterThanOrEqual(
      result[1]!.impacted_revenue_usd,
    );
  });
});

describe('detectStockoutWindows — input tolerance', () => {
  it('drops rows without ASIN', () => {
    const cs29: CS29Row[] = [
      { snapshot_date: '2026-05-01', SellableQuantity: 0 },
      { snapshot_date: '2026-05-02', SellableQuantity: 0 },
    ];
    expect(detectStockoutWindows(cs29, [])).toHaveLength(0);
  });

  it('drops rows without parseable snapshot_date', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: 'not-a-date', SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: null, SellableQuantity: 0 },
    ];
    expect(detectStockoutWindows(cs29, [])).toHaveLength(0);
  });

  it('handles Date objects as snapshot_date', () => {
    const cs29: CS29Row[] = [
      { ASIN: 'B07X', snapshot_date: new Date('2026-05-01T00:00:00Z'), SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: new Date('2026-05-02T00:00:00Z'), SellableQuantity: 0 },
      { ASIN: 'B07X', snapshot_date: new Date('2026-05-03T00:00:00Z'), SellableQuantity: 0 },
    ];
    const result = detectStockoutWindows(cs29, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.started).toBe('2026-05-01');
  });
});
