import { describe, it, expect } from 'vitest';
import { groupIntoBrands, slugify } from './brand-grouping.js';
import type { SellerRow } from './seller-query.js';

function row(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    amazon_seller_id: 'A1XXX',
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'US',
    region: 'NA',
    agency_name: null,
    acos_target: 20,
    ads_active: true,
    retail_active: true,
    is_active: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe('slugify', () => {
  it('lowercases + hyphenates a multi-word name without corporate suffix', () => {
    expect(slugify('Hello World')).toBe('hello-world');
    expect(slugify('My Cool Brand')).toBe('my-cool-brand');
  });

  it('strips corporate suffixes', () => {
    expect(slugify('Acme Inc')).toBe('acme');
    expect(slugify('Acme LLC')).toBe('acme');
    expect(slugify('Foo Bar Corp')).toBe('foo-bar');
    expect(slugify('HydraPak Inc.')).toBe('hydrapak');
  });

  it('preserves multi-word brand names without suffixes', () => {
    expect(slugify('Rowdy Parrot')).toBe('rowdy-parrot');
    expect(slugify('New Zealand Honey Co')).toBe('new-zealand-honey');
  });

  it('strips non-allowed characters', () => {
    expect(slugify('Acme & Sons')).toBe('acme-sons');
    expect(slugify("Bob's Burgers")).toBe('bobs-burgers');
    expect(slugify('Foo/Bar.Baz')).toBe('foo-bar-baz');
  });

  it('prefixes digit-starting names with "b-"', () => {
    expect(slugify('123 Brand')).toBe('b-123-brand');
  });

  it('returns "brand" for fully-stripped input', () => {
    expect(slugify('!!!')).toBe('brand');
    expect(slugify('')).toBe('brand');
  });

  it('collapses runs of hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
    expect(slugify('foo & & bar')).toBe('foo-bar');
  });
});

describe('groupIntoBrands', () => {
  it('groups rows with the same MerchantAlias', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: 'Acme', account_type: 'SC', marketplace: 'US' }),
      row({ seller_id: 2, merchant_alias: 'Acme', account_type: 'VC', marketplace: 'US' }),
      row({ seller_id: 3, merchant_alias: 'Acme', account_type: 'SC', marketplace: 'CA' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('acme');
    expect(groups[0]!.accounts).toHaveLength(3);
    expect(groups[0]!.group_signal).toBe('alias');
  });

  it('falls back to seller_name match for non-aliased rows', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: null, seller_name: 'Northwind', marketplace: 'US' }),
      row({ seller_id: 2, merchant_alias: null, seller_name: 'Northwind', marketplace: 'UK' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('northwind');
    expect(groups[0]!.group_signal).toBe('name_match');
  });

  it('keeps un-groupable rows as singletons', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: null, seller_name: 'Alpha' }),
      row({ seller_id: 2, merchant_alias: null, seller_name: 'Beta' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.group_signal)).toEqual(['singleton', 'singleton']);
  });

  it('mixes alias + name-match + singleton outputs cleanly', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: 'Acme', seller_name: 'Acme SC US' }),
      row({ seller_id: 2, merchant_alias: 'Acme', seller_name: 'Acme VC US' }),
      row({ seller_id: 3, merchant_alias: null, seller_name: 'Northwind', marketplace: 'US' }),
      row({ seller_id: 4, merchant_alias: null, seller_name: 'Northwind', marketplace: 'UK' }),
      row({ seller_id: 5, merchant_alias: null, seller_name: 'Standalone' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(3);
    const slugs = groups.map((g) => g.slug);
    expect(slugs).toContain('acme');
    expect(slugs).toContain('northwind');
    expect(slugs).toContain('standalone');
  });

  it('disambiguates colliding slugs with -2, -3 suffixes', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: 'Acme', seller_name: 'Acme One' }),
      row({ seller_id: 2, merchant_alias: 'Acme!', seller_name: 'Acme Two' }), // alias slugifies to 'acme'
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
    const slugs = groups.map((g) => g.slug).sort();
    expect(slugs).toEqual(['acme', 'acme-2']);
  });

  it('aggregates ads_active / retail_active across the group', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: 'Acme', ads_active: false, retail_active: true }),
      row({ seller_id: 2, merchant_alias: 'Acme', ads_active: true, retail_active: false }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ads_active).toBe(true);
    expect(groups[0]!.retail_active).toBe(true);
  });
});
