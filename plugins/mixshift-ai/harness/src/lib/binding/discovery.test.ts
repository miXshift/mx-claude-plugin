import { describe, it, expect } from 'vitest';
import {
  assembleRetailCoverage,
  assembleAdsCoverage,
  assembleMatch,
  assembleCoverageReport,
  classifyShape,
  normalizeLabel,
  UNCLASSIFIED_LABEL,
  type Sbd01RetailRow,
  type Sbd02AdsRow,
  type Sbd03VendorRow,
  type Sbd04MatchRow,
} from './discovery.js';

describe('normalizeLabel', () => {
  it('maps null/undefined/blank/whitespace-only to the unclassified bucket', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(normalizeLabel(v)).toBe(UNCLASSIFIED_LABEL);
    }
  });
  it('trims a real label but otherwise passes it through', () => {
    expect(normalizeLabel('  Forager Pantry  ')).toBe('Forager Pantry');
  });
  it('the literal (unclassified) sentinel already produced server-side passes through unchanged', () => {
    expect(normalizeLabel(UNCLASSIFIED_LABEL)).toBe(UNCLASSIFIED_LABEL);
  });
});

describe('assembleRetailCoverage', () => {
  const scRows: Sbd01RetailRow[] = [
    { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 80 },
    { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 50 },
    { SellerID: 1, source: 'mws_items.Brand', label: '', asin_count: 5, row_count: 5 },
  ];
  const vcRows: Sbd03VendorRow[] = [
    { SellerID: 2, source: 'vendor_items.CustomBrand', label: 'Forager Pantry', item_count: 10 },
  ];

  it('merges SC + VC rows sharing a label into one entry, summing units', () => {
    const coverage = assembleRetailCoverage(scRows, vcRows);
    const forager = coverage.labels.find((l) => l.label === 'Forager Pantry');
    expect(forager?.units).toBe(50); // 40 (SC asin_count) + 10 (VC item_count)
    expect(forager?.source).toBe('mws_items.Brand, vendor_items.CustomBrand');
  });

  it('counts distinct_labels excluding the unclassified bucket', () => {
    const coverage = assembleRetailCoverage(scRows, vcRows);
    expect(coverage.distinct_labels).toBe(2); // Forager Pantry, Alpine Trail
  });

  it('computes unclassified_units and unclassified_share correctly', () => {
    const coverage = assembleRetailCoverage(scRows, vcRows);
    // total = 40 + 25 + 5 + 10 = 80; unclassified = 5
    expect(coverage.total_units).toBe(80);
    expect(coverage.unclassified_units).toBe(5);
    expect(coverage.unclassified_share).toBeCloseTo(5 / 80, 6);
  });

  it('sorts labels descending by units', () => {
    const coverage = assembleRetailCoverage(scRows, vcRows);
    const units = coverage.labels.map((l) => l.units);
    expect(units).toEqual([...units].sort((a, b) => b - a));
  });

  it('tolerates empty inputs (no rows at all)', () => {
    const coverage = assembleRetailCoverage([], []);
    expect(coverage.total_units).toBe(0);
    expect(coverage.distinct_labels).toBe(0);
    expect(coverage.unclassified_share).toBe(0);
    expect(coverage.labels).toEqual([]);
  });
});

describe('assembleAdsCoverage — blank-heavy ads side (F24)', () => {
  // Design doc F24: ads-side blanks measured 59%/100%/58-80% on real nested
  // evidence accounts, far higher than retail. This fixture models that.
  const rows: Sbd02AdsRow[] = [
    { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 8 },
    { SellerID: 1, source: 'campaign.Brand', label: null as unknown as string, campaign_count: 60 },
    { SellerID: 1, source: 'campaign.Brand', label: '', campaign_count: 12 },
  ];

  it('rolls every blank/null label into ONE (unclassified) bucket', () => {
    const coverage = assembleAdsCoverage(rows);
    const unclassified = coverage.labels.find((l) => l.label === UNCLASSIFIED_LABEL);
    expect(unclassified?.units).toBe(72); // 60 + 12, merged into one bucket
    expect(coverage.labels.filter((l) => l.label === UNCLASSIFIED_LABEL)).toHaveLength(1);
  });

  it('the blank bucket is excluded from distinct_labels', () => {
    const coverage = assembleAdsCoverage(rows);
    expect(coverage.distinct_labels).toBe(1); // only "Forager Pantry"
  });

  it('reports a high unclassified_share matching the real-world F24 pattern', () => {
    const coverage = assembleAdsCoverage(rows);
    // total = 8 + 60 + 12 = 80; unclassified = 72 -> 90%
    expect(coverage.unclassified_share).toBeCloseTo(0.9, 6);
  });
});

describe('assembleMatch', () => {
  const rows: Sbd04MatchRow[] = [
    { label: 'Forager Pantry', retail_asins: 40, ads_campaigns: 8, has_retail: true, has_ads: true },
    { label: 'Alpine Trail', retail_asins: 25, ads_campaigns: 0, has_retail: true, has_ads: false },
    { label: 'Sunset Blend', retail_asins: 0, ads_campaigns: 3, has_retail: false, has_ads: true },
    { label: UNCLASSIFIED_LABEL, retail_asins: 5, ads_campaigns: 72, has_retail: true, has_ads: true },
  ];

  it('excludes the (unclassified) row from the considered set', () => {
    const match = assembleMatch(rows);
    expect(match.distinct_labels_considered).toBe(3);
  });

  it('computes matched / retail_only / ads_only correctly', () => {
    const match = assembleMatch(rows);
    expect(match.matched).toBe(1); // Forager Pantry
    expect(match.retail_only).toBe(1); // Alpine Trail
    expect(match.ads_only).toBe(1); // Sunset Blend
  });

  it('match_rate is matched / considered', () => {
    const match = assembleMatch(rows);
    expect(match.match_rate).toBeCloseTo(1 / 3, 6);
  });

  it('match_rate is null when there is nothing to consider', () => {
    const match = assembleMatch([
      { label: UNCLASSIFIED_LABEL, retail_asins: 5, ads_campaigns: 5, has_retail: true, has_ads: true },
    ]);
    expect(match.distinct_labels_considered).toBe(0);
    expect(match.match_rate).toBeNull();
  });
});

describe('classifyShape — proposal only, never a decision', () => {
  it('proposes single_brand when the retail side has 0 non-blank labels', () => {
    const retail = assembleRetailCoverage([], []);
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('single_brand');
    expect(c.confirm_required).toBe(true);
  });

  it('proposes single_brand when the retail side has exactly 1 non-blank label', () => {
    const retail = assembleRetailCoverage(
      [{ SellerID: 1, source: 'mws_items.Brand', label: 'Acme', asin_count: 100, row_count: 100 }],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('single_brand');
    expect(c.evidence.join(' ')).toContain('Acme');
  });

  it('proposes brand_nested_candidate when the retail side has 2+ non-blank labels', () => {
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('brand_nested_candidate');
    expect(c.evidence.some((e) => e.includes('2 distinct'))).toBe(true);
  });

  it('flags a blank-heavy ads side as evidence, without changing the proposal', () => {
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([
      { SellerID: 1, source: 'campaign.Brand', label: '', campaign_count: 90 },
      { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 10 },
    ]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('brand_nested_candidate');
    expect(c.evidence.some((e) => e.includes('unclassified'))).toBe(true);
  });
});

describe('assembleCoverageReport — full assembly (mocked rows, no network)', () => {
  // Contract note (see discovery.ts header): live integration against real
  // sbd-01..04 named queries is deferred until the gateway half deploys.
  // This exercises only the pure assembly function.
  it('wires all four row sets into one coherent report', () => {
    const report = assembleCoverageReport({
      sellerId: 'A1EXAMPLE23456',
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
      ],
      vendorRows: [],
      adsRows: [
        { SellerID: 1, source: 'campaign.Brand', label: '', campaign_count: 90 },
        { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 10 },
      ],
      matchRows: [
        { label: 'Forager Pantry', retail_asins: 40, ads_campaigns: 10, has_retail: true, has_ads: true },
        { label: 'Alpine Trail', retail_asins: 25, ads_campaigns: 0, has_retail: true, has_ads: false },
      ],
    });

    expect(report.seller_id).toBe('A1EXAMPLE23456');
    expect(report.generated_at).toBe('2026-08-12T00:00:00.000Z');
    expect(report.retail.distinct_labels).toBe(2);
    expect(report.ads.distinct_labels).toBe(1);
    expect(report.match.matched).toBe(1);
    expect(report.classification.proposal).toBe('brand_nested_candidate');
  });

  it('defaults `now` to the current time when not injected', () => {
    const before = Date.now();
    const report = assembleCoverageReport({
      sellerId: 'A1EXAMPLE23456',
      retailRows: [],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    const generatedMs = Date.parse(report.generated_at);
    expect(generatedMs).toBeGreaterThanOrEqual(before);
    expect(generatedMs).toBeLessThanOrEqual(Date.now());
  });
});
