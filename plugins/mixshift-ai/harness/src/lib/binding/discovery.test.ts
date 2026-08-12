import { describe, it, expect } from 'vitest';
import {
  assembleRetailCoverage,
  assembleAdsCoverage,
  assembleMatch,
  assembleCoverageReport,
  classifyShape,
  normalizeLabel,
  resolveSellerIds,
  coerceRetailRow,
  coerceAdsRow,
  coerceVendorRow,
  coerceMatchRow,
  UNCLASSIFIED_LABEL,
  RETAIL_BLANK_DOMINATED_THRESHOLD,
  MEANINGFUL_LABEL_SHARE,
  type Sbd01RetailRow,
  type Sbd02AdsRow,
  type Sbd03VendorRow,
  type Sbd04MatchRow,
  type Sbd01RetailRowWire,
  type Sbd02AdsRowWire,
  type Sbd03VendorRowWire,
  type Sbd04MatchRowWire,
} from './discovery.js';

// ---------------------------------------------------------------------------
// FINDING 2 (red team over PR #131, live-wire-verified): the gateway's mysql
// pool runs bigNumberStrings:true, so every COUNT()-derived field arrives as
// a JS STRING, and IF(...,0,1) flags arrive as a JS NUMBER 0/1 — neither a
// clean number nor a boolean. These fixtures use the REAL wire shape (string
// counts, 0/1 flags), not the idealized shape the rest of this file mocks,
// so the coercion boundary is what CI actually exercises.
// ---------------------------------------------------------------------------

describe('wire-shape coercion (FINDING 2) — string counts, 0/1 flags', () => {
  it('coerceRetailRow: string counts become real numbers', () => {
    const wire: Sbd01RetailRowWire = {
      SellerID: 1,
      source: 'mws_items.Brand',
      label: 'Forager Pantry',
      asin_count: '40',
      row_count: '80',
    };
    const clean = coerceRetailRow(wire);
    expect(clean.asin_count).toBe(40);
    expect(clean.row_count).toBe(80);
    expect(typeof clean.asin_count).toBe('number');
  });

  it('coerceAdsRow: string campaign_count becomes a real number', () => {
    const wire: Sbd02AdsRowWire = {
      SellerID: 1,
      source: 'campaign.Brand',
      label: UNCLASSIFIED_LABEL,
      campaign_count: '90',
    };
    expect(coerceAdsRow(wire).campaign_count).toBe(90);
  });

  it('coerceVendorRow: string item_count becomes a real number', () => {
    const wire: Sbd03VendorRowWire = {
      SellerID: 2,
      source: 'vendor_items.CustomBrand',
      label: 'Forager Pantry',
      item_count: '10',
    };
    expect(coerceVendorRow(wire).item_count).toBe(10);
  });

  it('coerceMatchRow: string counts AND numeric 0/1 flags both coerce correctly', () => {
    const wire: Sbd04MatchRowWire = {
      label: 'Forager Pantry',
      retail_asins: '40',
      ads_campaigns: '10',
      has_retail: 1,
      has_ads: 0,
    };
    const clean = coerceMatchRow(wire);
    expect(clean.retail_asins).toBe(40);
    expect(clean.ads_campaigns).toBe(10);
    expect(clean.has_retail).toBe(true);
    expect(clean.has_ads).toBe(false);
    expect(typeof clean.has_retail).toBe('boolean');
  });

  it('a malformed/missing count degrades to 0, not NaN (never poisons a sum)', () => {
    const wire = { SellerID: 1, source: 's', label: 'x', asin_count: 'not-a-number', row_count: undefined } as unknown as Sbd01RetailRowWire;
    const clean = coerceRetailRow(wire);
    expect(clean.asin_count).toBe(0);
    expect(clean.row_count).toBe(0);
    expect(Number.isNaN(clean.asin_count)).toBe(false);
  });

  it('REGRESSION: without coercion, string counts would string-concatenate instead of summing', () => {
    // The exact bug the finding describes: buildSideCoverage sums
    // `entry.units += r.units`. Fed raw wire strings directly (bypassing
    // coercion), "+=" on strings concatenates ("40" + "25" -> "4025").
    // Feeding the SAME two rows through coerceRetailRow first must produce
    // the correct numeric sum instead.
    const wireRows: Sbd01RetailRowWire[] = [
      { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: '40', row_count: '40' },
      { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: '25', row_count: '25' },
    ];
    const cleanRows: Sbd01RetailRow[] = wireRows.map(coerceRetailRow);
    const coverage = assembleRetailCoverage(cleanRows, []);
    const forager = coverage.labels.find((l) => l.label === 'Forager Pantry');
    expect(forager?.units).toBe(65); // NOT "4025" and NOT NaN
    expect(coverage.total_units).toBe(65);
  });

  it('REGRESSION: the full fetch-to-assembly pipeline sums correctly from realistic wire rows', () => {
    const wireRetail: Sbd01RetailRowWire[] = [
      { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: '40', row_count: '40' },
      { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: '25', row_count: '25' },
    ];
    const wireAds: Sbd02AdsRowWire[] = [
      { SellerID: 1, source: 'campaign.Brand', label: UNCLASSIFIED_LABEL, campaign_count: '90' },
      { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: '10' },
    ];
    const wireMatch: Sbd04MatchRowWire[] = [
      { label: 'Forager Pantry', retail_asins: '40', ads_campaigns: '10', has_retail: 1, has_ads: 1 },
      { label: 'Alpine Trail', retail_asins: '25', ads_campaigns: '0', has_retail: 1, has_ads: 0 },
    ];
    const report = assembleCoverageReport({
      sellerId: 'A1EXAMPLE23456',
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: wireRetail.map(coerceRetailRow),
      vendorRows: [],
      adsRows: wireAds.map(coerceAdsRow),
      matchRows: wireMatch.map(coerceMatchRow),
    });
    expect(report.retail.total_units).toBe(65);
    expect(report.ads.total_units).toBe(100);
    expect(report.ads.unclassified_share).toBeCloseTo(0.9, 6);
    expect(report.match.matched).toBe(1);
  });
});

describe('resolveSellerIds — AmazonSellerID -> internal warehouse seller_id(s)', () => {
  const sellers = [
    { seller_id: 100, amazon_seller_id: 'A1EXAMPLE23456' },
    { seller_id: 200, amazon_seller_id: 'A1EXAMPLE23456' }, // second marketplace, same account
    { seller_id: 300, amazon_seller_id: 'A2OTHERACCOUNT' },
    { seller_id: 400, amazon_seller_id: null },
  ];

  it('collects ALL internal seller_ids matching the AmazonSellerID (multi-marketplace)', () => {
    expect(resolveSellerIds('A1EXAMPLE23456', sellers)).toEqual([100, 200]);
  });

  it('does not match a different account or a null amazon_seller_id', () => {
    expect(resolveSellerIds('A2OTHERACCOUNT', sellers)).toEqual([300]);
    expect(resolveSellerIds('DOES-NOT-EXIST', sellers)).toEqual([]);
  });

  it('is case-sensitive (AmazonSellerID is an exact-match warehouse value)', () => {
    expect(resolveSellerIds('a1example23456', sellers)).toEqual([]);
  });
});

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

// FINDING 5, red team over PR #131: design doc §4.1 says single_brand on "1
// dominant label OR blanks-dominated" and requires "meaningful catalog/spend
// mass" for brand_nested candidacy. The original code gated ONLY on
// distinct_labels<=1, so a mostly-blank retail side with a few sliver labels
// (a handful of mislabeled ASINs) proposed brand_nested_candidate on noise.
describe('classifyShape — retail blanks-dominated + meaningful-mass gates (FINDING 5)', () => {
  it('a 95%-blank retail side with 3 sliver labels proposes single_brand, not brand_nested_candidate', () => {
    // total_units = 1000: 950 unclassified (95%, above the 90% threshold),
    // 3 labeled rows of 16/17/17 units each (1.6%/1.7%/1.7% share) — exactly
    // the bug scenario the finding describes.
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: '', asin_count: 950, row_count: 950 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Sliver A', asin_count: 16, row_count: 16 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Sliver B', asin_count: 17, row_count: 17 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Sliver C', asin_count: 17, row_count: 17 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('single_brand');
    expect(c.evidence.some((e) => e.includes('blanks-dominated'))).toBe(true);
  });

  it('a healthy nested account (two substantial labels, low blanks) is UNCHANGED: brand_nested_candidate', () => {
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 400, row_count: 400 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 400, row_count: 400 },
        { SellerID: 1, source: 'mws_items.Brand', label: '', asin_count: 200, row_count: 200 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    // 20% blank — well under the 90% blanks-dominated threshold; both
    // labels are 40% each — well above the 2% meaningful-mass floor.
    expect(c.proposal).toBe('brand_nested_candidate');
  });

  it('the meaningful-mass qualifier alone (no blanks-dominance) suppresses sliver labels from counting toward N', () => {
    // 50% blank (under the 90% threshold, so gate 1 does NOT fire) + one
    // real 49.4%-share label + two 0.3%-share slivers. Without the mass
    // qualifier this would read as 3 distinct labels -> brand_nested. With
    // it, only the one real label counts -> single_brand.
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: '', asin_count: 500, row_count: 500 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Real Brand', asin_count: 494, row_count: 494 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Sliver A', asin_count: 3, row_count: 3 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Sliver B', asin_count: 3, row_count: 3 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    expect(retail.unclassified_share).toBeLessThan(RETAIL_BLANK_DOMINATED_THRESHOLD);
    expect(c.proposal).toBe('single_brand');
    expect(c.evidence.some((e) => e.includes('meaningful'))).toBe(true);
  });

  it('a label right at the meaningful-mass floor counts; just under it does not', () => {
    const atFloor = MEANINGFUL_LABEL_SHARE * 1000; // exactly 2% of 1000
    const underFloor = atFloor - 1;
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Dominant', asin_count: 1000 - atFloor - underFloor, row_count: 1 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'At Floor', asin_count: atFloor, row_count: 1 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Under Floor', asin_count: underFloor, row_count: 1 },
      ],
      [],
    );
    const ads = assembleAdsCoverage([]);
    const c = classifyShape(retail, ads);
    // "At Floor" (exactly 2%) plus "Dominant" both count -> 2 meaningful
    // labels -> brand_nested_candidate, even though "Under Floor" (just
    // below 2%) does not count.
    expect(c.proposal).toBe('brand_nested_candidate');
  });

  it('the blanks-dominated gate is RETAIL-ONLY: a blank-dominated ads side never suppresses a real nested proposal', () => {
    const retail = assembleRetailCoverage(
      [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
      ],
      [],
    );
    // Ads at 95% unclassified — well above RETAIL_BLANK_DOMINATED_THRESHOLD,
    // but that gate must never consult `ads`.
    const ads = assembleAdsCoverage([
      { SellerID: 1, source: 'campaign.Brand', label: '', campaign_count: 950 },
      { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 50 },
    ]);
    const c = classifyShape(retail, ads);
    expect(c.proposal).toBe('brand_nested_candidate');
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
