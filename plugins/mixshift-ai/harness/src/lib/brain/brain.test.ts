import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { brandBrainSchema } from './schema.js';
import { assembleBrain, assembleSellerSection, hashRows } from './assemble.js';
import { loadBrain, saveBrain, resolveAcosTargetPct } from './read.js';
import { applyObservations, recordObservations } from './observe.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');

const aopRow = {
  ID: 574,
  MerchantAlias: "Backpacker's Pantry",
  Name: 'American Outdoor Products',
  ACOSTarget: '25.0',
  MonthlyBudget: 18000,
  MarketPlaceName: 'Amazon.com',
  MerchantRegion: 'NA',
  AgencyName: 'American Outdoor Products',
  DefaultCurrencyCode: 'USD',
  iBrandReportEnabled: 1,
  iRunningInitialPull: 0,
  dtLatestRecordDate: '2026-06-08T00:00:00.000Z',
  dtMWSLatestRecordDate: new Date('2026-06-08T00:00:00.000Z'),
  dtActivatedOn: '2024-08-15T00:00:00.000Z',
  dtMwsActivatedOn: '2024-08-22T00:00:00.000Z',
};

function assembledAop() {
  return assembleBrain({
    brandSlug: 'backpackers-pantry',
    sellerRows: [aopRow],
    sellerSproc: 'sp_brain_seller_fetch',
    generator: 'plugin@0.5.21-test',
    now: NOW,
  });
}

describe('assembleBrain', () => {
  it('produces a schema-valid document with provenance', () => {
    const brain = assembledAop();
    const parsed = brandBrainSchema.parse(brain);
    expect(parsed.brand_slug).toBe('backpackers-pantry');
    expect(parsed.generated_at).toBe(NOW.toISOString());
    expect(parsed.generator).toBe('plugin@0.5.21-test');
    expect(parsed.sources.seller).toMatchObject({
      sproc: 'sp_brain_seller_fetch',
      fetched_at: NOW.toISOString(),
      row_count: 1,
    });
    expect(parsed.sources.seller!.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lifts seller fields with defensive coercion (strings, tinyints, Dates)', () => {
    const brain = assembledAop();
    expect(brain.seller).toMatchObject({
      merchant_alias: "Backpacker's Pantry",
      storefront_name: 'American Outdoor Products',
      acos_target_pct: 25.0,
      monthly_budget: 18000,
      marketplace: 'Amazon.com',
      default_currency_code: 'USD',
      i_brand_report_enabled: true,
      i_running_initial_pull: false,
      primary_seller_id: 574,
    });
    expect(brain.seller!.data_freshness.ads_latest).toBe('2026-06-08T00:00:00.000Z');
    expect(brain.seller!.data_freshness.retail_latest).toBe('2026-06-08T00:00:00.000Z');
  });

  it('picks the first row with a non-null ACOSTarget as primary', () => {
    const seller = assembleSellerSection([
      { ID: 1, ACOSTarget: null, MerchantAlias: 'NoTarget' },
      { ID: 2, ACOSTarget: '30', MerchantAlias: 'HasTarget' },
      { ID: 3, ACOSTarget: '40', MerchantAlias: 'AlsoHasTarget' },
    ]);
    expect(seller.primary_seller_id).toBe(2);
    expect(seller.acos_target_pct).toBe(30);
    expect(seller.merchant_alias).toBe('HasTarget');
  });

  it('falls back to the first row when no row carries a target', () => {
    const seller = assembleSellerSection([
      { ID: 7, ACOSTarget: null, MerchantAlias: 'OnlyRow' },
    ]);
    expect(seller.primary_seller_id).toBe(7);
    expect(seller.acos_target_pct).toBeNull();
  });

  it('tolerates empty row sets without throwing', () => {
    const seller = assembleSellerSection([]);
    expect(seller.acos_target_pct).toBeNull();
    expect(seller.primary_seller_id).toBeNull();
  });

  it('carries previous observations forward through re-assembly', () => {
    const withObs = applyObservations(assembledAop(), [
      {
        field: 'buy_box_health.chronic_losers',
        value: ['B00TEST'],
        confidence: 0.8,
        observed_by: 'mx-featured-offer-watch@1.0.0',
        observed_at: NOW.toISOString(),
      },
    ]);
    const reassembled = assembleBrain({
      brandSlug: 'backpackers-pantry',
      sellerRows: [aopRow],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@0.5.21-test',
      now: NOW,
      previousObservations: withObs.observations,
    });
    expect(reassembled.observations['buy_box_health.chronic_losers']).toMatchObject({
      value: ['B00TEST'],
      count: 1,
    });
  });
});

describe('hashRows', () => {
  it('is stable across key order and Date/string equivalence', () => {
    const a = hashRows([{ x: 1, y: 'a', d: new Date('2026-01-01T00:00:00.000Z') }]);
    const b = hashRows([{ d: '2026-01-01T00:00:00.000Z', y: 'a', x: 1 }]);
    expect(a).toBe(b);
  });

  it('changes when values change', () => {
    expect(hashRows([{ x: 1 }])).not.toBe(hashRows([{ x: 2 }]));
  });
});

describe('saveBrain + loadBrain round-trip', () => {
  it('round-trips through yaml atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const brain = assembledAop();
      const { path } = await saveBrain(brain, dir);
      expect(path).toContain(join('clients', 'backpackers-pantry'));
      const loaded = await loadBrain('backpackers-pantry', dir);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.brain).toEqual(brain);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file_missing (not throw) for un-fetched brands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const loaded = await loadBrain('never-fetched', dir);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.kind).toBe('file_missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns schema_violation for documents from a different shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const brandDir = join(dir, 'clients', 'bad-brand');
      await mkdir(brandDir, { recursive: true });
      await writeFile(
        join(brandDir, 'brand-brain.yaml'),
        stringifyYaml({ schema_version: 99, nonsense: true }),
        'utf-8',
      );
      const loaded = await loadBrain('bad-brand', dir);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.kind).toBe('schema_violation');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAcosTargetPct precedence', () => {
  // True Tier-3-wins coverage (schema-valid context fixture) lands with
  // the DHC consumption step, which needs a full context fixture anyway.
  it('falls through to the brain when context.yaml exists but fails schema validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledAop(), dir); // brain says 25
      const brandDir = join(dir, 'clients', 'backpackers-pantry');
      await writeFile(
        join(brandDir, 'context.yaml'),
        // Minimal context that satisfies just the fields we read; the
        // resolver uses validateBrandContext, so a schema-invalid file
        // falls through to the brain rather than throwing.
        stringifyYaml({ management: { acos_target_pct: 22 } }),
        'utf-8',
      );
      const resolved = await resolveAcosTargetPct('backpackers-pantry', dir);
      // context.yaml here is schema-incomplete, so validation fails and
      // the brain value is the correct outcome. This asserts the
      // fall-through behavior is graceful.
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe('brain');
      expect(resolved!.value).toBe(25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves the brain value with fetched_at when no context exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledAop(), dir);
      const resolved = await resolveAcosTargetPct('backpackers-pantry', dir);
      expect(resolved).toMatchObject({
        value: 25,
        source: 'brain',
        fetched_at: NOW.toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when neither tier has the field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const noTarget = assembleBrain({
        brandSlug: 'no-target',
        sellerRows: [{ ID: 1, ACOSTarget: null }],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: NOW,
      });
      await saveBrain(noTarget, dir);
      expect(await resolveAcosTargetPct('no-target', dir)).toBeNull();
      expect(await resolveAcosTargetPct('never-fetched', dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('observations', () => {
  it('applyObservations bumps count on repeat and keeps latest value', () => {
    const base = assembledAop();
    const obs = (value: unknown) => ({
      field: 'buy_box_health.chronic_losers',
      value,
      confidence: 0.7,
      observed_by: 'mx-featured-offer-watch@1.0.0',
      observed_at: NOW.toISOString(),
    });
    const once = applyObservations(base, [obs(['A'])]);
    const twice = applyObservations(once, [obs(['A', 'B'])]);
    const agg = twice.observations['buy_box_health.chronic_losers']!;
    expect(agg.count).toBe(2);
    expect(agg.value).toEqual(['A', 'B']);
    // Pure: the base document is untouched.
    expect(base.observations['buy_box_health.chronic_losers']).toBeUndefined();
  });

  it('recordObservations persists through the local transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledAop(), dir);
      const result = await recordObservations(
        'backpackers-pantry',
        [
          {
            field: 'buy_box_health.rolling_lost_rev_usd',
            value: 612.5,
            confidence: 0.6,
            observed_by: 'mx-featured-offer-watch@1.0.0',
            observed_at: NOW.toISOString(),
          },
        ],
        dir,
      );
      expect(result.ok).toBe(true);
      const loaded = await loadBrain('backpackers-pantry', dir);
      if (loaded.ok) {
        expect(
          loaded.brain.observations['buy_box_health.rolling_lost_rev_usd'],
        ).toMatchObject({ value: 612.5, count: 1 });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordObservations no-ops gracefully when no brain exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const result = await recordObservations(
        'never-fetched',
        [
          {
            field: 'x.y',
            value: 1,
            confidence: 0.5,
            observed_by: 'test@0',
            observed_at: NOW.toISOString(),
          },
        ],
        dir,
      );
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
