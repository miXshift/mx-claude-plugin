import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashStructuralEvents,
  mapAffectsRef,
  mapEventToStake,
  normalizeEndTs,
  normalizeStartTs,
  preflightEvent,
  stakeIdempotencyKey,
  syncStakes,
} from './stake-sync.js';
import type { TimelineClient } from './client.js';
import type { StructuralEvent } from '../context/schema.js';

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

const DATED_EVENT: StructuralEvent = {
  id: 'dsp-ramp-2026-01',
  type: 'launch',
  affects: [{ sub_brand: 'house-blend' }],
  interpretation: 'DSP began in earnest in January 2026 (fixture).',
  start: '2026-01-01',
};

const UNDATED_EVENT: StructuralEvent = {
  id: 'seasonal-flavor-rotation',
  type: 'assortment_change',
  affects: [],
  interpretation: 'Seasonal flavors rotate in and out of the assortment.',
};

describe('mapEventToStake', () => {
  it('maps a dated event: type→category, kind fallback, date pinned to start of day', () => {
    const body = mapEventToStake('example-brand', DATED_EVENT);
    expect(body).toEqual({
      brand_slug: 'example-brand',
      family: 'structural',
      kind: 'structural.launch',
      category: 'launch',
      source: 'declared',
      interpretation: 'DSP began in earnest in January 2026 (fixture).',
      ts: '2026-01-01T00:00:00Z',
      affects: ['sub_brand:house-blend'],
      evidence: { recorded_from: 'context.yaml', event_date_known: true },
      idempotency_key: 'ctxev:example-brand:dsp-ramp-2026-01',
    });
  });

  it('an undated event omits ts and marks event_date_known:false', () => {
    const body = mapEventToStake('acme', UNDATED_EVENT);
    expect(body.ts).toBeUndefined();
    expect(body.evidence).toEqual({
      recorded_from: 'context.yaml',
      event_date_known: false,
    });
  });

  it('an explicit kind wins over the type fallback and tags pass through', () => {
    const body = mapEventToStake('acme', {
      ...UNDATED_EVENT,
      type: 'other',
      kind: 'mmm_attributed_demand_gen',
      tags: ['mmm', 'agency-partner'],
    });
    expect(body.kind).toBe('structural.mmm_attributed_demand_gen');
    expect(body.category).toBe('other');
    expect(body.tags).toEqual(['mmm', 'agency-partner']);
  });

  it('end / active_through map to end_ts pinned to END of day (end wins)', () => {
    expect(
      mapEventToStake('acme', { ...DATED_EVENT, end: '2026-02-15' }).end_ts,
    ).toBe('2026-02-15T23:59:59Z');
    expect(
      mapEventToStake('acme', { ...DATED_EVENT, active_through: '2026-03-01' }).end_ts,
    ).toBe('2026-03-01T23:59:59Z');
    expect(
      mapEventToStake('acme', {
        ...DATED_EVENT,
        end: '2026-02-15',
        active_through: '2026-03-01',
      }).end_ts,
    ).toBe('2026-02-15T23:59:59Z');
  });

  it('full ISO timestamps pass through both normalizers untouched', () => {
    expect(normalizeStartTs('2026-01-01T09:30:00Z')).toBe('2026-01-01T09:30:00Z');
    expect(normalizeEndTs('2026-01-02T10:00:00+02:00')).toBe('2026-01-02T10:00:00+02:00');
  });
});

describe('mapAffectsRef', () => {
  it.each([
    [{ sub_brand: 'house-blend' }, 'sub_brand:house-blend'],
    [{ item_group: 'Unsweetened Hydration' }, 'item_group:Unsweetened Hydration'],
    [{ seller_id: 71 }, 'seller_id:71'],
    ['marketplace:US', 'marketplace:US'],
  ])('%j -> %s', (entry, expected) => {
    expect(mapAffectsRef(entry)).toBe(expected);
  });

  it.each([
    ['empty string', ''],
    ['two-key object', { a: '1', b: '2' }],
    ['nested value', { a: { b: 1 } }],
    ['array', ['x']],
    ['null', null],
  ])('drops a malformed entry (%s) as null', (_n, entry) => {
    expect(mapAffectsRef(entry)).toBeNull();
  });
});

describe('stakeIdempotencyKey', () => {
  it('is the readable ctxev:<brand>:<id> form in the common case', () => {
    expect(stakeIdempotencyKey('acme', 'ev-1')).toBe('ctxev:acme:ev-1');
  });

  it('hashes only when the plain key would exceed the server 255-char cap, deterministically', () => {
    const longId = 'x'.repeat(300);
    const key = stakeIdempotencyKey('acme', longId);
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).toBe(stakeIdempotencyKey('acme', longId));
    expect(key).not.toBe(stakeIdempotencyKey('acme', `${longId}y`));
  });
});

describe('hashStructuralEvents', () => {
  it('is stable for identical content and moves on any change', () => {
    const a = hashStructuralEvents([DATED_EVENT, UNDATED_EVENT]);
    expect(a).toBe(hashStructuralEvents([DATED_EVENT, UNDATED_EVENT]));
    expect(a).not.toBe(
      hashStructuralEvents([{ ...DATED_EVENT, interpretation: 'edited' }, UNDATED_EVENT]),
    );
  });
});

// ---------------------------------------------------------------------------
// syncStakes against a real temp brand dir + stubbed client
// ---------------------------------------------------------------------------

const CONTEXT_YAML = `
schema_version: 1
brand_slug: acme
brand_name: Acme
last_updated: "2026-08-03"
accounts:
  - seller_id: 1
    seller_name: Acme Seller
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: campaignmetric
  ops_revenue: business_reports_dpst_date
  ops_revenue_field: SalesAmount
  ops_units_field: UnitsOrdered
  ops_date_field: DateTime
management:
  primary_metric: ACOS
  acos_target_pct: 20.0
  attribution_window_days: 14
structural_events:
  - id: dsp-ramp
    type: launch
    affects:
      - sub_brand: house-blend
    interpretation: DSP ramp.
    start: "2026-01-01"
  - id: seasonal-rotation
    type: assortment_change
    affects: []
    interpretation: Seasonal flavors rotate.
`;

type StubResult =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; kind?: 'bad_params' | 'reserved_kind' | 'host_unreachable' };

function stubClient(results: StubResult[]): TimelineClient {
  let i = 0;
  return {
    listEvents: vi.fn(),
    corroborateEvent: vi.fn(),
    postEvent: vi.fn(async () => {
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      if (r.ok) return r;
      const kind = r.kind ?? 'bad_params';
      return {
        ok: false as const,
        kind,
        message: 'nope',
        friendly:
          kind === 'host_unreachable'
            ? 'The MixShift auth service is unreachable.'
            : 'The event violates a field constraint.',
      };
    }),
  } as unknown as TimelineClient;
}

describe('syncStakes', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  async function writeBrand(yaml: string = CONTEXT_YAML): Promise<void> {
    testDir = await mkdtemp(join(tmpdir(), 'mx-stake-sync-'));
    const brandDir = join(testDir, 'clients', 'acme');
    await mkdir(brandDir, { recursive: true });
    await writeFile(join(brandDir, 'context.yaml'), yaml, 'utf8');
  }

  it('posts one stake per event and reports created/duplicate', async () => {
    await writeBrand();
    const client = stubClient([
      { ok: true, id: 'evt-1' },
      { ok: true, id: 'evt-2', duplicate: true },
    ]);
    const result = await syncStakes('acme', { dataDirOverride: testDir, client });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.reports.map((r) => r.outcome)).toEqual(['created', 'duplicate']);
    expect(result.reports[0]).toMatchObject({ id: 'dsp-ramp', date_known: true });
    expect(result.reports[1]).toMatchObject({ id: 'seasonal-rotation', date_known: false });
  });

  it('a per-event failure is reported, does not stop the rest, and flips ok', async () => {
    await writeBrand();
    const client = stubClient([{ ok: false }, { ok: true, id: 'evt-2' }]);
    const result = await syncStakes('acme', { dataDirOverride: testDir, client });
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.reports[0].outcome).toBe('failed');
    expect(result.reports[0].detail).toContain('constraint');
  });

  it('dry-run maps and reports without posting', async () => {
    await writeBrand();
    const client = stubClient([{ ok: true, id: 'never' }]);
    const result = await syncStakes('acme', {
      dataDirOverride: testDir,
      client,
      dryRun: true,
    });
    expect(result.reports.map((r) => r.outcome)).toEqual(['planned', 'planned']);
    expect(client.postEvent).not.toHaveBeenCalled();
  });

  it('a brand with no context file reports a whole-run error', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mx-stake-sync-'));
    const result = await syncStakes('missing-brand', {
      dataDirOverride: testDir,
      client: stubClient([{ ok: true, id: 'never' }]),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No brand context');
    expect(result.total).toBe(0);
  });

  it('stamps the sync ledger on a fully-clean run', async () => {
    await writeBrand();
    const statePath = join(testDir, 'clients', 'acme', '.context-sync-state.json');
    await syncStakes('acme', {
      dataDirOverride: testDir,
      client: stubClient([{ ok: true, id: 'evt-1' }, { ok: true, id: 'evt-2' }]),
    });
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      stakes?: { last_synced_hash: string; last_synced_at: string };
    };
    expect(state.stakes?.last_synced_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a TRANSIENT failure does NOT stamp (the next write retries it)', async () => {
    await writeBrand();
    const statePath = join(testDir, 'clients', 'acme', '.context-sync-state.json');
    const result = await syncStakes('acme', {
      dataDirOverride: testDir,
      client: stubClient([{ ok: false, kind: 'host_unreachable' }, { ok: true, id: 'evt-2' }]),
    });
    expect(result.failed).toBe(1);
    expect(result.permanent_failures).toBe(0);
    expect(result.reports[0].permanent).toBeUndefined();
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('an all-PERMANENT failure DOES stamp, so one bad event cannot wedge the brand forever', async () => {
    await writeBrand();
    const statePath = join(testDir, 'clients', 'acme', '.context-sync-state.json');
    const result = await syncStakes('acme', {
      dataDirOverride: testDir,
      client: stubClient([{ ok: false, kind: 'reserved_kind' }, { ok: true, id: 'evt-2' }]),
    });
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.permanent_failures).toBe(1);
    expect(result.reports[0].permanent).toBe(true);
    // Stamped despite the failure: retrying cannot help, and re-posting the
    // whole set on every future context write would never make progress.
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      stakes?: { last_synced_hash: string };
    };
    expect(state.stakes?.last_synced_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dry-run never stamps the ledger', async () => {
    await writeBrand();
    const statePath = join(testDir, 'clients', 'acme', '.context-sync-state.json');
    await syncStakes('acme', {
      dataDirOverride: testDir,
      client: stubClient([{ ok: true, id: 'evt-1' }]),
      dryRun: true,
    });
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Red-team remediations (#37499 review)
// ---------------------------------------------------------------------------

describe('mapEventToStake — review fixes', () => {
  it('an UNDATED event with an end anchors ts to the end day (never a backwards range)', () => {
    // Omitting ts here would let the server pin ts=now, putting the close
    // BEFORE the start and 400ing 'end_ts must be at or after ts' forever.
    const body = mapEventToStake('acme', {
      ...UNDATED_EVENT,
      active_through: '2025-09-30',
    });
    expect(body.ts).toBe('2025-09-30T00:00:00Z');
    expect(body.end_ts).toBe('2025-09-30T23:59:59Z');
    expect(Date.parse(body.end_ts as string)).toBeGreaterThanOrEqual(
      Date.parse(body.ts as string),
    );
    // The event's own date is still unknown; ts is only an anchor.
    expect((body.evidence as Record<string, unknown>).event_date_known).toBe(false);
  });

  it('a zone-less timestamp is stamped UTC (the server requires an offset)', () => {
    const body = mapEventToStake('acme', {
      ...DATED_EVENT,
      start: '2026-01-15T09:00:00',
      end: '2026-01-16T17:30',
    });
    expect(body.ts).toBe('2026-01-15T09:00:00Z');
    expect(body.end_ts).toBe('2026-01-16T17:30Z');
  });

  it('an UNKNOWN local type folds into the server `other` category, losslessly', () => {
    const body = mapEventToStake('acme', {
      ...UNDATED_EVENT,
      type: 'some_future_type',
    });
    expect(body.category).toBe('other');
    // The original slug survives on both the kind axis and the evidence.
    expect(body.kind).toBe('structural.some_future_type');
    expect((body.evidence as Record<string, unknown>).local_type).toBe('some_future_type');
  });

  it('a known type never records local_type (no noise on the common path)', () => {
    const body = mapEventToStake('acme', DATED_EVENT);
    expect((body.evidence as Record<string, unknown>).local_type).toBeUndefined();
  });
});

describe('preflightEvent', () => {
  const base = { ...UNDATED_EVENT };

  it('passes a normal event', () => {
    expect(preflightEvent(base, new Set())).toBeNull();
  });

  it('rejects a duplicate id (both events would collapse to one stake)', () => {
    const reason = preflightEvent(base, new Set([base.id]));
    expect(reason).toContain('duplicate id');
    expect(reason).toContain(base.id);
  });

  it('rejects an over-long interpretation before any round trip', () => {
    const reason = preflightEvent({ ...base, interpretation: 'x'.repeat(4001) }, new Set());
    expect(reason).toContain('4001');
    expect(reason).toContain('4000');
  });

  it('rejects too many affects and an over-long affects ref', () => {
    expect(
      preflightEvent(
        { ...base, affects: Array.from({ length: 65 }, (_v, i) => ({ asin: `B${i}` })) },
        new Set(),
      ),
    ).toContain('65 entries');
    expect(
      preflightEvent({ ...base, affects: [{ note: 'x'.repeat(300) }] }, new Set()),
    ).toContain('limit is 256');
  });
});

describe('syncStakes — preflight integration', () => {
  let testDir: string;
  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('a duplicate id is reported as a permanent failure and never posted', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mx-stake-dup-'));
    const brandDir = join(testDir, 'clients', 'acme');
    await mkdir(brandDir, { recursive: true });
    await writeFile(
      join(brandDir, 'context.yaml'),
      CONTEXT_YAML.replace('id: seasonal-rotation', 'id: dsp-ramp'),
      'utf8',
    );
    const client = stubClient([{ ok: true, id: 'evt-1' }]);
    const result = await syncStakes('acme', { dataDirOverride: testDir, client });
    expect(client.postEvent).toHaveBeenCalledTimes(1); // only the first
    expect(result.failed).toBe(1);
    expect(result.permanent_failures).toBe(1);
    expect(result.reports[1]).toMatchObject({ outcome: 'failed', permanent: true });
    expect(result.reports[1].detail).toContain('duplicate id');
  });
});
