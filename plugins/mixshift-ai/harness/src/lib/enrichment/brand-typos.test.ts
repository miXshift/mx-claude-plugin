import { describe, it, expect } from 'vitest';
import {
  detectBrandTermTypos,
  levenshtein,
  stripPunct,
  maxDistFor,
  isPluralOnly,
  competitorCollision,
  rootToken,
  type CS31Row,
  type BrandTermsBlock,
} from './brand-typos.js';

describe('levenshtein', () => {
  it('returns 0 for equal strings', () => {
    expect(levenshtein('hydrapak', 'hydrapak')).toBe(0);
  });
  it('returns length when one string is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
  it('handles single-char substitutions', () => {
    expect(levenshtein('hyrdapak', 'hydrapak')).toBe(2); // hyrdapak → hydrapak: 2 transpositions = 2 subs
  });
  it('handles insertions', () => {
    expect(levenshtein('hydrapak', 'hydrapack')).toBe(1);
  });
  it('handles deletions', () => {
    expect(levenshtein('hydrapaks', 'hydrapak')).toBe(1);
  });
});

describe('stripPunct', () => {
  it('strips leading punctuation', () => {
    expect(stripPunct('"hydrapak')).toBe('hydrapak');
  });
  it('strips trailing punctuation', () => {
    expect(stripPunct('hydrapak/')).toBe('hydrapak');
    expect(stripPunct('hydrapak.')).toBe('hydrapak');
  });
  it('preserves internal hyphens', () => {
    expect(stripPunct('hydra-pak')).toBe('hydra-pak');
  });
  it('preserves internal digits', () => {
    expect(stripPunct('aop-2024')).toBe('aop-2024');
  });
});

describe('maxDistFor', () => {
  it('returns 0 for ≤3-char canonicals', () => {
    expect(maxDistFor('aop')).toBe(0);
    expect(maxDistFor('hp')).toBe(0);
  });
  it('returns 1 for 4-5 char canonicals', () => {
    expect(maxDistFor('popl')).toBe(1);
    expect(maxDistFor('skratch'.slice(0, 5))).toBe(1);
  });
  it('returns the configured ceiling for ≥6 char canonicals', () => {
    expect(maxDistFor('hydrapak')).toBe(2);
    expect(maxDistFor('hydrapak', 3)).toBe(3);
  });
});

describe('isPluralOnly', () => {
  it('returns true for "polar bottles" vs "polar bottle"', () => {
    expect(isPluralOnly('polar bottles', 'polar bottle')).toBe(true);
  });
  it('returns true for "boxes" vs "box"', () => {
    expect(isPluralOnly('boxes', 'box')).toBe(true);
  });
  it('returns false for unrelated terms', () => {
    expect(isPluralOnly('hydropack', 'hydrapak')).toBe(false);
  });
});

describe('competitorCollision', () => {
  const competitors = ['hydrapeak', 'hydramax'];
  it('detects whole-term Levenshtein match', () => {
    expect(competitorCollision('hydrapeak water', competitors)).toBe('hydrapeak');
  });
  it('detects exact token match', () => {
    expect(competitorCollision('water hydrapeak bottle', competitors)).toBe('hydrapeak');
  });
  it('detects prefix-match token', () => {
    expect(competitorCollision('hydrapeaker', competitors)).toBe('hydrapeak');
  });
  it('detects space-deletion variant', () => {
    // "hydra peak" → joined "hydrapeak" — adjacent-pair concat
    expect(competitorCollision('hydra peak water', competitors)).toBe('hydrapeak');
  });
  it('returns null for term not close to any competitor', () => {
    // Note: "hydrapak" IS Levenshtein-1 from "hydrapeak" (insert 'e'), so we
    // can't use it here as a "non-matching" example. Use something genuinely
    // unrelated to either competitor.
    expect(competitorCollision('blue water flask', competitors)).toBeNull();
  });
  it('returns null when competitor list is empty', () => {
    expect(competitorCollision('hydrapeak', [])).toBeNull();
  });
});

describe('rootToken', () => {
  it('picks the closest single token from a multi-token term', () => {
    expect(rootToken('hydropack water bottle', 'hydrapak')).toBe('hydropack');
  });
  it('strips punctuation before matching', () => {
    expect(rootToken('"hydrapak"', 'hydrapak')).toBe('hydrapak');
  });
});

describe('detectBrandTermTypos — empty input', () => {
  it('returns empty array when CS-31 is empty', () => {
    expect(detectBrandTermTypos([], { hp: { canonical: ['hydrapak'] } })).toEqual([]);
  });
  it('returns empty array when brand_terms is null', () => {
    expect(detectBrandTermTypos([{ SearchTerm: 'hydropack' }], null)).toEqual([]);
  });
  it('returns empty array when brand_terms has no canonicals', () => {
    expect(detectBrandTermTypos([{ SearchTerm: 'hydropack' }], {})).toEqual([]);
  });
});

describe('detectBrandTermTypos — Path A (token_membership)', () => {
  const brandTerms: BrandTermsBlock = {
    polar_bottle: {
      canonical: ['polar bottle'],
      variants: ['polar'],
    },
  };

  it('catches multi-token term containing a known single-word variant', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'water bottle polar', orders: 10, sales: 100, spend: 20, clicks: 50 },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      canonical_match: 'polar bottle',
      root_token: 'polar',
      match_type: 'token_membership',
      distance: 0,
      variant_count: 1,
      total_orders: 10,
    });
  });

  it('does NOT match single-token terms (they would be in known set)', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'polar', orders: 10, sales: 100, spend: 20 },
    ];
    // 'polar' is in known set (it's a variant), so it's already filtered
    expect(detectBrandTermTypos(rows, brandTerms)).toEqual([]);
  });

  it('competitor filter overrides membership match', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'polar takeya bottle', orders: 10, sales: 100, spend: 20 },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms, { competitor_brands: ['takeya'] });
    expect(clusters).toEqual([]);
  });
});

describe('detectBrandTermTypos — Path B (Levenshtein)', () => {
  const brandTerms: BrandTermsBlock = {
    hydrapak: {
      canonical: ['hydrapak'],
      variants: [],
    },
  };

  it('catches close typos within length-aware budget', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'hydropack', orders: 5, sales: 50, spend: 10 },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      canonical_match: 'hydrapak',
      match_type: 'levenshtein',
      total_orders: 5,
    });
    expect(clusters[0]!.distance).toBeGreaterThan(0);
    expect(clusters[0]!.distance).toBeLessThanOrEqual(2);
  });

  it('rejects matches beyond length-aware budget for short canonicals', () => {
    const brandTerms: BrandTermsBlock = {
      aop: { canonical: ['aop'], variants: [] },
    };
    const rows: CS31Row[] = [{ SearchTerm: 'pop', orders: 1 }];
    expect(detectBrandTermTypos(rows, brandTerms)).toEqual([]);
  });

  it('rejects plural-only matches', () => {
    const brandTerms: BrandTermsBlock = {
      polar_bottle: { canonical: ['polar bottle'], variants: [] },
    };
    const rows: CS31Row[] = [
      { SearchTerm: 'polar bottles', orders: 5, sales: 50 },
    ];
    expect(detectBrandTermTypos(rows, brandTerms)).toEqual([]);
  });

  it('rejects competitor-brand collisions', () => {
    const brandTerms: BrandTermsBlock = {
      hydrapak: { canonical: ['hydrapak'], variants: [] },
    };
    const rows: CS31Row[] = [
      { SearchTerm: 'hydrapeak', orders: 5 },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms, {
      competitor_brands: ['hydrapeak'],
    });
    expect(clusters).toEqual([]);
  });

  it('skips already-known terms (exact canonical or variant)', () => {
    const brandTerms: BrandTermsBlock = {
      hydrapak: { canonical: ['hydrapak'], variants: ['hyrdapak'] },
    };
    const rows: CS31Row[] = [
      { SearchTerm: 'hydrapak' }, // canonical — known
      { SearchTerm: 'hyrdapak' }, // existing variant — known
    ];
    expect(detectBrandTermTypos(rows, brandTerms)).toEqual([]);
  });
});

describe('detectBrandTermTypos — clustering', () => {
  const brandTerms: BrandTermsBlock = {
    hydrapak: { canonical: ['hydrapak'], variants: [] },
  };

  it('groups variants sharing canonical + root_token', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'hydropack', orders: 5, sales: 50 },
      { SearchTerm: 'hydropack bottle', orders: 3, sales: 30 },
      { SearchTerm: 'hydropack water', orders: 2, sales: 20 },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.variant_count).toBe(3);
    expect(clusters[0]!.total_orders).toBe(10);
    expect(clusters[0]!.total_sales).toBe(100);
  });

  it('sorts clusters by total_orders desc', () => {
    const brandTerms: BrandTermsBlock = {
      hydrapak: { canonical: ['hydrapak'], variants: [] },
      polar_bottle: { canonical: ['polar bottle'], variants: ['polar'] },
    };
    const rows: CS31Row[] = [
      { SearchTerm: 'hydropack', orders: 5, sales: 50 }, // 5 orders
      { SearchTerm: 'polar water bottle', orders: 20, sales: 200 }, // 20 orders
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.total_orders).toBe(20);
    expect(clusters[1]!.total_orders).toBe(5);
  });

  it('top_variants is capped at 5 per cluster, all_variants holds full list', () => {
    const rows: CS31Row[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push({ SearchTerm: `hydropack v${i}`, orders: 10 - i, sales: (10 - i) * 10 });
    }
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.top_variants.length).toBeLessThanOrEqual(5);
    expect(clusters[0]!.all_variants.length).toBe(8);
  });
});

describe('detectBrandTermTypos — input tolerance', () => {
  const brandTerms: BrandTermsBlock = {
    hydrapak: { canonical: ['hydrapak'], variants: [] },
  };

  it('drops rows without SearchTerm', () => {
    const rows: CS31Row[] = [{ orders: 5 }];
    expect(detectBrandTermTypos(rows, brandTerms)).toEqual([]);
  });

  it('handles string-encoded numeric metrics', () => {
    const rows: CS31Row[] = [
      { SearchTerm: 'hydropack', orders: '5', sales: '50.00', spend: '10' },
    ];
    const clusters = detectBrandTermTypos(rows, brandTerms);
    expect(clusters[0]!.total_orders).toBe(5);
    expect(clusters[0]!.total_sales).toBe(50);
  });
});
