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
    has_mws: true,
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
  it('groups rows that share the same Name across marketplaces and account types', () => {
    // User has set Name="Acme" on all three rows — they group as one brand
    // regardless of MerchantAlias differences or marketplace/account-type spread.
    const rows = [
      row({ seller_id: 1, seller_name: 'Acme', account_type: 'SC', marketplace: 'US' }),
      row({ seller_id: 2, seller_name: 'Acme', account_type: 'VC', marketplace: 'US' }),
      row({ seller_id: 3, seller_name: 'Acme', account_type: 'SC', marketplace: 'CA' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('acme');
    expect(groups[0]!.display_name).toBe('Acme');
    expect(groups[0]!.accounts).toHaveLength(3);
  });

  it('ignores MerchantAlias differences when Name agrees', () => {
    // The user has curated Name="American Outdoor Products" on rows whose
    // Amazon storefronts (MerchantAlias) are "backpacker's pantry" — the
    // grouping uses Name, not alias.
    const rows = [
      row({
        seller_id: 1,
        seller_name: 'American Outdoor Products',
        merchant_alias: "backpacker's pantry",
        marketplace: 'US',
      }),
      row({
        seller_id: 2,
        seller_name: 'American Outdoor Products',
        merchant_alias: "backpacker's pantry CA",
        marketplace: 'CA',
      }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('american-outdoor-products');
    expect(groups[0]!.accounts).toHaveLength(2);
  });

  it('keeps rows with distinct Names as separate brands', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Alpha' }),
      row({ seller_id: 2, seller_name: 'Beta' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
  });

  it('disambiguates colliding slugs with -2, -3 suffixes', () => {
    // Two distinct Names slugify to the same root; second one gets -2.
    const rows = [
      row({ seller_id: 1, seller_name: 'Acme One' }),
      row({ seller_id: 2, seller_name: 'Acme. One!' }), // slugifies to 'acme-one' too
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
    const slugs = groups.map((g) => g.slug).sort();
    expect(slugs).toEqual(['acme-one', 'acme-one-2']);
  });

  it('aggregates ads_active / retail_active across the group', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Acme', ads_active: false, retail_active: true }),
      row({ seller_id: 2, seller_name: 'Acme', ads_active: true, retail_active: false }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ads_active).toBe(true);
    expect(groups[0]!.retail_active).toBe(true);
  });

  it('returns groups in stable alpha order by display name', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Zebra' }),
      row({ seller_id: 2, seller_name: 'Apple' }),
      row({ seller_id: 3, seller_name: 'Mango' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups.map((g) => g.display_name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });
});
