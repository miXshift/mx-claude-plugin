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

function okDispatch() {
  runDispatchedMock.mockImplementation(async (id: string) => ({
    ok: true as const,
    id,
    rows: [],
    rowCount: 0,
    durationMs: 5,
    usedDispatch: 'named' as const,
    displaySql: `-- ${id}`,
    boundParams: {},
    revision: 'r1',
  }) as never);
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
      applied: expect.arrayContaining(['CS-09', 'CS-11']),
      account_wide: ['CS-02'],
      missing_label_value: [],
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
});
