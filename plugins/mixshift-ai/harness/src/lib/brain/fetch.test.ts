import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

vi.mock('../data/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/dispatch.js')>();
  return { ...actual, runDispatched: vi.fn() };
});

import { runDispatched } from '../data/dispatch.js';
import { fetchBrandBrain, BRAIN_TTL_DAYS } from './fetch.js';
import { loadBrain, saveBrain } from './read.js';
import { assembleBrain } from './assemble.js';
import { applyObservations } from './observe.js';
import { buildBrainFetchArgv, spawnBrainFetchDetached } from './spawn.js';

const runDispatchedMock = vi.mocked(runDispatched);

const NOW = new Date('2026-06-10T12:00:00.000Z');

const sellerRow = {
  ID: 574,
  MerchantAlias: "Forager's Pantry",
  Name: 'Aspen Outdoor Provisions',
  ACOSTarget: 25,
  MarketPlaceName: 'Amazon.com',
};

const scCatalogRow = {
  ASIN: 'B00AAA111',
  SKU: 'BP-CHEW-01',
  Brand: "Forager's Pantry",
  ItemGroup: 'Energy Chews',
};

const campaignRow = {
  Objective: 'defend',
  ItemGroup: 'Energy Chews',
  Brand: "Forager's Pantry",
  State: 'enabled',
  BidOptimization: 'smart',
  BrandEntityId: 'ENTITY123',
};

function ok(id: string, rows: Array<Record<string, unknown>>) {
  return {
    ok: true as const,
    id,
    rows,
    rowCount: rows.length,
    durationMs: 12,
    usedDispatch: 'sproc' as const,
    displaySql: `CALL ${id}(?, ?)`,
    boundParams: {},
  };
}

function failed(id: string, message: string) {
  return {
    ok: false as const,
    id,
    usedDispatch: 'sproc' as const,
    failure: { ok: false as const, kind: 'unknown', message, friendly: message },
  };
}

/** Route the dispatch mock by query id; unrouted ids return empty-ok. */
function routeDispatch(
  routes: Record<string, ReturnType<typeof ok> | ReturnType<typeof failed>>,
) {
  runDispatchedMock.mockImplementation(async (id: string) => {
    return (routes[id] ?? ok(id, [])) as never;
  });
}

interface FixtureAccount {
  seller_id: number;
  account_type: 'SC' | 'VC' | 'DSP' | 'unknown';
}

/** Minimal valid clients/index.yaml registry with one brand. */
async function writeIndexFixture(
  dir: string,
  accounts: FixtureAccount[] = [
    { seller_id: 574, account_type: 'SC' },
    { seller_id: 575, account_type: 'SC' },
  ],
  slug = 'foragers-pantry',
) {
  const index = {
    schema_version: 1,
    discovered_at: NOW.toISOString(),
    brands: [
      {
        slug,
        display_name: "Forager's Pantry",
        ads_active: true,
        retail_active: true,
        is_dormant: false,
        cold_started: false,
        cold_started_at: null,
        accounts: accounts.map((a) => ({
          seller_id: a.seller_id,
          seller_name: 'Aspen Outdoor Provisions',
          merchant_alias: "Forager's Pantry",
          account_type: a.account_type,
          marketplace: 'US',
          region: 'NA',
          is_active: true,
          is_mws_user: true,
          ads_active: true,
          retail_active: true,
        })),
      },
    ],
  };
  await mkdir(join(dir, 'clients'), { recursive: true });
  await writeFile(join(dir, 'clients', 'index.yaml'), stringifyYaml(index), 'utf-8');
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mx-brain-fetch-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function callIds(): string[] {
  return runDispatchedMock.mock.calls.map(([id]) => id as string);
}

function callFor(id: string) {
  const call = runDispatchedMock.mock.calls.find(([cid]) => cid === id);
  return call ? (call[1] as { params?: Record<string, unknown> }) : undefined;
}

beforeEach(() => {
  runDispatchedMock.mockReset();
});

describe('fetchBrandBrain — multi-source orchestration', () => {
  it('SC-only brand: fans out to seller + catalog_sc + campaign (no VC)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.summary).toMatchObject({
          row_count: 1,
          acos_target_pct: 25,
          asin_count: 1,
          campaign_count: 1,
          failed_sources: [],
        });
      }

      const ids = callIds();
      expect(ids).toContain('BRAIN-SELLER');
      expect(ids).toContain('BRAIN-CATALOG-SC');
      expect(ids).toContain('BRAIN-CAMPAIGN');
      expect(ids).not.toContain('BRAIN-CATALOG-VC');

      expect(callFor('BRAIN-SELLER')!.params).toEqual({ seller_ids: [574, 575] });
      expect(callFor('BRAIN-CATALOG-SC')!.params).toEqual({ seller_ids: [574, 575] });
      expect(callFor('BRAIN-CAMPAIGN')!.params).toEqual({ seller_ids: [574, 575] });

      const brain = await loadBrain('foragers-pantry', dir);
      expect(brain.ok).toBe(true);
      if (brain.ok) {
        expect(brain.brain.catalog).toMatchObject({
          asin_count: 1,
          sub_brands: ["Forager's Pantry"],
          item_groups: ['Energy Chews'],
        });
        expect(brain.brain.campaign_structure).toMatchObject({
          campaign_count: 1,
          distinct_objectives: ['defend'],
          smart_default_adoption_pct: 100,
          brand_entity_id_presence_pct: 100,
        });
        expect(brain.brain.sources.catalog_sc?.sproc).toBe('sp_brain_catalog_fetch_sc');
        expect(brain.brain.sources.campaign?.sproc).toBe('sp_brain_campaign_fetch');
        expect(brain.brain.sources.catalog_vc).toBeUndefined();
      }

      const status = JSON.parse(
        await readFile(
          join(dir, 'clients', 'foragers-pantry', '.brain-status.json'),
          'utf-8',
        ),
      );
      expect(status.status).toBe('complete');
      expect(status.summary.asin_count).toBe(1);
    });
  });

  it('mixed SC+VC+DSP brand: catalog splits by type, campaign covers all seats', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir, [
        { seller_id: 574, account_type: 'SC' },
        { seller_id: 580, account_type: 'VC' },
        { seller_id: 590, account_type: 'DSP' },
      ]);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
        'BRAIN-CATALOG-VC': ok('BRAIN-CATALOG-VC', [
          { Asin: 'B00VVV222', CustomBrand: 'Astronaut Foods', ItemGroup: 'Freeze Dried' },
        ]),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');

      expect(callFor('BRAIN-SELLER')!.params).toEqual({
        seller_ids: [574, 580, 590],
      });
      expect(callFor('BRAIN-CATALOG-SC')!.params).toEqual({ seller_ids: [574] });
      expect(callFor('BRAIN-CATALOG-VC')!.params).toEqual({ seller_ids: [580] });
      expect(callFor('BRAIN-CAMPAIGN')!.params).toEqual({
        seller_ids: [574, 580, 590],
      });

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        // SC Brand + VC CustomBrand merge into sub_brands
        expect(brain.brain.catalog?.sub_brands).toEqual([
          'Astronaut Foods',
          "Forager's Pantry",
        ]);
        expect(brain.brain.catalog?.asin_count).toBe(2);
      } else {
        expect.fail('brain should load');
      }
    });
  });

  it('DSP-only brand: no catalog calls, campaign still runs', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir, [{ seller_id: 590, account_type: 'DSP' }]);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      const ids = callIds();
      expect(ids).not.toContain('BRAIN-CATALOG-SC');
      expect(ids).not.toContain('BRAIN-CATALOG-VC');
      expect(ids).toContain('BRAIN-CAMPAIGN');

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        expect(brain.brain.catalog).toBeUndefined();
        expect(brain.brain.campaign_structure?.campaign_count).toBe(1);
      }
    });
  });

  it('partial failure: campaign source fails, brain still completes with failed_sources', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
        'BRAIN-CAMPAIGN': failed('BRAIN-CAMPAIGN', 'PROCEDURE sp_brain_campaign_fetch does not exist'),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.summary.failed_sources).toEqual(['campaign']);
        expect(result.summary.asin_count).toBe(1);
        expect(result.summary.campaign_count).toBeNull();
      }

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        expect(brain.brain.campaign_structure).toBeUndefined();
        expect(brain.brain.sources.campaign).toBeUndefined();
        expect(brain.brain.catalog?.asin_count).toBe(1);
      }
    });
  });

  it('seller failure is fatal: writes failed status, no brain document', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': failed('BRAIN-SELLER', 'PROCEDURE sp_brain_seller_fetch does not exist'),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('failed');

      const status = JSON.parse(
        await readFile(
          join(dir, 'clients', 'foragers-pantry', '.brain-status.json'),
          'utf-8',
        ),
      );
      expect(status.status).toBe('failed');
      expect(status.error).toContain('sp_brain_seller_fetch');

      const brain = await loadBrain('foragers-pantry', dir);
      expect(brain.ok).toBe(false);
    });
  });

  it('returns brand_not_found for unknown slugs without dispatching', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      const result = await fetchBrandBrain({
        slug: 'nope',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('brand_not_found');
      expect(runDispatchedMock).not.toHaveBeenCalled();
    });
  });

  it('skips inside the TTL window and honors refresh override', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      const seeded = assembleBrain({
        brandSlug: 'foragers-pantry',
        sellerRows: [sellerRow],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      });
      await saveBrain(seeded, dir);

      const skipped = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(skipped.status).toBe('skipped_fresh');
      if (skipped.status === 'skipped_fresh') {
        expect(skipped.ttl_days).toBe(BRAIN_TTL_DAYS);
      }
      expect(runDispatchedMock).not.toHaveBeenCalled();

      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
      });
      const forced = await fetchBrandBrain({
        slug: 'foragers-pantry',
        refresh: true,
        dataDirOverride: dir,
        now: NOW,
      });
      expect(forced.status).toBe('complete');
    });
  });

  it('re-fetches when the brain is older than the TTL', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      const old = assembleBrain({
        brandSlug: 'foragers-pantry',
        sellerRows: [sellerRow],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: new Date(NOW.getTime() - (BRAIN_TTL_DAYS + 1) * 24 * 60 * 60 * 1000),
      });
      await saveBrain(old, dir);
      routeDispatch({ 'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]) });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
    });
  });

  it('preserves accumulated observations across a forced re-fetch', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      const seeded = applyObservations(
        assembleBrain({
          brandSlug: 'foragers-pantry',
          sellerRows: [sellerRow],
          sellerSproc: 'sp_brain_seller_fetch',
          generator: 'plugin@test',
          now: NOW,
        }),
        [
          {
            field: 'buy_box_health.chronic_losers',
            value: ['B00X'],
            confidence: 0.9,
            observed_by: 'mx-featured-offer-watch@1.0.0',
            observed_at: NOW.toISOString(),
          },
        ],
      );
      await saveBrain(seeded, dir);
      routeDispatch({ 'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]) });

      await fetchBrandBrain({
        slug: 'foragers-pantry',
        refresh: true,
        dataDirOverride: dir,
        now: NOW,
      });

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        expect(
          brain.brain.observations['buy_box_health.chronic_losers'],
        ).toMatchObject({ value: ['B00X'], count: 1 });
      } else {
        expect.fail('brain should load after re-fetch');
      }
    });
  });
});

describe('fetchBrandBrain — primary-seat selection (metrics vs heuristic)', () => {
  // Brand with a US Seller-Central seat (800) and a US Vendor seat (900).
  // The registry heuristic prefers SC over VC, so it picks 800. The seller
  // source returns a row per seat with a distinguishable alias so we can read
  // back which seat supplied the brain's seller scalars.
  const twoSeatAccounts: FixtureAccount[] = [
    { seller_id: 800, account_type: 'SC' },
    { seller_id: 900, account_type: 'VC' },
  ];
  const sellerRows = [
    { ID: 800, MerchantAlias: 'SC Seat 800', ACOSTarget: 25, MarketPlaceName: 'Amazon.com' },
    { ID: 900, MerchantAlias: 'VC Seat 900', ACOSTarget: 18, MarketPlaceName: 'Amazon.com (VC)' },
  ];

  it('prefers the metrics pick (900) over the heuristic (800) when seat metrics are present', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir, twoSeatAccounts);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', sellerRows),
        // 900 (VC) is the economic leader despite the heuristic favoring SC.
        'BRAIN-SEAT-METRICS': ok('BRAIN-SEAT-METRICS', [
          { seller_id: 800, usd_revenue: 1000, usd_spend: 0 },
          { seller_id: 900, usd_revenue: 500000, usd_spend: 75000 },
        ]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');

      // The metrics source ran over ALL seats.
      expect(callFor('BRAIN-SEAT-METRICS')!.params).toEqual({ seller_ids: [800, 900] });

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        // Primary seat = the metrics leader (900), NOT the heuristic (800).
        expect(brain.brain.seller?.primary_seller_id).toBe(900);
        expect(brain.brain.seller?.merchant_alias).toBe('VC Seat 900');
        expect(brain.brain.seller?.acos_target_pct).toBe(18);
      } else {
        expect.fail('brain should load');
      }
    });
  });

  it('falls back to the heuristic (800) when the seat-metrics source returns no rows', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir, twoSeatAccounts);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', sellerRows),
        'BRAIN-SEAT-METRICS': ok('BRAIN-SEAT-METRICS', []), // not registered / nothing
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        // No economic signal -> registry heuristic picks the US SC seat (800).
        expect(brain.brain.seller?.primary_seller_id).toBe(800);
        expect(brain.brain.seller?.merchant_alias).toBe('SC Seat 800');
      } else {
        expect.fail('brain should load');
      }
    });
  });

  it('falls back to the heuristic when the seat-metrics source FAILS (non-fatal)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir, twoSeatAccounts);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', sellerRows),
        'BRAIN-SEAT-METRICS': failed(
          'BRAIN-SEAT-METRICS',
          'No query pack entry with id BRAIN-SEAT-METRICS',
        ),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      // Selection-only source: its failure is NOT a failed_source and NOT fatal.
      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.summary.failed_sources).not.toContain('seat_metrics');
        expect(result.summary.failed_sources).not.toContain('BRAIN-SEAT-METRICS');
      }

      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) {
        expect(brain.brain.seller?.primary_seller_id).toBe(800);
      } else {
        expect.fail('brain should load');
      }
    });
  });
});

describe('spawn helper', () => {
  it('builds the detached argv with the data-dir flag', () => {
    expect(buildBrainFetchArgv('/cli.js', 'acme', '/tmp/data')).toEqual([
      '/cli.js',
      'brand',
      'brain',
      'fetch',
      'acme',
      '--data-dir',
      '/tmp/data',
    ]);
    expect(buildBrainFetchArgv('/cli.js', 'acme')).toEqual([
      '/cli.js',
      'brand',
      'brain',
      'fetch',
      'acme',
    ]);
  });

  it('refuses to spawn under the kill-switch and in test runners', () => {
    expect(
      spawnBrainFetchDetached('acme', undefined, { MIXSHIFT_BRAIN_NO_SPAWN: '1' }),
    ).toMatchObject({ spawned: false });
    expect(
      spawnBrainFetchDetached('acme', undefined, { VITEST: 'true' }),
    ).toMatchObject({ spawned: false, reason: expect.stringContaining('test') });
  });
});
