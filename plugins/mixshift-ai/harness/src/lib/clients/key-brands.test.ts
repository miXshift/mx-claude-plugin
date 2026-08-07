import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadKeyBrands,
  addKeyBrand,
  removeKeyBrand,
  clearKeyBrands,
} from './key-brands.js';
import { buildIndexFromBrands, saveIndex } from './index.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-keybrands-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function seller(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'X',
    amazon_seller_id: null,
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'US',
    region: null,
    agency_name: null,
    acos_target: null,
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

async function seedIndex(brands: BrandSuggestion[]): Promise<void> {
  const index = buildIndexFromBrands(brands, null);
  await saveIndex(index, testDir);
}

describe('addKeyBrand', () => {
  it('resolves a display name and adds the slug', async () => {
    await seedIndex([brand({ slug: 'summit-labs', display_name: 'Summit Labs' })]);
    const result = await addKeyBrand('Summit Labs', testDir);
    expect(result.status).toBe('added');
    expect(result.brand?.slug).toBe('summit-labs');
    expect(result.key_brands).toEqual(['summit-labs']);
  });

  it('resolves an acronym and adds the slug', async () => {
    await seedIndex([
      brand({ slug: 'aspen-outdoor-provisions', display_name: 'Aspen Outdoor Provisions' }),
    ]);
    const result = await addKeyBrand('AOP', testDir);
    expect(result.status).toBe('added');
    expect(result.brand?.slug).toBe('aspen-outdoor-provisions');
  });

  it('reports already_key when the slug is already in the list', async () => {
    await seedIndex([brand({ slug: 'summit-labs', display_name: 'Summit Labs' })]);
    await addKeyBrand('summit-labs', testDir);
    const result = await addKeyBrand('Summit Labs', testDir);
    expect(result.status).toBe('already_key');
    expect(result.key_brands).toEqual(['summit-labs']);
  });

  it('returns ambiguous candidates without modifying the list', async () => {
    await seedIndex([
      brand({ slug: 'ridgepak', display_name: 'Ridgepak' }),
      brand({ slug: 'ridgepak-ca', display_name: 'Ridgepak - CA' }),
    ]);
    const result = await addKeyBrand('Ridgep', testDir);
    expect(result.status).toBe('ambiguous');
    expect(result.candidates?.length).toBeGreaterThan(1);
    expect(result.key_brands).toEqual([]);
  });

  it('returns not_found for unknown input', async () => {
    await seedIndex([brand({ slug: 'a', display_name: 'A' })]);
    const result = await addKeyBrand('zzzzz', testDir);
    expect(result.status).toBe('not_found');
    expect(result.key_brands).toEqual([]);
  });

  it('appends to existing key list without overwriting', async () => {
    await seedIndex([
      brand({ slug: 'a', display_name: 'A Brand' }),
      brand({ slug: 'b', display_name: 'B Brand' }),
    ]);
    await addKeyBrand('A Brand', testDir);
    const second = await addKeyBrand('B Brand', testDir);
    expect(second.key_brands).toEqual(['a', 'b']);
  });
});

describe('removeKeyBrand', () => {
  it('removes by display-name input', async () => {
    await seedIndex([brand({ slug: 'summit-labs', display_name: 'Summit Labs' })]);
    await addKeyBrand('Summit Labs', testDir);
    const result = await removeKeyBrand('Summit Labs', testDir);
    expect(result.status).toBe('removed');
    expect(result.key_brands).toEqual([]);
  });

  it('removes by direct slug input even when slug is no longer in registry (stale cleanup)', async () => {
    // First seed and add
    await seedIndex([brand({ slug: 'temp-brand', display_name: 'Temp Brand' })]);
    await addKeyBrand('temp-brand', testDir);
    // Now reseed index WITHOUT the brand (simulating ops archiving it)
    await seedIndex([brand({ slug: 'other', display_name: 'Other' })]);
    // Removal by slug still works
    const result = await removeKeyBrand('temp-brand', testDir);
    expect(result.status).toBe('removed');
    expect(result.key_brands).toEqual([]);
  });

  it('returns not_key when brand is in registry but not in key list', async () => {
    await seedIndex([brand({ slug: 'a', display_name: 'A' })]);
    const result = await removeKeyBrand('A', testDir);
    expect(result.status).toBe('not_key');
  });
});

describe('loadKeyBrands', () => {
  it('returns empty when no profile exists', async () => {
    const list = await loadKeyBrands(testDir);
    expect(list).toEqual([]);
  });

  it('flags stale entries (slug in profile but not in registry)', async () => {
    await seedIndex([brand({ slug: 'live', display_name: 'Live Brand' })]);
    await addKeyBrand('live', testDir);
    // Reseed index without 'live'
    await seedIndex([brand({ slug: 'other', display_name: 'Other' })]);
    const list = await loadKeyBrands(testDir);
    expect(list).toHaveLength(1);
    expect(list[0]!.slug).toBe('live');
    expect(list[0]!.registry_entry).toBeNull();
  });

  it('returns registry_entry for healthy slugs', async () => {
    await seedIndex([brand({ slug: 'a', display_name: 'A Brand' })]);
    await addKeyBrand('a', testDir);
    const list = await loadKeyBrands(testDir);
    expect(list[0]!.slug).toBe('a');
    expect(list[0]!.registry_entry?.display_name).toBe('A Brand');
  });
});

describe('clearKeyBrands', () => {
  it('empties the list and returns the count', async () => {
    await seedIndex([
      brand({ slug: 'a', display_name: 'A' }),
      brand({ slug: 'b', display_name: 'B' }),
    ]);
    await addKeyBrand('a', testDir);
    await addKeyBrand('b', testDir);
    const result = await clearKeyBrands(testDir);
    expect(result.removed_count).toBe(2);
    const list = await loadKeyBrands(testDir);
    expect(list).toEqual([]);
  });

  it('returns zero count when list was already empty', async () => {
    const result = await clearKeyBrands(testDir);
    expect(result.removed_count).toBe(0);
  });
});
