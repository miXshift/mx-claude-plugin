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
  errors: [],
};

const ALL_FAILED_FIXTURE: LabelDiscoveryFetchResult = {
  ok: false,
  resolvedSellerIds: [],
  retailRows: [],
  vendorRows: [],
  adsRows: [],
  matchRows: [],
  errors: [{ query_id: 'resolve_seller_ids', message: 'no match', friendly: 'No seller found.' }],
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
