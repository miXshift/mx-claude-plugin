import { describe, it, expect } from 'vitest';
import { resolveBrandName, _internal } from './resolve-brand.js';
import { buildIndexFromBrands } from './index.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

function seller(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'X',
    amazon_seller_id: 'A1XXX',
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'United States',
    region: 'NA',
    agency_name: null,
    acos_target: 22,
    ads_active: true,
    retail_active: true,
    is_active: true,
    has_mws: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function brand(overrides: Partial<BrandSuggestion>): BrandSuggestion {
  return {
    slug: 'x',
    display_name: 'X',
    ads_active: true,
    retail_active: true,
    accounts: [seller({})],
    ...overrides,
  };
}

// Realistic-ish set covering the patterns from the Sam-onboarding session.
const SAMPLE_BRANDS = [
  brand({ slug: 'summit-labs', display_name: 'Summit Labs' }),
  brand({ slug: 'ridgeline-cell', display_name: 'RIDGELINE CELL' }),
  brand({ slug: 'aspen-outdoor-provisions', display_name: 'Aspen Outdoor Provisions' }),
  brand({ slug: 'hearth-iq-usa', display_name: 'Hearth IQ USA' }),
  brand({ slug: 'ridgepak', display_name: 'Ridgepak' }),
  brand({ slug: 'ridgepak-ca', display_name: 'Ridgepak - CA' }),
  brand({ slug: 'ridgepak-de-sporting-goods-pan-eu', display_name: 'Ridgepak - DE Sporting Goods - (Pan-EU)' }),
  brand({ slug: 'function-101', display_name: 'Function 101' }),
  brand({ slug: 'glacier-bottle', display_name: 'Glacier Bottle' }),
  brand({ slug: 'glacier-bottle-2', display_name: 'Glacier Bottle®' }),
];
const INDEX = buildIndexFromBrands(SAMPLE_BRANDS, null);

describe('resolveBrandName', () => {
  it('resolves exact slug', () => {
    const r = resolveBrandName('summit-labs', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('summit-labs');
  });

  it('resolves case-insensitive display name', () => {
    const r = resolveBrandName('ridgeline cell', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('ridgeline-cell');
  });

  it('resolves exact display name with original capitalization', () => {
    const r = resolveBrandName('RIDGELINE CELL', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('ridgeline-cell');
  });

  it('resolves acronym (AOP → Aspen Outdoor Provisions)', () => {
    const r = resolveBrandName('AOP', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('aspen-outdoor-provisions');
  });

  it('resolves acronym for Hearth IQ USA (HIU)', () => {
    const r = resolveBrandName('HIU', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('hearth-iq-usa');
  });

  it('resolves prefix match: "Summit" → Summit Labs', () => {
    const r = resolveBrandName('Summit', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('summit-labs');
  });

  it('resolves prefix match: "Hearth IQ" → Hearth IQ USA', () => {
    const r = resolveBrandName('Hearth IQ', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('hearth-iq-usa');
  });

  it('returns ambiguous for "Ridgep" (matches Ridgepak + 2 marketplace variants)', () => {
    const r = resolveBrandName('Ridgep', INDEX);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.length).toBeGreaterThan(1);
      expect(r.candidates.map((c) => c.slug)).toContain('ridgepak');
      expect(r.candidates.map((c) => c.slug)).toContain('ridgepak-ca');
    }
  });

  it('returns ambiguous for "Glacier" (matches Glacier Bottle + Glacier Bottle®)', () => {
    const r = resolveBrandName('Glacier', INDEX);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.map((c) => c.slug).sort()).toEqual([
        'glacier-bottle',
        'glacier-bottle-2',
      ]);
    }
  });

  it('exact display-name match wins over substring even when both could match', () => {
    // "Glacier Bottle" exactly matches one entry; the ® variant is a
    // substring superset. Exact-match step (step 2) should hit first.
    const r = resolveBrandName('Glacier Bottle', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('glacier-bottle');
  });

  it('returns none for nonsense input', () => {
    const r = resolveBrandName('zzzzz-nope', INDEX);
    expect(r.status).toBe('none');
  });

  it('does not match 2-letter strings via acronym when they look like noise', () => {
    // "CA" is too short to be an acronym we'd trust without context. Our
    // implementation allows acronyms ≥2 chars BUT only when they match
    // EXACTLY — so "CA" only matches if a brand has acronym "CA". None
    // of our sample brands do.
    const r = resolveBrandName('CA', INDEX);
    expect(r.status).toBe('none');
  });

  it('handles whitespace and punctuation in input', () => {
    const r = resolveBrandName('  ridgeline cell.  ', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('ridgeline-cell');
  });

  it('resolves slug with numbers: "function-101"', () => {
    const r = resolveBrandName('function-101', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('function-101');
  });
});

describe('resolver internals', () => {
  it('normalizes "Aspen Outdoor Provisions" for matching', () => {
    expect(_internal.normalizeForMatch('Aspen Outdoor Provisions')).toBe(
      'aspen outdoor provisions',
    );
  });

  it('strips diacritics and punctuation', () => {
    expect(_internal.normalizeForMatch('Glacier Bottle®, Inc.')).toBe(
      'glacier bottle inc',
    );
  });

  it('computes acronyms correctly', () => {
    expect(_internal.acronymFor('Aspen Outdoor Provisions')).toBe('AOP');
    expect(_internal.acronymFor('Hearth IQ USA')).toBe('HIU');
    expect(_internal.acronymFor('Summit Labs')).toBe('SL');
    expect(_internal.acronymFor('Function 101')).toBe('F1');
    expect(_internal.acronymFor('Ridgepak, LLC')).toBe('RL');
  });
});
