/**
 * Product-level ACoS targets (mx-ops#291): the reader and the per-row rule.
 */

import { describe, it, expect } from 'vitest';
import {
  extractProductAcosTargets,
  chooseAcosTarget,
  MIXED_ROW_NOTE,
  NO_PRODUCT_NOTE,
  NOT_AN_ASIN_REASON,
  PRODUCT_TARGET_RULE,
} from './product-targets.js';

describe('extractProductAcosTargets', () => {
  it('returns null when the brand sets no product targets', () => {
    expect(extractProductAcosTargets(null)).toBeNull();
    expect(extractProductAcosTargets({})).toBeNull();
    expect(extractProductAcosTargets({ management: { acos_target_pct: 20 } })).toBeNull();
    // Unrelated thresholds are not product targets.
    expect(
      extractProductAcosTargets({ thresholds: { forecast_actual_tolerance_pct: 5, buy_box_floor: 92 } }),
    ).toBeNull();
  });

  it('reads the canonical per-ASIN and per-SKU maps (whole percents)', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        acos_target_by_asin: { B0TESTAAA1: 25, b0testaaa2: 35 },
        acos_target_by_sku: { 'SKU-RED-01': 30 },
      },
    });
    expect(t).not.toBeNull();
    expect(t!.by_asin).toEqual({ B0TESTAAA1: 25, B0TESTAAA2: 35 });
    expect(t!.by_sku).toEqual({ 'SKU-RED-01': 30 });
    expect(t!.source_paths).toEqual([
      'thresholds.acos_target_by_asin',
      'thresholds.acos_target_by_sku',
    ]);
    expect(t!.skipped).toEqual([]);
    expect(t!.rule).toBe(PRODUCT_TARGET_RULE);
  });

  it('reads alias key names, string and object values, and list rows', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        asin_acos_targets: { B0TESTAAA1: '25%', B0TESTAAA2: { acos_target_pct: 40 } },
        sku_target_acos: [
          { sku: 'SKU-A', target_acos: 18 },
          { seller_sku: 'SKU-B', acos: '22' },
        ],
      },
    });
    expect(t!.by_asin).toEqual({ B0TESTAAA1: 25, B0TESTAAA2: 40 });
    expect(t!.by_sku).toEqual({ 'SKU-A': 18, 'SKU-B': 22 });
  });

  it('reads a nested block with asin and sku maps', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        product_acos_targets: { by_asin: { B0TESTAAA1: 25 }, by_sku: { 'SKU-A': 30 } },
      },
    });
    expect(t!.by_asin).toEqual({ B0TESTAAA1: 25 });
    expect(t!.by_sku).toEqual({ 'SKU-A': 30 });
    expect(t!.source_paths).toEqual([
      'thresholds.product_acos_targets.by_asin',
      'thresholds.product_acos_targets.by_sku',
    ]);
  });

  it('reads a fraction below 1 as a share of 100', () => {
    const t = extractProductAcosTargets({ thresholds: { acos_target_by_asin: { B0TESTAAA1: 0.25 } } });
    expect(t!.by_asin.B0TESTAAA1).toBe(25);
  });

  it('reads a value written with a percent sign as a percent, never as a fraction (Q F5)', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        acos_target_by_asin: { B0TESTAAA1: '0.5%', B0TESTAAA2: '1%', B0TESTAAA3: { acos_target_pct: '0.75 %' } },
        acos_target_by_sku: { 'SKU-A': '0.5%' },
      },
    });
    expect(t!.by_asin).toEqual({ B0TESTAAA1: 0.5, B0TESTAAA2: 1, B0TESTAAA3: 0.75 });
    expect(t!.by_sku).toEqual({ 'SKU-A': 0.5 });
    expect(t!.skipped).toEqual([]);
    // A bare fraction (no percent sign) is still read as a share of 100.
    const bare = extractProductAcosTargets({ thresholds: { acos_target_by_asin: { B0TESTAAA1: 0.5, B0TESTAAA2: '0.5' } } });
    expect(bare!.by_asin).toEqual({ B0TESTAAA1: 50, B0TESTAAA2: 50 });
  });

  it('skips an ASIN key that is not 10 letters and digits, with the reason (Q F4)', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        acos_target_by_asin: { 'B0TESTAAA1:UK': 25, B0TESTAAA2_DE: 30, B0SHORT: 20, B0TESTAAA3: 35 },
        asin_acos_targets: [{ asin: 'B0TESTAAA4-US', acos_target_pct: 40 }],
      },
    });
    expect(t!.by_asin).toEqual({ B0TESTAAA3: 35 });
    expect(t!.skipped).toEqual([
      { path: 'thresholds.acos_target_by_asin', id: 'B0TESTAAA1:UK', reason: NOT_AN_ASIN_REASON },
      { path: 'thresholds.acos_target_by_asin', id: 'B0TESTAAA2_DE', reason: NOT_AN_ASIN_REASON },
      { path: 'thresholds.acos_target_by_asin', id: 'B0SHORT', reason: NOT_AN_ASIN_REASON },
      { path: 'thresholds.asin_acos_targets', id: 'B0TESTAAA4-US', reason: NOT_AN_ASIN_REASON },
    ]);
    // An ASIN key with spaces around it or in lower case is still an ASIN.
    const ok = extractProductAcosTargets({ thresholds: { acos_target_by_asin: { ' b0testaaa1 ': 25 } } });
    expect(ok!.by_asin).toEqual({ B0TESTAAA1: 25 });
    expect(ok!.skipped).toEqual([]);
  });

  it('an empty map counts as no map: null, so no key is added (Q F3)', () => {
    expect(extractProductAcosTargets({ thresholds: { acos_target_by_asin: {} } })).toBeNull();
    expect(
      extractProductAcosTargets({ thresholds: { acos_target_by_asin: {}, acos_target_by_sku: [] } }),
    ).toBeNull();
    expect(extractProductAcosTargets({ thresholds: { product_acos_targets: { by_asin: {} } } })).toBeNull();
    // A map whose only entries were skipped still returns, so the reasons are shown.
    const t = extractProductAcosTargets({ thresholds: { acos_target_by_asin: { 'B0TESTAAA1:UK': 25 } } });
    expect(t).not.toBeNull();
    expect(t!.by_asin).toEqual({});
    expect(t!.skipped).toHaveLength(1);
  });

  it('lists entries it cannot read instead of dropping them silently', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        acos_target_by_asin: { B0TESTAAA1: 'high', B0TESTAAA2: -5, B0TESTAAA3: 5000, B0TESTAAA4: 30 },
      },
    });
    expect(t!.by_asin).toEqual({ B0TESTAAA4: 30 });
    expect(t!.skipped.map((s) => s.id)).toEqual(['B0TESTAAA1', 'B0TESTAAA2', 'B0TESTAAA3']);
    expect(t!.skipped.every((s) => s.path === 'thresholds.acos_target_by_asin')).toBe(true);
  });

  it('keeps the canonical value when an alias disagrees, and says so', () => {
    const t = extractProductAcosTargets({
      thresholds: {
        asin_acos_targets: { B0TESTAAA1: 40 },
        acos_target_by_asin: { B0TESTAAA1: 25 },
      },
    });
    expect(t!.by_asin.B0TESTAAA1).toBe(25);
    expect(t!.skipped).toHaveLength(1);
    expect(t!.skipped[0]!.path).toBe('thresholds.asin_acos_targets');
  });
});

describe('chooseAcosTarget (the per-row rule)', () => {
  const targets = extractProductAcosTargets({
    thresholds: {
      acos_target_by_asin: { B0TESTAAA1: 25, B0TESTAAA2: 25, B0TESTAAA3: 40 },
      acos_target_by_sku: { 'SKU-C': 30 },
    },
  });

  it('without product targets: always the brand target, no note (behaviour before #291)', () => {
    expect(chooseAcosTarget(null, 20, [{ asin: 'B0TESTAAA1' }])).toEqual({ value: 20, source: 'brand' });
    expect(chooseAcosTarget(undefined, 20)).toEqual({ value: 20, source: 'brand' });
    expect(chooseAcosTarget(null, null)).toEqual({ value: null, source: 'brand' });
  });

  it('a row with one product uses its ASIN target, else its SKU target', () => {
    expect(chooseAcosTarget(targets, 20, [{ asin: 'b0testaaa3' }])).toEqual({ value: 40, source: 'asin' });
    expect(chooseAcosTarget(targets, 20, [{ asin: 'B0NOTARGET', sku: 'SKU-C' }])).toEqual({
      value: 30,
      source: 'sku',
    });
  });

  it('a product with no target uses the brand target', () => {
    expect(chooseAcosTarget(targets, 20, [{ asin: 'B0NOTARGET' }])).toEqual({ value: 20, source: 'brand' });
  });

  it('products that agree share the target', () => {
    expect(chooseAcosTarget(targets, 20, [{ asin: 'B0TESTAAA1' }, { asin: 'B0TESTAAA2' }])).toEqual({
      value: 25,
      source: 'asin',
    });
  });

  it('a mixed row falls back to the brand target and says so', () => {
    expect(chooseAcosTarget(targets, 20, [{ asin: 'B0TESTAAA1' }, { asin: 'B0TESTAAA3' }])).toEqual({
      value: 20,
      source: 'brand',
      note: MIXED_ROW_NOTE,
    });
    // One product with a target and one on the brand target is mixed too.
    expect(chooseAcosTarget(targets, 20, [{ asin: 'B0TESTAAA1' }, { asin: 'B0NOTARGET' }])).toEqual({
      value: 20,
      source: 'brand',
      note: MIXED_ROW_NOTE,
    });
  });

  it('a row naming no product uses the brand target and says so', () => {
    expect(chooseAcosTarget(targets, 20, [])).toEqual({ value: 20, source: 'brand', note: NO_PRODUCT_NOTE });
  });
});
