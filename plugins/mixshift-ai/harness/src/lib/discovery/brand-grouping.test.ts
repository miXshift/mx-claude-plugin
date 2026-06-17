import { describe, it, expect } from 'vitest';
import { groupIntoBrands, slugify, canonicalBrandKey } from './brand-grouping.js';
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

describe('canonicalBrandKey', () => {
  it('handles plain brand names without modification', () => {
    expect(canonicalBrandKey('Ridgepak')).toBe('ridgepak');
    expect(canonicalBrandKey('Aspen Outdoor Provisions')).toBe('aspen-outdoor-provisions');
  });

  it('strips marketplace suffixes after " - "', () => {
    expect(canonicalBrandKey('Ridgepak - CA')).toBe('ridgepak');
    expect(canonicalBrandKey('Ridgepak - DE Sporting Goods - (Pan-EU)')).toBe('ridgepak');
    expect(canonicalBrandKey('Ridgepak - FR - Sporting Goods')).toBe('ridgepak');
    expect(canonicalBrandKey('Ridgepak - IT Sporting Goods - (Pan-EU)')).toBe('ridgepak');
  });

  it('strips corporate suffixes via comma OR trailing token', () => {
    expect(canonicalBrandKey('Ridgepak, LLC')).toBe('ridgepak');
    expect(canonicalBrandKey('Acme, Inc')).toBe('acme');
    expect(canonicalBrandKey('Acme LLC')).toBe('acme');
    expect(canonicalBrandKey('Foo Bar Corp')).toBe('foo-bar');
  });

  it('handles em-dash and en-dash separators', () => {
    expect(canonicalBrandKey('Brand — Marketplace')).toBe('brand');
    expect(canonicalBrandKey('Brand – Marketplace')).toBe('brand');
  });

  it('preserves multi-word names without suffix patterns', () => {
    expect(canonicalBrandKey('Jolly Finch')).toBe('jolly-finch');
    expect(canonicalBrandKey('Highland Meadow Honey Co')).toBe('highland-meadow-honey');
    expect(canonicalBrandKey('Summit Labs')).toBe('summit-labs');
  });

  it('strips non-alphanumeric punctuation', () => {
    expect(canonicalBrandKey("Bob's Burgers")).toBe('bobs-burgers');
    expect(canonicalBrandKey('Glacier Bottle®')).toBe('glacier-bottle');
  });

  it('prefixes digit-starting names with "b-"', () => {
    expect(canonicalBrandKey('123 Brand')).toBe('b-123-brand');
  });

  it('returns "brand" for fully-stripped input', () => {
    expect(canonicalBrandKey('!!!')).toBe('brand');
    expect(canonicalBrandKey('')).toBe('brand');
  });
});

describe('slugify (legacy export — still used by mixshift brand add)', () => {
  it('lowercases + hyphenates a multi-word name without corporate suffix', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('strips corporate suffixes', () => {
    expect(slugify('Acme Inc')).toBe('acme');
    expect(slugify('Acme LLC')).toBe('acme');
  });

  it('preserves multi-word brand names without suffixes', () => {
    expect(slugify('Jolly Finch')).toBe('jolly-finch');
  });
});

describe('groupIntoBrands — Ridgepak family consolidation (the regression)', () => {
  it('collapses 6 Ridgepak rows into one brand entry', () => {
    // Real names observed in Sam's warehouse during the AOP test:
    const rows = [
      row({ seller_id: 1, seller_name: 'Ridgepak', account_type: 'VC', marketplace: 'US' }),
      row({ seller_id: 2, seller_name: 'Ridgepak - CA', account_type: 'VC', marketplace: 'CA' }),
      row({
        seller_id: 3,
        seller_name: 'Ridgepak - DE Sporting Goods - (Pan-EU)',
        account_type: 'VC',
        marketplace: 'DE',
      }),
      row({
        seller_id: 4,
        seller_name: 'Ridgepak - FR - Sporting Goods',
        account_type: 'VC',
        marketplace: 'FR',
      }),
      row({
        seller_id: 5,
        seller_name: 'Ridgepak - IT Sporting Goods - (Pan-EU)',
        account_type: 'VC',
        marketplace: 'IT',
      }),
      row({ seller_id: 6, seller_name: 'Ridgepak, LLC', account_type: 'SC', marketplace: 'US' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('ridgepak');
    expect(groups[0]!.accounts).toHaveLength(6);
    // Display name = shortest variant, no marketplace suffix noise
    expect(groups[0]!.display_name).toBe('Ridgepak');
  });
});

describe('groupIntoBrands — AOP-style same-name grouping (no regression)', () => {
  it('groups rows that share the same exact Name across marketplaces', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Aspen Outdoor Provisions', marketplace: 'US' }),
      row({ seller_id: 2, seller_name: 'Aspen Outdoor Provisions', marketplace: 'CA' }),
      row({ seller_id: 3, seller_name: 'Aspen Outdoor Provisions', marketplace: 'MX' }),
      row({ seller_id: 4, seller_name: 'Aspen Outdoor Provisions', marketplace: 'US' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('aspen-outdoor-provisions');
    expect(groups[0]!.accounts).toHaveLength(4);
  });

});

describe('groupIntoBrands MerchantAlias-first keying (task #62)', () => {
  it('groups by curated alias, not Name: AOP rows aliased Forager\'s Pantry', () => {
    // The canonical real-world case from BRAND-BRAIN.md: storefront Name
    // is "Aspen Outdoor Provisions", AM-curated alias is the brand.
    const rows = [
      row({
        seller_id: 1,
        seller_name: 'Aspen Outdoor Provisions',
        merchant_alias: "Forager's Pantry",
        marketplace: 'US',
      }),
      row({
        seller_id: 2,
        seller_name: 'Aspen Outdoor Provisions',
        merchant_alias: "Forager's Pantry",
        marketplace: 'CA',
      }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('foragers-pantry');
    expect(groups[0]!.display_name).toBe("Forager's Pantry");
  });

  it('collapses alias variants with marketplace suffixes like Name variants', () => {
    const rows = [
      row({ seller_id: 1, merchant_alias: "Forager's Pantry", marketplace: 'US' }),
      row({ seller_id: 2, merchant_alias: "Forager's Pantry - CA", marketplace: 'CA' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slug).toBe('foragers-pantry');
  });

  it('splits on genuinely distinct aliases (bare suffix without separator)', () => {
    // "forager's pantry CA" has no " - " or ", " separator, so the CA
    // is treated as part of the brand label. Distinct keys → two entries.
    // Self-heals when the AM normalizes the alias and re-discovers.
    const rows = [
      row({ seller_id: 1, merchant_alias: "forager's pantry", marketplace: 'US' }),
      row({ seller_id: 2, merchant_alias: "forager's pantry CA", marketplace: 'CA' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
  });

  it('splits when alias curation is partial across a brand\'s rows', () => {
    // Documented consequence: one row aliased, sibling row not → the
    // aliased row keys on the alias, the bare row falls back to Name.
    // Two entries until the AM fills in the missing alias.
    const rows = [
      row({
        seller_id: 1,
        seller_name: 'Aspen Outdoor Provisions',
        merchant_alias: "Forager's Pantry",
        marketplace: 'US',
      }),
      row({
        seller_id: 2,
        seller_name: 'Aspen Outdoor Provisions',
        merchant_alias: null,
        marketplace: 'CA',
      }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.slug).sort()).toEqual([
      'aspen-outdoor-provisions',
      'foragers-pantry',
    ]);
  });

  it('prefers the shortest alias over any Name for display', () => {
    const rows = [
      row({
        seller_id: 1,
        seller_name: 'Ridgepak, LLC',
        merchant_alias: 'Ridgepak',
        marketplace: 'US',
      }),
      row({
        seller_id: 2,
        seller_name: 'Ridgepak - CA',
        merchant_alias: 'Ridgepak - CA',
        marketplace: 'CA',
      }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.display_name).toBe('Ridgepak');
  });
});

describe('groupIntoBrands — keeps genuinely distinct brands separate', () => {
  it('keeps rows with distinct canonical keys as separate brands', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Alpha' }),
      row({ seller_id: 2, seller_name: 'Beta' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
  });

  it('treats different multi-word brands as separate even with shared first words', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Glacier Bottle' }),
      row({ seller_id: 2, seller_name: 'Glacier Express' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.slug).sort()).toEqual(['glacier-bottle', 'glacier-express']);
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

  it('returns groups in stable alpha order by canonical key', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Zebra' }),
      row({ seller_id: 2, seller_name: 'Apple' }),
      row({ seller_id: 3, seller_name: 'Mango' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups.map((g) => g.display_name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('picks the shortest non-empty name as display', () => {
    const rows = [
      row({ seller_id: 1, seller_name: 'Ridgepak, LLC' }),
      row({ seller_id: 2, seller_name: 'Ridgepak' }),
      row({ seller_id: 3, seller_name: 'Ridgepak - DE Sporting Goods - (Pan-EU)' }),
    ];
    const groups = groupIntoBrands(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.display_name).toBe('Ridgepak');
  });
});
