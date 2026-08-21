/**
 * Command-level tests for `mixshift brand promote --apply` and `mixshift
 * brand demote --apply` — mirrors commands/brand-config.test.ts's own
 * rationale: a lib-level test (lib/binding/promote.test.ts,
 * lib/binding/demote.test.ts) can pass while the CLI's own JSON.parse
 * wrapping, telemetry glue, or exit-code plumbing still breaks the user-
 * visible contract. These tests exercise the REGISTERED commands end to
 * end via commander's parseAsync and assert on the emitted JSON + exit
 * code, not on a library return value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../lib/binding/discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/binding/discovery.js')>();
  return { ...actual, fetchLabelDiscovery: vi.fn() };
});

vi.mock('../lib/discovery/seller-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/discovery/seller-query.js')>();
  return { ...actual, discoverSellers: vi.fn() };
});

vi.mock('../lib/binding/stake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/binding/stake.js')>();
  return { ...actual, emitCoverageStake: vi.fn().mockResolvedValue({ ok: true, outcome: 'created', event_id: 'evt-1', brand_slug: 'acct-a1example23456' }) };
});

import { registerBrandPromoteCommands } from './brand-promote.js';
import { fetchLabelDiscovery, type LabelDiscoveryFetchResult } from '../lib/binding/discovery.js';
import { discoverSellers } from '../lib/discovery/seller-query.js';

const mockedFetch = fetchLabelDiscovery as unknown as ReturnType<typeof vi.fn>;
const mockedDiscoverSellers = discoverSellers as unknown as ReturnType<typeof vi.fn>;

const SELLER_ID = 'A1EXAMPLE23456';

const OK_FIXTURE: LabelDiscoveryFetchResult = {
  ok: true,
  resolvedSellerIds: [1],
  retailRows: [
    { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 70, row_count: 70 },
    { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 30, row_count: 30 },
  ],
  vendorRows: [],
  adsRows: [{ SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 5 }],
  matchRows: [
    { label: 'Forager Pantry', retail_asins: 70, ads_campaigns: 5, has_retail: true, has_ads: true },
  ],
  retailEconRows: [],
  adsEconRows: [],
  vendorEconRows: [],
  errors: [],
};

const ALL_FAILED_FIXTURE: LabelDiscoveryFetchResult = {
  ok: false,
  resolvedSellerIds: [],
  retailRows: [],
  vendorRows: [],
  adsRows: [],
  matchRows: [],
  retailEconRows: [],
  adsEconRows: [],
  vendorEconRows: [],
  errors: [{ query_id: 'resolve_seller_ids', message: 'no match', friendly: 'No seller found.' }],
};

/** ONE of the four sbd-* queries dropped on the wire (host_unreachable),
 *  the other three fine. Mirrors a real reported run exactly:
 *  retail complete and identical to a good run, ads empty with an error
 *  recorded. `ok: false` because rowsOf() pushed the error — the whole
 *  point is that classifyFetchOutcome must read this as 'partial'. */
const ADS_DROPPED_FIXTURE: LabelDiscoveryFetchResult = {
  ...OK_FIXTURE,
  ok: false,
  adsRows: [],
  errors: [
    {
      query_id: 'sbd-02',
      message: 'fetch failed',
      friendly: 'The MixShift auth service is unreachable. Check your network or try again in a minute.',
    },
  ],
};

/** Run 1's shape: the match query dropped instead. Retail AND ads both
 *  look healthy, so nothing in the rendered plan hints at a problem. */
const MATCH_DROPPED_FIXTURE: LabelDiscoveryFetchResult = {
  ...OK_FIXTURE,
  ok: false,
  matchRows: [],
  errors: [
    {
      query_id: 'sbd-04',
      message: 'fetch failed',
      friendly: 'The MixShift auth service is unreachable. Check your network or try again in a minute.',
    },
  ],
};

const SELLER_ROW = {
  seller_id: 1,
  seller_name: 'Acme Agency',
  amazon_seller_id: SELLER_ID,
  merchant_alias: null,
  account_type: 'SC' as const,
  marketplace: 'United States',
  region: 'NA',
  agency_name: null,
  acos_target: null,
  ads_active: true,
  retail_active: true,
  is_active: true,
  has_mws: true,
};

let dataDir: string;
let stdout: string;
let priorExitCode: typeof process.exitCode;
let writeSpy: ReturnType<typeof vi.spyOn>;

function newProgram(): { program: Command; brandCmd: Command } {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'emit JSON', false);
  program.option('--data-dir <dir>', 'data dir override');
  const brandCmd = program.command('brand');
  registerBrandPromoteCommands(brandCmd);
  return { program, brandCmd };
}

async function runPromote(args: string[]): Promise<void> {
  const { program } = newProgram();
  try {
    await program.parseAsync(['brand', 'promote', ...args, '--json', '--data-dir', dataDir], { from: 'user' });
  } catch {
    // exitOverride throws on non-zero exit; assertions read exitCode/stdout instead
  }
}

/** Same, but WITHOUT --json, so the human renderer actually runs. The plan
 *  text is what an operator reads and decides on; asserting only the JSON
 *  leaves every rendered sentence untested. */
async function runPromoteHuman(args: string[]): Promise<void> {
  const { program } = newProgram();
  try {
    await program.parseAsync(['brand', 'promote', ...args, '--data-dir', dataDir], { from: 'user' });
  } catch {
    // see above
  }
}

async function runDemote(slug: string, args: string[]): Promise<void> {
  const { program } = newProgram();
  try {
    await program.parseAsync(['brand', 'demote', slug, ...args, '--json', '--data-dir', dataDir], { from: 'user' });
  } catch {
    // see above
  }
}

function emitted(): Record<string, unknown> {
  const start = stdout.indexOf('{');
  expect(start, `no JSON in stdout: ${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-brandpromote-'));
  await mkdir(join(dataDir, 'clients'), { recursive: true });
  stdout = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  mockedFetch.mockReset();
  mockedDiscoverSellers.mockReset();
  mockedDiscoverSellers.mockResolvedValue([SELLER_ROW]);
});

afterEach(async () => {
  writeSpy.mockRestore();
  process.exitCode = priorExitCode;
  await rm(dataDir, { recursive: true, force: true });
});

describe('brand promote — dry-run default', () => {
  it('never writes and reports mode dry_run when --apply is absent', async () => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID]);
    const out = emitted();
    expect(out.status).toBe('ok');
    expect(out.mode).toBe('dry_run');
    const plan = out.plan as { items: unknown[]; notice: string };
    expect(plan.items).toHaveLength(2);
    expect(plan.notice).toContain('proposal only');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails loud (never a fabricated plan) when discovery does not fully succeed', async () => {
    mockedFetch.mockResolvedValue(ALL_FAILED_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID]);
    const out = emitted();
    expect(out.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  // mx-ops#6: the reported failure was NOT every query
  // failing — it was ONE of the four dropping on the wire while the other
  // three succeeded, so `retailRows` was fully populated and only the ads
  // side came back empty. The pre-existing ALL_FAILED_FIXTURE case cannot
  // catch that: it fails seller-id resolution, which is a different branch
  // (classifyFetchOutcome -> 'error', not 'partial'). These two guard the
  // 'partial' branch on the side that actually broke.
  it('aborts when ONLY the ads query drops, even though retail is complete', async () => {
    mockedFetch.mockResolvedValue(ADS_DROPPED_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID]);
    const out = emitted();
    expect(out.status).toBe('error');
    expect(process.exitCode).toBe(1);
    // The specific regression: a dropped ads query must never render as a
    // confident "no campaigns yet" plan.
    expect(JSON.stringify(out)).not.toContain('would_create');
  });

  // Run 1 of the customer's two runs lost sbd-04 (the retail<->ads match
  // query) rather than sbd-02, and NOBODY NOTICED — an absent match row is
  // invisible in the rendered plan in a way an absent campaign count is not.
  // Which of the four drops is nondeterministic, so the guard has to hold
  // for the silent one too, not just the visible one.
  it('aborts when only the match query drops (the failure nobody can see)', async () => {
    mockedFetch.mockResolvedValue(MATCH_DROPPED_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID]);
    const out = emitted();
    expect(out.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  // mx-ops#6 red team round 2. The ads COVERAGE query counts only
  // enabled/paused campaigns; the ads ECONOMICS query deliberately does not
  // filter State, because money spent by a since-archived campaign was still
  // spent. So "has_ads false, spend > 0" is not an anomaly, it is the exact
  // shape of a wound-down brand — and printing "no campaigns yet" directly
  // under a non-zero spend figure told the operator the opposite of the truth.
  it('says the spend is historical, not "no campaigns yet", for a wound-down label', async () => {
    mockedFetch.mockResolvedValue({
      ...OK_FIXTURE,
      // 'Alpine Trail' carries real trailing spend but has no LIVE campaigns,
      // so it never appears in adsRows.
      adsEconRows: [
        {
          SellerID: 1, source: 'campaign.Brand', label: 'Alpine Trail',
          spend_365d: 44_000, spend_90d: 0, ad_sales_365d: 120_000,
          last_spend_at: '2025-12-02 00:00:00', campaigns_with_spend: 9,
        },
      ],
      retailEconRows: [
        {
          SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail',
          revenue_365d: 300_000, revenue_90d: 0, units_365d: 900,
          last_order_at: '2025-12-02 00:00:00', sku_count: 30,
        },
        {
          SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry',
          revenue_365d: 900_000, revenue_90d: 300_000, units_365d: 4_000,
          last_order_at: '2026-08-11 00:00:00', sku_count: 70,
        },
      ],
    });
    await runPromoteHuman(['--seller-id', SELLER_ID]);
    expect(stdout).toContain('the spend above is historical');
    expect(stdout).not.toContain('no campaigns yet');
  });

  // mx-ops#6 red team round 2, the coverage gap. An experimental probe
  // deleted the economics wiring five different ways and NOT ONE test in the
  // 2281-test suite failed — every command fixture passed empty econ arrays,
  // which is byte-identical to not passing economics at all. A skeptic
  // correctly noted those particular mutations are compile errors under
  // strict + noUnusedLocals and typecheck gates CI before tests, so they
  // cannot ship. Both are right, and what neither covers is a SEMANTIC
  // regression: wrong arrays wired to the right parameter names, a wire-shape
  // change the coercion silently zeroes, a gateway field rename. All
  // type-valid, all green, all of them turn the headline feature inert.
  //
  // This is the test that would go red.
  it('carries economics through the command layer and ranks the plan on dollars', async () => {
    mockedFetch.mockResolvedValue({
      ...OK_FIXTURE,
      // 'Alpine Trail' has 30 retail units to 'Forager Pantry''s 70, so item
      // count alone ranks it SECOND. In dollars it is worth ~9x more.
      retailEconRows: [
        {
          SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail',
          revenue_365d: 4_000_000, revenue_90d: 1_100_000, units_365d: 50_000,
          last_order_at: '2026-08-11 00:00:00', sku_count: 30,
        },
        {
          SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry',
          revenue_365d: 450_000, revenue_90d: 120_000, units_365d: 6_000,
          last_order_at: '2026-08-11 00:00:00', sku_count: 70,
        },
      ],
      adsEconRows: [
        {
          SellerID: 1, source: 'campaign.Brand', label: 'Alpine Trail',
          spend_365d: 600_000, spend_90d: 160_000, ad_sales_365d: 2_000_000,
          last_spend_at: '2026-08-11 00:00:00', campaigns_with_spend: 22,
        },
      ],
      vendorEconRows: [],
    });
    await runPromote(['--seller-id', SELLER_ID]);
    const plan = emitted().plan as {
      items: Array<{ label: string; economic_weight: number; revenue_365d: number; spend_365d: number }>;
    };
    // Ranked on revenue + spend, so the smaller catalog leads.
    expect(plan.items[0]!.label).toBe('Alpine Trail');
    expect(plan.items[0]!.economic_weight).toBe(4_600_000);
    expect(plan.items[0]!.revenue_365d).toBe(4_000_000);
    expect(plan.items[0]!.spend_365d).toBe(600_000);
    expect(plan.items[1]!.label).toBe('Forager Pantry');
    // If economics stopped reaching buildPromotionPlan, every weight would be
    // 0 and the order would fall back to catalog mass — both assertions above
    // fail, which is the whole point of this test.
    expect(plan.items[1]!.economic_weight).toBe(450_000);
  });

  it('does not claim every listed label cleared the meaningful-mass gate', async () => {
    // Candidacy is the UNION of catalog mass and economic share, so the list
    // deliberately includes labels that FAIL the mass gate. Asserting they all
    // passed it made `brand discover` and `brand promote` contradict each
    // other on the same account.
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromoteHuman(['--seller-id', SELLER_ID]);
    expect(stdout).not.toContain('above the meaningful-mass gate');
  });
});

describe('brand promote --apply — fail-closed contract', () => {
  it('rejects invalid JSON without crashing', async () => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID, '--apply', '{not valid json']);
    const out = emitted();
    expect(out.status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown action, exit 4, no write', async () => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID, '--apply', '{"action":"promote_labl","label":"Forager Pantry"}']);
    const out = emitted();
    expect(out.status).toBe('validation_failed');
    expect(out.did_write).toBe(false);
    expect(process.exitCode).toBe(4);
    const issues = out.validation_issues as Array<{ field: string; message: string }>;
    expect(issues[0]?.field).toBe('action');
  });

  it.each([
    ['a bare array', '[]'],
    ['null', 'null'],
    ['promote_label with a missing label', '{"action":"promote_label"}'],
    ['promote_label with a numeric label', '{"action":"promote_label","label":42}'],
  ])('rejects %s as a named validation failure, not a raw crash', async (_label, json) => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID, '--apply', json]);
    const out = emitted();
    expect(out.status).toBe('validation_failed');
    expect(out.did_write).toBe(false);
    expect(process.exitCode).toBe(4);
  });

  it('honors cancel with no write and a distinct status', async () => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID, '--apply', '{"action":"cancel"}']);
    const out = emitted();
    expect(out.status).toBe('cancelled');
    expect(out.did_write).toBe(false);
  });
});

describe('brand promote --apply — a well-formed promote_label writes exactly one sub-brand', () => {
  it('bootstraps the directory, writes the binding, and is idempotent on replay', async () => {
    mockedFetch.mockResolvedValue(OK_FIXTURE);
    await runPromote(['--seller-id', SELLER_ID, '--apply', '{"action":"promote_label","label":"Forager Pantry"}']);
    const out = emitted();
    expect(out.status).toBe('ok');
    expect(out.did_write).toBe(true);
    expect(out.slug).toBe('forager-pantry');

    const raw = await readFile(join(dataDir, 'clients', 'forager-pantry', 'context.yaml'), 'utf-8');
    expect(raw).toContain('kind: sub_brand');

    // Replay: idempotent, no second write, no error.
    stdout = '';
    await runPromote(['--seller-id', SELLER_ID, '--apply', '{"action":"promote_label","label":"Forager Pantry"}']);
    const second = emitted();
    expect(second.status).toBe('ok');
    expect(second.did_write).toBe(false);
  });
});

describe('brand demote — preview default', () => {
  it('never writes and reports is_sub_brand accurately', async () => {
    const dir = join(dataDir, 'clients', 'forager-pantry');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'context.yaml'),
      `
schema_version: 1
brand_slug: forager-pantry
brand_name: Forager Pantry
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Agency
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
  acos_target_pct: 20
  attribution_window_days: 14
binding:
  kind: sub_brand
  amazon_seller_id: ${SELLER_ID}
  retail_label:
    source: mws_items.Brand
    value: "Forager Pantry"
`,
      'utf-8',
    );
    await runDemote('forager-pantry', []);
    const out = emitted();
    expect(out.status).toBe('ok');
    expect(out.mode).toBe('preview');
    const preview = out.preview as { is_sub_brand: boolean };
    expect(preview.is_sub_brand).toBe(true);
    // Still there, untouched.
    await expect(readFile(join(dir, 'context.yaml'), 'utf-8')).resolves.toContain('binding:');
  });
});

describe('brand demote --apply', () => {
  it('reports not_a_sub_brand (exit 4, never an error) for a brand with no binding', async () => {
    const dir = join(dataDir, 'clients', 'acme');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'context.yaml'),
      `
schema_version: 1
brand_slug: acme
brand_name: Acme
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Agency
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
  acos_target_pct: 20
  attribution_window_days: 14
`,
      'utf-8',
    );
    await runDemote('acme', ['--apply']);
    const out = emitted();
    expect(out.status).toBe('not_a_sub_brand');
    expect(out.did_write).toBe(false);
    expect(process.exitCode).toBe(4);
  });
});
