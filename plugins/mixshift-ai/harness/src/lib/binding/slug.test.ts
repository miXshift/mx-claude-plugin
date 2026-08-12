import { describe, it, expect } from 'vitest';
import { mintSlug } from './slug.js';

describe('mintSlug', () => {
  it('returns the plain slugified label when there is no collision', () => {
    expect(mintSlug('Forager Pantry', [], 'Acme Agency')).toBe('forager-pantry');
    expect(mintSlug('Forager Pantry', new Set<string>(), 'Acme Agency')).toBe('forager-pantry');
  });

  it('prefixes with the slugified seller name on collision', () => {
    const existing = new Set(['forager-pantry']);
    expect(mintSlug('Forager Pantry', existing, 'Acme Agency')).toBe(
      'acme-agency-forager-pantry',
    );
  });

  it('falls through to a numeric suffix when the seller-prefixed slug ALSO collides', () => {
    const existing = new Set(['forager-pantry', 'acme-agency-forager-pantry']);
    expect(mintSlug('Forager Pantry', existing, 'Acme Agency')).toBe(
      'acme-agency-forager-pantry-2',
    );
  });

  it('numeric suffix keeps incrementing past multiple collisions', () => {
    const existing = new Set([
      'forager-pantry',
      'acme-agency-forager-pantry',
      'acme-agency-forager-pantry-2',
      'acme-agency-forager-pantry-3',
    ]);
    expect(mintSlug('Forager Pantry', existing, 'Acme Agency')).toBe(
      'acme-agency-forager-pantry-4',
    );
  });

  it('an unslugifiable seller name still yields a usable (fallback) prefix', () => {
    // slugify() never returns an empty string — an all-punctuation seller
    // name falls back to the literal 'brand', which is still a DIFFERENT
    // slug from the label's own base, so it prefixes normally rather than
    // producing something empty or invalid.
    const existing = new Set(['forager-pantry']);
    expect(mintSlug('Forager Pantry', existing, '!!!')).toBe('brand-forager-pantry');
  });

  it('skips the seller prefix when it is identical to the base slug (no-op prefix)', () => {
    const existing = new Set(['forager-pantry']);
    // Seller name happens to slugify to exactly the same string as the label.
    expect(mintSlug('Forager Pantry', existing, 'Forager Pantry')).toBe('forager-pantry-2');
  });

  it('accepts either a Set or a plain array for existingSlugs', () => {
    const asArray = ['forager-pantry'];
    const asSet = new Set(asArray);
    expect(mintSlug('Forager Pantry', asArray, 'Acme Agency')).toBe(
      mintSlug('Forager Pantry', asSet, 'Acme Agency'),
    );
  });

  it('handles unicode labels (diacritics, apostrophes) the same way slugify does', () => {
    expect(mintSlug("Forager's Pantry", [], 'Acme')).toBe('foragers-pantry');
    expect(mintSlug('Café Nord', [], 'Acme')).toBe('cafe-nord');
    expect(mintSlug('日本語ブランド', [], 'Acme')).toBe('brand');
  });

  it('unicode collision still resolves through the seller-prefix then numeric-suffix chain', () => {
    // slugify() strips a trailing corporate suffix, so 'Nordic Co' slugifies
    // to 'nordic' (the '-co' tail reads as "Company", same as '-corp'/'-inc').
    const existing = new Set(['cafe-nord']);
    expect(mintSlug('Café Nord', existing, 'Nordic Co')).toBe('nordic-cafe-nord');
    const existingBoth = new Set(['cafe-nord', 'nordic-cafe-nord']);
    expect(mintSlug('Café Nord', existingBoth, 'Nordic Co')).toBe('nordic-cafe-nord-2');
  });

  it('the minted slug always matches the brand_slug shape (^[a-z][a-z0-9-]*$)', () => {
    const cases: Array<[string, string[], string]> = [
      ['Forager Pantry', [], 'Acme'],
      ['Forager Pantry', ['forager-pantry'], 'Acme'],
      ['123 Numeric Label', [], 'Acme'],
      ['', [], 'Acme'],
    ];
    for (const [label, existing, seller] of cases) {
      const slug = mintSlug(label, existing, seller);
      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});
