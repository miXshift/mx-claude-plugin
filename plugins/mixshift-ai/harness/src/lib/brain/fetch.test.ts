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
  MerchantAlias: "Backpacker's Pantry",
  Name: 'American Outdoor Products',
  ACOSTarget: 25,
  MarketPlaceName: 'Amazon.com',
};

function dispatchOk(rows: Array<Record<string, unknown>> = [sellerRow]) {
  return {
    ok: true as const,
    id: 'BRAIN-SELLER',
    rows,
    rowCount: rows.length,
    durationMs: 12,
    usedDispatch: 'sproc' as const,
    displaySql: 'CALL sp_brain_seller_fetch(?, ?)',
    boundParams: {},
  };
}

/** Minimal valid clients/index.yaml registry with one brand. */
async function writeIndexFixture(dir: string, slug = 'backpackers-pantry') {
  const index = {
    schema_version: 1,
    discovered_at: NOW.toISOString(),
    brands: [
      {
        slug,
        display_name: "Backpacker's Pantry",
        ads_active: true,
        retail_active: true,
        is_dormant: false,
        cold_started: false,
        cold_started_at: null,
        accounts: [
          {
            seller_id: 574,
            seller_name: 'American Outdoor Products',
            merchant_alias: "Backpacker's Pantry",
            account_type: 'SC',
            marketplace: 'US',
            region: 'NA',
            is_active: true,
            is_mws_user: true,
            ads_active: true,
            retail_active: true,
          },
          {
            seller_id: 575,
            seller_name: 'American Outdoor Products',
            merchant_alias: "Backpacker's Pantry",
            account_type: 'SC',
            marketplace: 'CA',
            region: 'NA',
            is_active: true,
            is_mws_user: true,
            ads_active: true,
            retail_active: true,
          },
        ],
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

beforeEach(() => {
  runDispatchedMock.mockReset();
});

describe('fetchBrandBrain', () => {
  it('happy path: fetches, assembles, persists, writes complete status', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      runDispatchedMock.mockResolvedValueOnce(dispatchOk());

      const result = await fetchBrandBrain({
        slug: 'backpackers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });

      expect(result.status).toBe('complete');
      if (result.status === 'complete') {
        expect(result.summary).toMatchObject({
          row_count: 1,
          acos_target_pct: 25,
          merchant_alias: "Backpacker's Pantry",
          used_dispatch: 'sproc',
        });
      }

      // seller_ids passed via params (serves both sproc + local-dev paths)
      const [, opts] = runDispatchedMock.mock.calls[0]!;
      expect(opts!.params).toEqual({ seller_ids: [574, 575] });

      const brain = await loadBrain('backpackers-pantry', dir);
      expect(brain.ok).toBe(true);
      if (brain.ok) {
        expect(brain.brain.seller?.acos_target_pct).toBe(25);
        expect(brain.brain.generator).toMatch(/^plugin@/);
        expect(brain.brain.sources.seller?.sproc).toBe('sp_brain_seller_fetch');
      }

      const statusRaw = await readFile(
        join(dir, 'clients', 'backpackers-pantry', '.brain-status.json'),
        'utf-8',
      );
      const status = JSON.parse(statusRaw);
      expect(status.status).toBe('complete');
      expect(status.summary.row_count).toBe(1);
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
      // Seed a brain fetched 1 day ago (inside the 30d TTL).
      const seeded = assembleBrain({
        brandSlug: 'backpackers-pantry',
        sellerRows: [sellerRow],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      });
      await saveBrain(seeded, dir);

      const skipped = await fetchBrandBrain({
        slug: 'backpackers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(skipped.status).toBe('skipped_fresh');
      if (skipped.status === 'skipped_fresh') {
        expect(skipped.ttl_days).toBe(BRAIN_TTL_DAYS);
      }
      expect(runDispatchedMock).not.toHaveBeenCalled();

      runDispatchedMock.mockResolvedValueOnce(dispatchOk());
      const forced = await fetchBrandBrain({
        slug: 'backpackers-pantry',
        refresh: true,
        dataDirOverride: dir,
        now: NOW,
      });
      expect(forced.status).toBe('complete');
      expect(runDispatchedMock).toHaveBeenCalledTimes(1);
    });
  });

  it('re-fetches when the brain is older than the TTL', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      const old = assembleBrain({
        brandSlug: 'backpackers-pantry',
        sellerRows: [sellerRow],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: new Date(NOW.getTime() - (BRAIN_TTL_DAYS + 1) * 24 * 60 * 60 * 1000),
      });
      await saveBrain(old, dir);
      runDispatchedMock.mockResolvedValueOnce(dispatchOk());

      const result = await fetchBrandBrain({
        slug: 'backpackers-pantry',
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
          brandSlug: 'backpackers-pantry',
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
      runDispatchedMock.mockResolvedValueOnce(dispatchOk());

      await fetchBrandBrain({
        slug: 'backpackers-pantry',
        refresh: true,
        dataDirOverride: dir,
        now: NOW,
      });

      const brain = await loadBrain('backpackers-pantry', dir);
      if (brain.ok) {
        expect(
          brain.brain.observations['buy_box_health.chronic_losers'],
        ).toMatchObject({ value: ['B00X'], count: 1 });
      } else {
        expect.fail('brain should load after re-fetch');
      }
    });
  });

  it('classifies dispatch failures and writes a failed status file', async () => {
    await withTempDir(async (dir) => {
      await writeIndexFixture(dir);
      runDispatchedMock.mockResolvedValueOnce({
        ok: false,
        id: 'BRAIN-SELLER',
        usedDispatch: 'sproc',
        failure: {
          ok: false,
          kind: 'unknown',
          message: 'PROCEDURE sp_brain_seller_fetch does not exist',
          friendly: 'PROCEDURE sp_brain_seller_fetch does not exist',
        },
      });

      const result = await fetchBrandBrain({
        slug: 'backpackers-pantry',
        dataDirOverride: dir,
        now: NOW,
      });
      expect(result.status).toBe('failed');

      const status = JSON.parse(
        await readFile(
          join(dir, 'clients', 'backpackers-pantry', '.brain-status.json'),
          'utf-8',
        ),
      );
      expect(status.status).toBe('failed');
      expect(status.error).toContain('sp_brain_seller_fetch');

      // No brain document written on failure.
      const brain = await loadBrain('backpackers-pantry', dir);
      expect(brain.ok).toBe(false);
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
