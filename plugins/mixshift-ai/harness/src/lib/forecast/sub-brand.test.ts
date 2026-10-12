import { describe, it, expect } from 'vitest';
import { canonicalSubBrandId, cleanLabels, findMatching, nameProblem, scopeKeyOf, type SubBrand } from './sub-brand.js';

/** The pure helpers behind `mixshift forecast sub-brand` (mx-ops#134); synthetic labels only. */

const RLO = String.fromCharCode(0x202e);

describe('labels and names', () => {
  it('cleans labels as the app does: trimmed, blanks dropped, each once, case kept', () => {
    expect(cleanLabels([' Summit ', 'Summit', '', '  ', 'Summit CA'], '--item-label')).toEqual(['Summit', 'Summit CA']);
    expect(() => cleanLabels(['x'.repeat(201)], '--item-label')).toThrow(/at most 200 characters/);
    expect(() => cleanLabels([`Sum${RLO}mit`], '--campaign-label')).toThrow(/plain text on one line/);
    expect(() => cleanLabels(Array.from({ length: 101 }, (_, i) => `b${i}`), '--item-label')).toThrow(/at most 100 labels/);
  });

  it('a name is one line of plain text, 1 to 200 characters', () => {
    expect(nameProblem('Summit Gear')).toBeNull();
    expect(nameProblem('  ')).toMatch(/required/);
    expect(nameProblem('x'.repeat(201))).toMatch(/at most 200/);
    expect(nameProblem(`a${RLO}b`)).toMatch(/plain text/);
  });
});

describe('scope ids', () => {
  it('canonicalises a sub-brand id (database lowercased) and gives its key; anything else is not one', () => {
    expect(canonicalSubBrandId(' src:Fake_DB:042:scope:k0000001 ')).toBe('src:fake_db:42:scope:k0000001');
    expect(canonicalSubBrandId('src:fake_db:42')).toBeNull();
    expect(canonicalSubBrandId('src:fake_db:42:scope:K1')).toBeNull();
    expect(scopeKeyOf('src:fake_db:42:scope:k0000001')).toBe('k0000001');
    expect(scopeKeyOf('src:fake_db:42')).toBeNull();
  });
});

describe('findMatching', () => {
  const sb = (over: Partial<SubBrand>): SubBrand => ({
    scopeId: 'src:fake_db:42:scope:k0000001',
    scopeKey: 'k0000001',
    merchantId: 'src:fake_db:42',
    kind: 'sub_brand',
    name: 'Summit Gear',
    itemValues: ['Summit'],
    campaignValues: ['summit'],
    version: 1,
    ...over,
  });

  it('matches the same labels in any case and order, never another kind or another set', () => {
    const list = [sb({}), sb({ scopeId: 'src:fake_db:42:scope:k0000002', scopeKey: 'k0000002', itemValues: ['Summit', 'Summit CA'] })];
    expect(findMatching(list, { kind: 'sub_brand', itemValues: ['SUMMIT'], campaignValues: [' Summit '] })?.scopeKey).toBe('k0000001');
    expect(findMatching(list, { kind: 'sub_brand', itemValues: ['Summit CA', 'summit'], campaignValues: ['summit'] })?.scopeKey).toBe('k0000002');
    expect(findMatching(list, { kind: 'item_group', itemValues: ['Summit'], campaignValues: ['summit'] })).toBeNull();
    expect(findMatching(list, { kind: 'sub_brand', itemValues: ['Summit'], campaignValues: [] })).toBeNull();
  });
});
