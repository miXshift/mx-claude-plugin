/**
 * Per-label economics + lifecycle (mx-ops#6).
 *
 * The behaviours pinned here are the ones a customer reported and the ones
 * most likely to be quietly regressed later:
 *   - money arrives from the wire as STRINGS and must not be concatenated;
 *   - SC and VC revenue for one label ADD rather than overwrite;
 *   - lifecycle is read from observable activity only;
 *   - absent evidence resolves to `unknown`, never to `dormant`.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleEconomics,
  classifyLifecycle,
  coerceRetailEconRow,
  coerceAdsEconRow,
  coerceVendorEconRow,
  unknownEconomics,
  fmtMoney,
  MIN_WEIGHT_FOR_LIFECYCLE,
  RECENT_ACTIVITY_SHARE,
} from './economics.js';

describe('economics wire coercion', () => {
  it('coerces string money and counts to numbers (bigNumberStrings hazard)', () => {
    // The gateway pool runs bigNumberStrings:true, so SUM()/COUNT() and
    // DECIMAL columns all arrive as strings. Adding two of these without
    // coercion concatenates ("40" + "25" -> "4025") and silently corrupts
    // every total downstream.
    const row = coerceRetailEconRow({
      SellerID: '3',
      source: 'mws_items.Brand',
      label: 'X',
      revenue_365d: '6400000.00',
      revenue_90d: '1800000.50',
      units_365d: '91000',
      last_order_at: '2026-08-18 00:00:00',
      sku_count: '412',
    });
    expect(row.revenue_365d).toBe(6_400_000);
    expect(row.revenue_90d).toBeCloseTo(1_800_000.5, 2);
    expect(row.units_365d).toBe(91_000);
    expect(row.sku_count).toBe(412);
    expect(typeof row.revenue_365d).toBe('number');
  });

  it('degrades a malformed amount to 0 rather than NaN-poisoning every sum', () => {
    const row = coerceAdsEconRow({
      SellerID: 3,
      source: 'campaign.Brand',
      label: 'X',
      spend_365d: 'not-a-number',
      spend_90d: '',
      ad_sales_365d: '10',
      last_spend_at: null,
      campaigns_with_spend: '2',
    });
    expect(row.spend_365d).toBe(0);
    expect(row.spend_90d).toBe(0);
    expect(row.ad_sales_365d).toBe(10);
    expect(row.last_spend_at).toBeNull();
  });

  it('normalizes a blank timestamp to null, not an empty string', () => {
    const row = coerceVendorEconRow({
      SellerID: 9,
      source: 'vendor_items.CustomBrand',
      label: 'X',
      revenue_365d: '1',
      revenue_90d: '0',
      units_365d: '1',
      last_order_at: '   ',
      asin_count: '1',
    });
    expect(row.last_order_at).toBeNull();
  });
});

describe('classifyLifecycle', () => {
  it('calls a label with recent activity active', () => {
    const { lifecycle } = classifyLifecycle(1_000_000, 300_000, 100_000, 30_000);
    expect(lifecycle).toBe('active');
  });

  it('calls a label with a real trailing year but nothing recent dormant', () => {
    // The reported shape: money last year, silence since.
    const { lifecycle, reason } = classifyLifecycle(842_000, 0, 0, 0);
    expect(lifecycle).toBe('dormant');
    expect(reason).toContain('nothing at all in the last 90');
  });

  it('calls a label dormant when recent activity is a negligible share', () => {
    const { lifecycle } = classifyLifecycle(1_000_000, 5_000, 0, 0);
    expect(lifecycle).toBe('dormant');
  });

  it('does NOT call a merely-declining brand dormant', () => {
    // A perfectly flat year puts ~24.7% in any 90-day window. A brand at
    // 10% is down sharply but plainly still trading, and flagging it would
    // hide a live brand from an operator looking for it.
    const { lifecycle } = classifyLifecycle(1_000_000, 100_000, 0, 0);
    expect(lifecycle).toBe('active');
    expect(0.1).toBeGreaterThan(RECENT_ACTIVITY_SHARE);
  });

  it('returns unknown, never dormant, when there is no evidence either way', () => {
    // Absent data must not read as evidence of death: being wrong toward
    // "dormant" hides a real brand.
    const { lifecycle } = classifyLifecycle(0, 0, 0, 0);
    expect(lifecycle).toBe('unknown');
  });

  it('returns unknown for a label too small to judge', () => {
    const { lifecycle } = classifyLifecycle(MIN_WEIGHT_FOR_LIFECYCLE - 1, 0, 0, 0);
    expect(lifecycle).toBe('unknown');
  });

  it('counts ad spend as activity even with zero revenue', () => {
    // Spend with no sales is a live (if unprofitable) brand, and on the
    // customer's own framing it is the most urgent kind to surface — not
    // something to quietly mark dead.
    const { lifecycle } = classifyLifecycle(0, 0, 200_000, 60_000);
    expect(lifecycle).toBe('active');
  });
});

describe('assembleEconomics', () => {
  const retail = (label: string, r365: number, r90: number, stamp: string | null = null) => ({
    SellerID: 3,
    source: 'mws_items.Brand',
    label,
    revenue_365d: r365,
    revenue_90d: r90,
    units_365d: 0,
    last_order_at: stamp,
    sku_count: 0,
  });
  const ads = (label: string, s365: number, s90: number, stamp: string | null = null) => ({
    SellerID: 3,
    source: 'campaign.Brand',
    label,
    spend_365d: s365,
    spend_90d: s90,
    ad_sales_365d: 0,
    last_spend_at: stamp,
    campaigns_with_spend: 0,
  });
  const vendor = (label: string, r365: number, r90: number, stamp: string | null = null) => ({
    SellerID: 3,
    source: 'vendor_items.CustomBrand',
    label,
    revenue_365d: r365,
    revenue_90d: r90,
    units_365d: 0,
    last_order_at: stamp,
    asin_count: 0,
  });

  // mx-ops#6 red team, P3: economics keyed the RAW wire label while every
  // coverage side keys normalizeLabel(). A label arriving padded on one side
  // and clean on the other produced two keys that never joined, so the
  // candidate silently lost its economics and then read as a brand with no
  // money behind it — which the negligible gate would hold back.
  it('keys on the normalized label, so a padded value joins its clean twin', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('  Forager Pantry  ', 100_000, 40_000)],
      adsEconRows: [ads('Forager Pantry', 10_000, 4_000)],
      vendorEconRows: [],
    });
    expect([...out.keys()]).toEqual(['Forager Pantry']);
    const e = out.get('Forager Pantry')!;
    expect(e.revenue_365d).toBe(100_000);
    expect(e.spend_365d).toBe(10_000);
    expect(e.economic_weight).toBe(110_000);
  });

  it('folds a blank label into the unclassified bucket rather than keying ""', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('   ', 5_000, 1_000)],
      adsEconRows: [],
      vendorEconRows: [],
    });
    expect([...out.keys()]).toEqual(['(unclassified)']);
  });

  // The label COLUMN each side reported has to survive assembly: an
  // economics-only candidate has no coverage row to take a source from, and
  // without one it reaches the write path with no label filter at all.
  it('carries the retail and ads label columns through', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('Forager Pantry', 100_000, 40_000)],
      adsEconRows: [ads('Forager Pantry', 10_000, 4_000)],
      vendorEconRows: [],
    });
    const e = out.get('Forager Pantry')!;
    expect(e.retail_source).toBe('mws_items.Brand');
    expect(e.ads_source).toBe('campaign.Brand');
    expect(e.has_data).toBe(true);
  });

  it('takes the vendor column as the retail source when only VC saw the label', () => {
    const out = assembleEconomics({
      retailEconRows: [],
      adsEconRows: [],
      vendorEconRows: [vendor('Alpine Trail', 20_000, 8_000)],
    });
    const e = out.get('Alpine Trail')!;
    expect(e.retail_source).toBe('vendor_items.CustomBrand');
    expect(e.ads_source).toBeNull();
  });

  it('marks an assembled label as measured even when every figure is zero', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('Zeroed Brand', 0, 0)],
      adsEconRows: [],
      vendorEconRows: [],
    });
    // has_data distinguishes "we looked and it earned nothing" from "we never
    // saw a row" — the two must never collapse into the same signal.
    expect(out.get('Zeroed Brand')!.has_data).toBe(true);
    expect(unknownEconomics('Never Seen').has_data).toBe(false);
  });

  it('sums SC and VC revenue for one label rather than letting one win', () => {
    // A brand can legitimately sell on both sides of the business; the
    // account's real revenue for it is the sum, and taking either alone
    // under-ranks it.
    const out = assembleEconomics({
      retailEconRows: [retail('Both Sides', 100_000, 30_000)],
      vendorEconRows: [vendor('Both Sides', 50_000, 20_000)],
      adsEconRows: [],
    });
    const e = out.get('Both Sides')!;
    expect(e.revenue_365d).toBe(150_000);
    expect(e.revenue_90d).toBe(50_000);
  });

  it('weights a label by revenue PLUS spend', () => {
    // Ranking on revenue alone under-ranks a brand that is small in
    // catalog but consumes a large share of the account's ad spend.
    const out = assembleEconomics({
      retailEconRows: [retail('A', 10_000, 5_000)],
      adsEconRows: [ads('A', 90_000, 40_000)],
      vendorEconRows: [],
    });
    expect(out.get('A')!.economic_weight).toBe(100_000);
  });

  it('keeps a label that exists on only the ads side', () => {
    const out = assembleEconomics({
      retailEconRows: [],
      adsEconRows: [ads('Ads Only', 60_000, 20_000)],
      vendorEconRows: [],
    });
    expect(out.get('Ads Only')?.spend_365d).toBe(60_000);
  });

  it('reports the latest activity stamp across all three sides', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('A', 1, 1, '2026-06-01 00:00:00')],
      adsEconRows: [ads('A', 1, 1, '2026-08-18 00:00:00')],
      vendorEconRows: [vendor('A', 1, 1, '2026-07-04 00:00:00')],
    });
    expect(out.get('A')!.last_activity_at).toBe('2026-08-18 00:00:00');
  });

  it('classifies each label independently', () => {
    const out = assembleEconomics({
      retailEconRows: [retail('Live', 1_000_000, 300_000), retail('Dead', 800_000, 0)],
      adsEconRows: [],
      vendorEconRows: [],
    });
    expect(out.get('Live')!.lifecycle).toBe('active');
    expect(out.get('Dead')!.lifecycle).toBe('dormant');
  });
});

describe('unknownEconomics', () => {
  it('is unknown, not dormant — missing data must never read as dead', () => {
    const e = unknownEconomics('Nobody');
    expect(e.lifecycle).toBe('unknown');
    expect(e.economic_weight).toBe(0);
    expect(e.lifecycle_reason).toContain('no economics data');
  });
});

describe('fmtMoney', () => {
  it('renders whole dollars with separators and no currency symbol', () => {
    // No symbol on purpose: a multi-marketplace account's rows are in local
    // currency and this module does not convert, so asserting "$" could be
    // actively wrong.
    expect(fmtMoney(6_400_000.49)).toBe('6,400,000');
    expect(fmtMoney(695)).toBe('695');
    expect(fmtMoney(0)).toBe('0');
  });
});
