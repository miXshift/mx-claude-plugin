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
  brand({ slug: 'skratch-labs', display_name: 'Skratch Labs' }),
  brand({ slug: 'hydro-cell', display_name: 'HYDRO CELL' }),
  brand({ slug: 'american-outdoor-products', display_name: 'American Outdoor Products' }),
  brand({ slug: 'home-iq-usa', display_name: 'Home IQ USA' }),
  brand({ slug: 'hydrapak', display_name: 'Hydrapak' }),
  brand({ slug: 'hydrapak-ca', display_name: 'Hydrapak - CA' }),
  brand({ slug: 'hydrapak-de-sporting-goods-pan-eu', display_name: 'Hydrapak - DE Sporting Goods - (Pan-EU)' }),
  brand({ slug: 'function-101', display_name: 'Function 101' }),
  brand({ slug: 'polar-bottle', display_name: 'Polar Bottle' }),
  brand({ slug: 'polar-bottle-2', display_name: 'Polar Bottle®' }),
];
const INDEX = buildIndexFromBrands(SAMPLE_BRANDS, null);

describe('resolveBrandName', () => {
  it('resolves exact slug', () => {
    const r = resolveBrandName('skratch-labs', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('skratch-labs');
  });

  it('resolves case-insensitive display name', () => {
    const r = resolveBrandName('hydro cell', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('hydro-cell');
  });

  it('resolves exact display name with original capitalization', () => {
    const r = resolveBrandName('HYDRO CELL', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('hydro-cell');
  });

  it('resolves acronym (AOP → American Outdoor Products)', () => {
    const r = resolveBrandName('AOP', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('american-outdoor-products');
  });

  it('resolves acronym for Home IQ USA (HIU)', () => {
    const r = resolveBrandName('HIU', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('home-iq-usa');
  });

  it('resolves prefix match: "Skratch" → Skratch Labs', () => {
    const r = resolveBrandName('Skratch', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('skratch-labs');
  });

  it('resolves prefix match: "Home IQ" → Home IQ USA', () => {
    const r = resolveBrandName('Home IQ', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('home-iq-usa');
  });

  it('returns ambiguous for "Hydra" (matches Hydrapak + 2 marketplace variants)', () => {
    const r = resolveBrandName('Hydra', INDEX);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.length).toBeGreaterThan(1);
      expect(r.candidates.map((c) => c.slug)).toContain('hydrapak');
      expect(r.candidates.map((c) => c.slug)).toContain('hydrapak-ca');
    }
  });

  it('returns ambiguous for "Polar" (matches Polar Bottle + Polar Bottle®)', () => {
    const r = resolveBrandName('Polar', INDEX);
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.candidates.map((c) => c.slug).sort()).toEqual([
        'polar-bottle',
        'polar-bottle-2',
      ]);
    }
  });

  it('exact display-name match wins over substring even when both could match', () => {
    // "Polar Bottle" exactly matches one entry; the ® variant is a
    // substring superset. Exact-match step (step 2) should hit first.
    const r = resolveBrandName('Polar Bottle', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('polar-bottle');
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
    const r = resolveBrandName('  hydro cell.  ', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('hydro-cell');
  });

  it('resolves slug with numbers: "function-101"', () => {
    const r = resolveBrandName('function-101', INDEX);
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(r.brand.slug).toBe('function-101');
  });
});

describe('resolver internals', () => {
  it('normalizes "American Outdoor Products" for matching', () => {
    expect(_internal.normalizeForMatch('American Outdoor Products')).toBe(
      'american outdoor products',
    );
  });

  it('strips diacritics and punctuation', () => {
    expect(_internal.normalizeForMatch('Polar Bottle®, Inc.')).toBe(
      'polar bottle inc',
    );
  });

  it('computes acronyms correctly', () => {
    expect(_internal.acronymFor('American Outdoor Products')).toBe('AOP');
    expect(_internal.acronymFor('Home IQ USA')).toBe('HIU');
    expect(_internal.acronymFor('Skratch Labs')).toBe('SL');
    expect(_internal.acronymFor('Function 101')).toBe('F1');
    expect(_internal.acronymFor('HydraPak, LLC')).toBe('HL');
  });
});
