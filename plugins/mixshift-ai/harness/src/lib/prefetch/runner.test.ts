/**
 * Prefetch runner integration tests — added with the sub-brand label lens
 * (mx-ops#6). Everything I/O-shaped is mocked; the assertions are about WHAT
 * the runner sends per query and what it records, which is exactly the lens's
 * contract surface:
 *   - bound brand  → label-aware queries carry the label param, others don't,
 *                    and the run records the applied/account-wide split;
 *   - unbound brand → the bound-params objects are BYTE-IDENTICAL to before
 *                    the lens existed (no label keys anywhere, label_lens null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/dispatch.js')>();
  return { ...actual, runDispatched: vi.fn() };
});
vi.mock('./manifest.js', () => ({
  loadSkillManifest: vi.fn(),
  resolveBatchPlan: vi.fn(),
}));
vi.mock('./sql-library.js', () => ({
  getQueryEntry: vi.fn(async (id: string) => ({ id, purpose: `purpose of ${id}` })),
}));
vi.mock('../context/load.js', () => ({
  loadBrandContext: vi.fn(),
}));
vi.mock('./artifacts.js', () => ({
  writePrefetchArtifacts: vi.fn(async () => ({
    run_dir: '/tmp/run',
    data_json_path: '/tmp/run/data.json',
    data_md_path: '/tmp/run/data.md',
  })),
}));
vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => undefined) };
});

import { runPrefetch } from './runner.js';
import { runDispatched } from '../data/dispatch.js';
import { loadSkillManifest, resolveBatchPlan } from './manifest.js';
import { loadBrandContext } from '../context/load.js';
import { writePrefetchArtifacts } from './artifacts.js';
import { LENS_CONTRACT_VERSION } from '../binding/lens.js';

const runDispatchedMock = vi.mocked(runDispatched);
const loadSkillManifestMock = vi.mocked(loadSkillManifest);
const resolveBatchPlanMock = vi.mocked(resolveBatchPlan);
const loadBrandContextMock = vi.mocked(loadBrandContext);
const writeArtifactsMock = vi.mocked(writePrefetchArtifacts);

const BASE_CONTEXT = {
  schema_version: 1,
  brand_slug: 'foragers-pantry',
  brand_name: "Forager's Pantry",
  last_updated: '2026-06-01',
  accounts: [
    {
      seller_id: 574,
      seller_name: 'Aspen Outdoor Provisions',
      account_type: 'SC' as const,
      status: 'active' as const,
      role: 'primary' as const,
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
    primary_metric: 'ACOS' as const,
    acos_target_pct: 25,
    attribution_window_days: 14,
  },
};

const BINDING = {
  kind: 'sub_brand',
  amazon_seller_id: 'A1EXAMPLE23456',
  seller_ids: [574],
  retail_label: { source: 'mws_items.Brand', value: "Forager's Pantry" },
  ads_label: { source: 'campaign.Brand', value: "Forager's Pantry" },
  scope_note: 'scoped',
};

/**
 * Default mock: simulates a fully up-to-date gateway that echoes back
 * (sorted) every param it received as `appliedParams` — i.e. every param a
 * test sends is provably "applied" unless the test overrides this per-query
 * to exercise dropped/unverified/query_failed. This keeps the mock
 * EVIDENCE-based (mx-legacy-auth PR #107) rather than hand-waving 'applied'.
 */
function okDispatch() {
  runDispatchedMock.mockImplementation(async (
    id: string,
    opts?: { params?: Record<string, unknown> },
  ) => ({
    ok: true as const,
    id,
    rows: [],
    rowCount: 0,
    durationMs: 5,
    usedDispatch: 'named' as const,
    displaySql: `-- ${id}`,
    boundParams: opts?.params ?? {},
    revision: 'r1',
    appliedParams: Object.keys(opts?.params ?? {}).sort(),
  }) as never);
}

/** Override ONE query id's dispatch result for this test only (dropped /
 *  unverified / failed / zero-row scenarios), leaving every other id on the
 *  default `okDispatch()` behavior above. */
function overrideDispatch(id: string, result: Record<string, unknown>): void {
  const base = runDispatchedMock.getMockImplementation()!;
  runDispatchedMock.mockImplementation(async (
    qid: string,
    opts?: { params?: Record<string, unknown> },
  ) => {
    if (qid === id) return result as never;
    return base(qid, opts);
  });
}

function paramsSentTo(id: string): Record<string, unknown> {
  const call = runDispatchedMock.mock.calls.find(([cid]) => cid === id);
  expect(call, `expected a dispatch call for ${id}`).toBeDefined();
  return (call![1] as { params: Record<string, unknown> }).params;
}

beforeEach(() => {
  vi.clearAllMocks();
  okDispatch();
  loadSkillManifestMock.mockResolvedValue({
    skill_id: 'mx-brand-context',
    version: '2.8.0',
    schema_version: 1,
    run_kind: 'setup',
    sql_ids: ['CS-02', 'CS-09', 'CS-11'],
  } as never);
  resolveBatchPlanMock.mockReturnValue([
    { parallel: ['CS-02', 'CS-09'] },
    { parallel: ['CS-11'] },
  ] as never);
});

describe('runPrefetch — sub-brand label lens', () => {
  it('bound brand: label-aware queries carry the retail param, others gain no label keys', async () => {
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(paramsSentTo('CS-09').retail_brand_label).toBe("Forager's Pantry");
    expect(paramsSentTo('CS-11').retail_brand_label).toBe("Forager's Pantry");
    const cs02 = paramsSentTo('CS-02');
    expect(Object.keys(cs02)).not.toContain('retail_brand_label');
    expect(Object.keys(cs02)).not.toContain('ads_brand_label');

    expect(result.label_lens).toEqual({
      bound: true,
      contract: LENS_CONTRACT_VERSION,
      applied: expect.arrayContaining(['CS-09', 'CS-11']),
      dropped: [],
      unverified: [],
      account_wide: ['CS-02'],
      missing_label_value: [],
      query_failed: [],
    });

    // The durable artifact records the same split.
    const meta = writeArtifactsMock.mock.calls[0]![0].meta as Record<string, unknown>;
    expect(meta.label_lens).toEqual(result.label_lens);
  });

  it('unbound brand: bound params are byte-identical (no label keys) and label_lens is null', async () => {
    loadBrandContextMock.mockResolvedValue({ context: BASE_CONTEXT } as never);

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    for (const [, opts] of runDispatchedMock.mock.calls) {
      const params = (opts as { params: Record<string, unknown> }).params;
      expect(Object.keys(params)).not.toContain('retail_brand_label');
      expect(Object.keys(params)).not.toContain('ads_brand_label');
    }
    expect(result.label_lens).toBeNull();
    const meta = writeArtifactsMock.mock.calls[0]![0].meta as Record<string, unknown>;
    expect(meta.label_lens).toBeNull();
  });

  it('bound brand missing the ads label records missing_label_value for ads-side queries', async () => {
    resolveBatchPlanMock.mockReturnValue([{ parallel: ['BRAIN-CAMPAIGN', 'CS-09'] }] as never);
    const noAds = { ...BINDING } as Record<string, unknown>;
    delete noAds.ads_label;
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: noAds },
    } as never);

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    const campaign = paramsSentTo('BRAIN-CAMPAIGN');
    expect(Object.keys(campaign)).not.toContain('ads_brand_label');
    expect(result.label_lens!.missing_label_value).toEqual(['BRAIN-CAMPAIGN']);
    expect(result.label_lens!.applied).toEqual(['CS-09']);
  });

  it("DROPPED (P0): the gateway's applied_params came back WITHOUT our key -> account-wide despite the binding, never 'applied'", async () => {
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);
    // CS-09 ran ok and returned rows, but the deployed entry's applied_params
    // does not include retail_brand_label — the filter was silently
    // stripped. Before the central fix, the old client-side lensFor would
    // have already committed to 'applied' the moment a value was SENT.
    overrideDispatch('CS-09', {
      ok: true,
      id: 'CS-09',
      rows: [{ x: 1 }],
      rowCount: 1,
      durationMs: 5,
      usedDispatch: 'named',
      displaySql: '-- CS-09',
      boundParams: {},
      revision: 'r1',
      appliedParams: ['seller_ids'],
    });

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.label_lens!.dropped).toEqual(['CS-09']);
    expect(result.label_lens!.applied).not.toContain('CS-09');
    expect(result.label_lens!.applied).toContain('CS-11');
    expect(result.lens_warnings.join('\n')).toContain('DROPPED');
  });

  it('UNVERIFIED: applied_params is ABSENT entirely (older gateway) -> not proven, never applied', async () => {
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);
    overrideDispatch('CS-09', {
      ok: true,
      id: 'CS-09',
      rows: [{ x: 1 }],
      rowCount: 1,
      durationMs: 5,
      usedDispatch: 'named',
      displaySql: '-- CS-09',
      boundParams: {},
      revision: 'r1',
      // No appliedParams key at all.
    });

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.label_lens!.unverified).toEqual(['CS-09']);
    expect(result.label_lens!.applied).not.toContain('CS-09');
    expect(result.lens_warnings.join('\n')).toContain('UNVERIFIED');
  });

  it("query_failed: a failed label-aware query never resolves to 'applied'", async () => {
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);
    overrideDispatch('CS-09', {
      ok: false,
      id: 'CS-09',
      usedDispatch: 'named',
      failure: {
        ok: false,
        kind: 'unknown',
        message: 'boom',
        friendly: 'boom',
      },
    });

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.label_lens!.query_failed).toEqual(['CS-09']);
    expect(result.label_lens!.applied).not.toContain('CS-09');
    const cs09Result = result.queries.find((q) => q.id === 'CS-09');
    expect(cs09Result?.status).toBe('failed');
  });

  // F7/F9: the zero-row-under-lens warning previously existed ONLY in the
  // brain fetch, covering 3 of 7 mapped queries. CS-09/11/12/13 run in THIS
  // path (prefetch) and had no equivalent check at all.
  it('F7/F9: warns LOUDLY when a CONFIRMED-applied prefetch query matches zero rows', async () => {
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);
    overrideDispatch('CS-09', {
      ok: true,
      id: 'CS-09',
      rows: [],
      rowCount: 0,
      durationMs: 5,
      usedDispatch: 'named',
      displaySql: '-- CS-09',
      boundParams: {},
      revision: 'r1',
      appliedParams: ['retail_brand_label', 'seller_ids'],
    });

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.label_lens!.applied).toContain('CS-09');
    expect(result.lens_warnings.join('\n')).toContain('matched ZERO rows');
    expect(result.lens_warnings.join('\n')).toContain('CS-09');
  });

  it('F7/F9: does NOT claim a zero-row match for a DROPPED (not confirmed-applied) query', async () => {
    // Isolate to CS-09 only, so a different query's (CS-11's) own zero-row
    // default mock result can't be mistaken for evidence about this one.
    resolveBatchPlanMock.mockReturnValue([{ parallel: ['CS-09'] }] as never);
    loadBrandContextMock.mockResolvedValue({
      context: { ...BASE_CONTEXT, binding: BINDING },
    } as never);
    overrideDispatch('CS-09', {
      ok: true,
      id: 'CS-09',
      rows: [],
      rowCount: 0,
      durationMs: 5,
      usedDispatch: 'named',
      displaySql: '-- CS-09',
      boundParams: {},
      revision: 'r1',
      appliedParams: ['seller_ids'], // dropped, not applied
    });

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.label_lens!.dropped).toContain('CS-09');
    expect(result.lens_warnings.join('\n')).not.toContain('matched ZERO rows');
  });

  it('unbound brand: lens_warnings is empty (no lens, nothing to warn about)', async () => {
    loadBrandContextMock.mockResolvedValue({ context: BASE_CONTEXT } as never);

    const result = await runPrefetch({
      skill: 'mx-brand-context',
      brand: 'foragers-pantry',
      runDate: '2026-08-13',
    });

    expect(result.lens_warnings).toEqual([]);
  });
});
