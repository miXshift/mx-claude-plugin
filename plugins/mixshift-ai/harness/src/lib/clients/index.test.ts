import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readIndex,
  saveIndex,
  buildIndexFromBrands,
  filterIndex,
  isStale,
  countByActivity,
  markBrandColdStarted,
} from './index.js';
import { emptyIndex, type ClientsIndex } from './index-schema.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-index-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function seller(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    amazon_seller_id: 'A1XXX',
    merchant_alias: 'acme',
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
    slug: 'acme-corp',
    display_name: 'Acme Corp',
    ads_active: true,
    retail_active: true,
    accounts: [seller({})],
    ...overrides,
  };
}

describe('readIndex / saveIndex roundtrip', () => {
  it('returns empty + source=empty when file does not exist', async () => {
    const { index, source } = await readIndex(testDir);
    expect(source).toBe('empty');
    expect(index.brands).toEqual([]);
    expect(index.schema_version).toBe(1);
  });

  it('writes + reads back a valid index', async () => {
    const built = buildIndexFromBrands([brand({})], null);
    await saveIndex(built, testDir);
    const { index, source } = await readIndex(testDir);
    expect(source).toBe('file');
    expect(index.brands).toHaveLength(1);
    expect(index.brands[0]!.slug).toBe('acme-corp');
    expect(index.brands[0]!.is_dormant).toBe(false);
  });

  it('throws a clear error on malformed YAML', async () => {
    // Write garbage to the index path directly
    const { writeFile } = await import('node:fs/promises');
    const { indexPath } = await import('../paths/resolve.js');
    await mkdir(join(testDir, 'clients'), { recursive: true });
    await writeFile(indexPath(testDir), 'not: valid: yaml:::', 'utf-8');
    await expect(readIndex(testDir)).rejects.toThrow(/malformed YAML|invalid/);
  });
});

describe('buildIndexFromBrands', () => {
  it('marks brand as dormant when all accounts are inactive', () => {
    const dormantBrand = brand({
      slug: 'dormant-co',
      display_name: 'Dormant Co',
      ads_active: false,
      retail_active: false,
      accounts: [seller({ ads_active: false, retail_active: false })],
    });
    const index = buildIndexFromBrands([dormantBrand], null);
    expect(index.brands[0]!.is_dormant).toBe(true);
  });

  it('marks brand as NOT dormant when at least one account is active', () => {
    const mixedBrand = brand({
      slug: 'mixed-co',
      display_name: 'Mixed Co',
      ads_active: false,
      retail_active: true,
      accounts: [
        seller({ marketplace: 'US', ads_active: false, retail_active: true }),
        seller({ marketplace: 'CA', ads_active: false, retail_active: false }),
      ],
    });
    const index = buildIndexFromBrands([mixedBrand], null);
    expect(index.brands[0]!.is_dormant).toBe(false);
  });

  it('carries forward cold_started state from prior index', () => {
    // Prior index: brand was cold-started
    const prior: ClientsIndex = buildIndexFromBrands([brand({})], null);
    prior.brands[0]!.cold_started = true;
    prior.brands[0]!.cold_started_at = '2026-05-01T00:00:00.000Z';

    // New discovery: same brand, now dormant
    const dormantSameBrand = brand({
      ads_active: false,
      retail_active: false,
      accounts: [seller({ ads_active: false, retail_active: false })],
    });
    const next = buildIndexFromBrands([dormantSameBrand], prior);

    expect(next.brands[0]!.cold_started).toBe(true);
    expect(next.brands[0]!.cold_started_at).toBe('2026-05-01T00:00:00.000Z');
    expect(next.brands[0]!.is_dormant).toBe(true);
  });

  it('starts cold_started=false for brands not in the prior index', () => {
    const prior = buildIndexFromBrands([], null);
    const next = buildIndexFromBrands([brand({ slug: 'fresh-co' })], prior);
    expect(next.brands[0]!.cold_started).toBe(false);
    expect(next.brands[0]!.cold_started_at).toBeNull();
  });
});

describe('filterIndex', () => {
  it('active mode hides dormant brands', () => {
    const built = buildIndexFromBrands(
      [
        brand({ slug: 'live-co', ads_active: true }),
        brand({
          slug: 'dead-co',
          ads_active: false,
          retail_active: false,
          accounts: [seller({ ads_active: false, retail_active: false })],
        }),
      ],
      null,
    );
    expect(filterIndex(built, 'active').map((b) => b.slug)).toEqual(['live-co']);
  });

  it('dormant mode shows only dormants', () => {
    const built = buildIndexFromBrands(
      [
        brand({ slug: 'live-co' }),
        brand({
          slug: 'dead-co',
          ads_active: false,
          retail_active: false,
          accounts: [seller({ ads_active: false, retail_active: false })],
        }),
      ],
      null,
    );
    expect(filterIndex(built, 'dormant').map((b) => b.slug)).toEqual(['dead-co']);
  });

  it('all mode returns everything in original order', () => {
    const built = buildIndexFromBrands(
      [brand({ slug: 'a' }), brand({ slug: 'b' })],
      null,
    );
    expect(filterIndex(built, 'all').map((b) => b.slug)).toEqual(['a', 'b']);
  });
});

describe('isStale', () => {
  it('returns true when discovered_at is older than TTL', () => {
    const old: ClientsIndex = {
      schema_version: 1,
      discovered_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      brands: [],
    };
    expect(isStale(old)).toBe(true);
  });

  it('returns false when discovered_at is fresh', () => {
    const fresh: ClientsIndex = {
      schema_version: 1,
      discovered_at: new Date().toISOString(),
      brands: [],
    };
    expect(isStale(fresh)).toBe(false);
  });

  it('returns true on the empty index (epoch timestamp)', () => {
    expect(isStale(emptyIndex())).toBe(true);
  });
});

describe('countByActivity', () => {
  it('counts active, dormant, and cold-started correctly', () => {
    const built = buildIndexFromBrands(
      [
        brand({ slug: 'a', ads_active: true }),
        brand({ slug: 'b', ads_active: true }),
        brand({
          slug: 'c',
          ads_active: false,
          retail_active: false,
          accounts: [seller({ ads_active: false, retail_active: false })],
        }),
      ],
      null,
    );
    // Mark one as cold-started
    built.brands[0]!.cold_started = true;
    const counts = countByActivity(built);
    expect(counts).toEqual({
      total: 3,
      active: 2,
      dormant: 1,
      cold_started: 1,
    });
  });
});

describe('markBrandColdStarted', () => {
  it('flips cold_started=true and sets a timestamp', async () => {
    const built = buildIndexFromBrands([brand({ slug: 'flip-me' })], null);
    await saveIndex(built, testDir);

    const result = await markBrandColdStarted('flip-me', testDir);
    expect(result.updated).toBe(true);

    const { index } = await readIndex(testDir);
    expect(index.brands[0]!.cold_started).toBe(true);
    expect(index.brands[0]!.cold_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is a no-op when the index does not exist yet', async () => {
    const result = await markBrandColdStarted('nothing-here', testDir);
    expect(result.updated).toBe(false);
  });

  it('is a no-op when the brand slug is not in the index', async () => {
    const built = buildIndexFromBrands([brand({ slug: 'a' })], null);
    await saveIndex(built, testDir);

    const result = await markBrandColdStarted('not-in-index', testDir);
    expect(result.updated).toBe(false);

    const { index } = await readIndex(testDir);
    expect(index.brands[0]!.slug).toBe('a');
    expect(index.brands[0]!.cold_started).toBe(false);
  });
});
