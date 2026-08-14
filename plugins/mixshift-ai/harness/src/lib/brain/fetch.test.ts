import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

vi.mock('../data/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/dispatch.js')>();
  return { ...actual, runDispatched: vi.fn() };
});

// F4: wraps the REAL resolveBinding by default (every other test's binding
// fixtures keep working unchanged) so individual tests can override it with
// mockRejectedValueOnce to prove a throwing resolveBinding doesn't break
// fetchBrandBrain, without stubbing binding resolution out for every test.
vi.mock('../binding/resolve.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../binding/resolve.js')>();
  return { ...actual, resolveBinding: vi.fn(actual.resolveBinding) };
});

// fs control for the "failFetch is defensive" test. The mock is INERT by
// default (delegates every call to the real implementation); a test arms it by
// setting `renameFailFrom` to make the Nth `rename` throw an ENOSPC-like error.
// Used to simulate the status-file write itself failing on a full/read-only
// disk. vi.hoisted so the value exists when the (hoisted) vi.mock factory runs.
const fsControl = vi.hoisted(() => ({
  renameCalls: 0,
  renameFailFrom: Number.POSITIVE_INFINITY,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      fsControl.renameCalls += 1;
      if (fsControl.renameCalls >= fsControl.renameFailFrom) {
        throw Object.assign(
          new Error('ENOSPC: no space left on device, rename'),
          { code: 'ENOSPC' },
        );
      }
      return actual.rename(from, to);
    },
  };
});

import { runDispatched } from '../data/dispatch.js';
import { resolveBinding } from '../binding/resolve.js';
import { fetchBrandBrain, BRAIN_TTL_DAYS } from './fetch.js';
import { loadBrain, saveBrain } from './read.js';
import { assembleBrain } from './assemble.js';
import { applyObservations } from './observe.js';
import { buildBrainFetchArgv, spawnBrainFetchDetached } from './spawn.js';

const runDispatchedMock = vi.mocked(runDispatched);
const resolveBindingMock = vi.mocked(resolveBinding);

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

function ok(
  id: string,
  rows: Array<Record<string, unknown>>,
  appliedParams?: string[],
) {
  return {
    ok: true as const,
    id,
    rows,
    rowCount: rows.length,
    durationMs: 12,
    usedDispatch: 'sproc' as const,
    displaySql: `CALL ${id}(?, ?)`,
    boundParams: {},
    ...(appliedParams ? { appliedParams } : {}),
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
  // Disarm the fs rename fault-injection between tests.
  fsControl.renameCalls = 0;
  fsControl.renameFailFrom = Number.POSITIVE_INFINITY;
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

describe('fetchBrandBrain — failFetch is defensive under a failing status write', () => {
  it('does NOT throw when the .brain-status.json write itself fails (ENOSPC/EACCES tail)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      // Fatal seller failure routes straight to failFetch (no saveBrain in
      // between), so the rename calls are: #1 the 'fetching' status write
      // (succeeds), #2 the failFetch 'failed' status write. Arm #2 to throw —
      // this is the exact disk-full/permission tail the fix hardens against.
      fsControl.renameFailFrom = 2;
      routeDispatch({
        'BRAIN-SELLER': failed('BRAIN-SELLER', 'PROCEDURE sp_brain_seller_fetch does not exist'),
      });

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // The whole point: this must RESOLVE to a clean failed result, never
        // reject. A reject here would escape to the CLI and fire plugin.crashed.
        const result = await fetchBrandBrain({
          slug: 'foragers-pantry',
          dataDirOverride: dir,
          now: NOW,
        });

        expect(result.status).toBe('failed');
        if (result.status === 'failed') {
          expect(result.error).toContain('sp_brain_seller_fetch');
        }
        // failFetch swallowed the status-write throw (best-effort stderr log)
        // instead of propagating it.
        expect(errSpy).toHaveBeenCalled();
        // The 'fetching' write (rename #1) landed; the 'failed' write (rename
        // #2) threw and was swallowed, so the file is still the earlier
        // 'fetching' snapshot rather than being updated to 'failed'. Either way
        // the process didn't crash — that is the guarantee under test.
        const status = JSON.parse(
          await readFile(
            join(dir, 'clients', 'foragers-pantry', '.brain-status.json'),
            'utf-8',
          ),
        );
        expect(status.status).toBe('fetching');
      } finally {
        errSpy.mockRestore();
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

// ---------------------------------------------------------------------------
// Sub-brand label lens (mx-ops#6): bound brands fetch label-scoped sources
// ---------------------------------------------------------------------------

describe('fetchBrandBrain — sub-brand label lens', () => {
  async function writeBindingFixture(dir: string, opts: { ads?: boolean } = {}) {
    const context = {
      schema_version: 1,
      brand_slug: 'foragers-pantry',
      brand_name: "Forager's Pantry",
      last_updated: '2026-06-01',
      accounts: [
        {
          seller_id: 574,
          seller_name: 'Aspen Outdoor Provisions',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'campaignmetric',
        ops_revenue: 'business_reports_dpst_date',
        ops_revenue_field: 'SalesAmount',
        ops_units_field: 'UnitsOrdered',
        ops_date_field: 'DateTime',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 25,
        attribution_window_days: 14,
      },
      binding: {
        kind: 'sub_brand',
        amazon_seller_id: 'A1EXAMPLE23456',
        seller_ids: [574, 575],
        retail_label: { source: 'mws_items.Brand', value: "Forager's Pantry" },
        ...(opts.ads === false
          ? {}
          : { ads_label: { source: 'campaign.Brand', value: "Forager's Pantry" } }),
        scope_note: 'This brand is a sub-brand scoped to a label.',
      },
    };
    await mkdir(join(dir, 'clients', 'foragers-pantry'), { recursive: true });
    await writeFile(
      join(dir, 'clients', 'foragers-pantry', 'context.yaml'),
      stringifyYaml(context),
      'utf-8',
    );
  }

  it('passes the label params to exactly the lens-aware sources and records the EVIDENCE-CONFIRMED split', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        // Evidence: the gateway echoes our key back in applied_params. Only
        // NOW does 'applied' become a provable claim (the central fix).
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow], ['retail_brand_label', 'seller_ids']),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow], ['ads_brand_label', 'seller_ids']),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      // Lens-aware sources got their param, with the verbatim value.
      expect(callFor('BRAIN-CATALOG-SC')?.params).toMatchObject({
        retail_brand_label: "Forager's Pantry",
      });
      expect(callFor('BRAIN-CAMPAIGN')?.params).toMatchObject({
        ads_brand_label: "Forager's Pantry",
      });
      // Non-lens sources did NOT gain any label key.
      const seller = callFor('BRAIN-SELLER')?.params ?? {};
      expect(Object.keys(seller)).not.toContain('retail_brand_label');
      expect(Object.keys(seller)).not.toContain('ads_brand_label');
      const hero = callFor('BRAIN-HERO-SC')?.params ?? {};
      expect(Object.keys(hero)).not.toContain('retail_brand_label');

      // The split is recorded on the summary AND stamped into the brain doc.
      expect(result.summary.label_lens).not.toBeNull();
      expect(result.summary.label_lens!.applied).toEqual(
        expect.arrayContaining(['BRAIN-CATALOG-SC', 'BRAIN-CAMPAIGN']),
      );
      expect(result.summary.label_lens!.dropped).toEqual([]);
      expect(result.summary.label_lens!.unverified).toEqual([]);
      expect(result.summary.label_lens!.account_wide).toEqual(
        expect.arrayContaining(['BRAIN-SELLER', 'BRAIN-HERO-SC', 'BRAIN-RECENT-ACTIVITY']),
      );
      const brain = await loadBrain('foragers-pantry', dir);
      expect(brain.ok).toBe(true);
      if (brain.ok) {
        expect(brain.brain.label_lens?.applied).toEqual(
          expect.arrayContaining(['BRAIN-CATALOG-SC', 'BRAIN-CAMPAIGN']),
        );
      }
      // The loud notice names the slug.
      expect(result.summary.lens_warnings.join('\n')).toContain('foragers-pantry');
    });
  });

  it("DROPPED (P0): applied_params came back WITHOUT our key -> account-wide despite the binding, never 'applied'", async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        // The gateway ran the query (ok:true, rows came back) but its
        // applied_params does NOT contain retail_brand_label: the deployed
        // entry silently stripped our filter. Before the central fix, the
        // old client-side lensFor would have recorded this as 'applied'
        // purely because a value was SENT — exactly the bug this fixes.
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow], ['seller_ids']),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow], ['ads_brand_label', 'seller_ids']),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      expect(result.summary.label_lens!.dropped).toEqual(['BRAIN-CATALOG-SC']);
      expect(result.summary.label_lens!.applied).not.toContain('BRAIN-CATALOG-SC');
      expect(result.summary.label_lens!.applied).toContain('BRAIN-CAMPAIGN');
      expect(result.summary.lens_warnings.join('\n')).toContain('DROPPED');
      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) expect(brain.brain.label_lens?.dropped).toEqual(['BRAIN-CATALOG-SC']);
    });
  });

  it("UNVERIFIED: applied_params is ABSENT entirely (older gateway) -> not proven, never 'applied'", async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        // ok() with NO third argument -> no appliedParams field at all,
        // simulating a gateway deploy that predates PR #107.
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      expect(result.summary.label_lens!.unverified).toEqual(
        expect.arrayContaining(['BRAIN-CATALOG-SC', 'BRAIN-CAMPAIGN']),
      );
      expect(result.summary.label_lens!.applied).toEqual([]);
      expect(result.summary.lens_warnings.join('\n')).toContain('UNVERIFIED');
    });
  });

  it("query_failed: a failed label-aware query never resolves to 'applied'", async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': failed('BRAIN-CATALOG-SC', 'table access denied'),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow], ['ads_brand_label']),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      expect(result.summary.label_lens!.query_failed).toEqual(['BRAIN-CATALOG-SC']);
      expect(result.summary.label_lens!.applied).not.toContain('BRAIN-CATALOG-SC');
      expect(result.summary.failed_sources).toContain('catalog_sc');
    });
  });

  it('sends NOTHING and records nothing for an unbound brand (byte-identical behavior)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      for (const [, opts] of runDispatchedMock.mock.calls) {
        const params = (opts as { params?: Record<string, unknown> }).params ?? {};
        expect(Object.keys(params)).not.toContain('retail_brand_label');
        expect(Object.keys(params)).not.toContain('ads_brand_label');
      }
      expect(result.summary.label_lens).toBeNull();
      expect(result.summary.lens_warnings).toEqual([]);
      const brain = await loadBrain('foragers-pantry', dir);
      if (brain.ok) expect(brain.brain.label_lens).toBeUndefined();
    });
  });

  it('records missing_label_value when the binding has no ads label', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir, { ads: false });
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [scCatalogRow]),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;

      const campaign = callFor('BRAIN-CAMPAIGN')?.params ?? {};
      expect(Object.keys(campaign)).not.toContain('ads_brand_label');
      expect(result.summary.label_lens!.missing_label_value).toContain('BRAIN-CAMPAIGN');
      expect(result.summary.lens_warnings.join('\n')).toContain('binding has no label value');
    });
  });

  it('warns LOUDLY when a CONFIRMED-applied retail lens matches zero catalog rows', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        // Evidence confirms the filter DID apply (retail_brand_label is in
        // applied_params) - it's just that it matched nothing, the label-typo
        // case this warning exists for.
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [], ['retail_brand_label']),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow], ['ads_brand_label']),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.summary.label_lens!.applied).toContain('BRAIN-CATALOG-SC');
      expect(result.summary.lens_warnings.join('\n')).toContain('ZERO catalog rows');
    });
  });

  it('does NOT warn "ZERO catalog rows" when the lens was DROPPED rather than applied (no false confidence)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      await writeBindingFixture(dir);
      routeDispatch({
        'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]),
        // Zero rows AND the filter was dropped: the right warning is
        // "DROPPED / account-wide", not "your label typo produced zero
        // rows" (which would misdirect the operator toward fixing a label
        // value that was never actually the cause).
        'BRAIN-CATALOG-SC': ok('BRAIN-CATALOG-SC', [], ['seller_ids']),
        'BRAIN-CAMPAIGN': ok('BRAIN-CAMPAIGN', [campaignRow], ['ads_brand_label']),
      });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      expect(result.summary.label_lens!.dropped).toContain('BRAIN-CATALOG-SC');
      expect(result.summary.lens_warnings.join('\n')).not.toContain('ZERO catalog rows');
      expect(result.summary.lens_warnings.join('\n')).toContain('DROPPED');
    });
  });
});

// ---------------------------------------------------------------------------
// F4: resolveBinding throwing must never break fetchBrandBrain, for ANY
// brand (bound or not). resolve.ts fixed its OWN never-throws contract, but
// fetch.ts carries its OWN guard too (defense in depth) — this proves THAT
// guard, by forcing resolveBinding itself to reject despite its own fix.
// ---------------------------------------------------------------------------

describe('fetchBrandBrain — a throwing resolveBinding does not break the fetch (F4)', () => {
  it('treats the failure as unbound and completes the fetch instead of crashing', async () => {
    resolveBindingMock.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({ 'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]) });

      const result = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('complete');
      if (result.status !== 'complete') return;
      // Treated as unbound: no lens claims of any kind.
      expect(result.summary.label_lens).toBeNull();
      expect(result.summary.lens_warnings).toEqual([]);
    });
  });

  it('a fresh (skipped_fresh) fetch never even calls resolveBinding (F4 ordering: resolved AFTER the TTL gate)', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      routeDispatch({ 'BRAIN-SELLER': ok('BRAIN-SELLER', [sellerRow]) });
      // Prime a fresh brain so the second fetch hits the TTL gate.
      await fetchBrandBrain({ slug: 'foragers-pantry', dataDirOverride: dir, now: NOW });
      resolveBindingMock.mockClear();

      const second = await fetchBrandBrain({
        slug: 'foragers-pantry',
        dataDirOverride: dir,
        now: new Date(NOW.getTime() + 1000),
      });
      expect(second.status).toBe('skipped_fresh');
      expect(resolveBindingMock).not.toHaveBeenCalled();
    });
  });
});
