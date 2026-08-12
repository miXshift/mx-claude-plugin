/**
 * Command-level tests for `mixshift brand discover --seller-id` (FINDING 1,
 * red team over PR #131): fail-loud contract on the JSON `status`, exit
 * code, classification override, and --emit-stake skip. The underlying
 * discovery/stake network calls are mocked; these tests exercise
 * `runSubbrandDiscovery` end to end and assert on stdout/exitCode, not on
 * a library return value — same rationale as commands/brand-config.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Command } from 'commander';

// Telemetry and the timeline client are fire-and-forget/network; stub both
// so these tests stay local and offline.
vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../lib/binding/discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/binding/discovery.js')>();
  return { ...actual, fetchLabelDiscovery: vi.fn() };
});

vi.mock('../lib/binding/stake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/binding/stake.js')>();
  return { ...actual, emitCoverageStake: vi.fn() };
});

import { runSubbrandDiscovery } from './brand-subbrand-discover.js';
import { fetchLabelDiscovery } from '../lib/binding/discovery.js';
import { emitCoverageStake } from '../lib/binding/stake.js';
import type { LabelDiscoveryFetchResult } from '../lib/binding/discovery.js';
import type { EmitCoverageStakeResult } from '../lib/binding/stake.js';

const mockedFetch = fetchLabelDiscovery as unknown as ReturnType<typeof vi.fn>;
const mockedEmitStake = emitCoverageStake as unknown as ReturnType<typeof vi.fn>;

function stubCommand(opts: { json?: boolean; dataDir?: string }): Command {
  return { optsWithGlobals: () => opts } as unknown as Command;
}

const OK_ROW_FIXTURE: LabelDiscoveryFetchResult = {
  ok: true,
  resolvedSellerIds: [123],
  retailRows: [
    { SellerID: 123, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
    { SellerID: 123, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
  ],
  vendorRows: [],
  adsRows: [
    { SellerID: 123, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 10 },
  ],
  matchRows: [
    { label: 'Forager Pantry', retail_asins: 40, ads_campaigns: 10, has_retail: true, has_ads: true },
  ],
  errors: [],
};

const SELLER_RESOLUTION_FAILED_FIXTURE: LabelDiscoveryFetchResult = {
  ok: false,
  resolvedSellerIds: [],
  retailRows: [],
  vendorRows: [],
  adsRows: [],
  matchRows: [],
  errors: [
    {
      query_id: 'resolve_seller_ids',
      message: 'no match',
      friendly: 'No seller found for Amazon Seller ID "A1EXAMPLE23456" in this tenant\'s warehouse access.',
    },
  ],
};

const ALL_QUERIES_FAILED_FIXTURE: LabelDiscoveryFetchResult = {
  ok: false,
  resolvedSellerIds: [123],
  retailRows: [],
  vendorRows: [],
  adsRows: [],
  matchRows: [],
  errors: [
    { query_id: 'sbd-01', message: 'x', friendly: 'unknown query' },
    { query_id: 'sbd-02', message: 'x', friendly: 'unknown query' },
    { query_id: 'sbd-03', message: 'x', friendly: 'unknown query' },
    { query_id: 'sbd-04', message: 'x', friendly: 'unknown query' },
  ],
};

const PARTIAL_FAILURE_FIXTURE: LabelDiscoveryFetchResult = {
  ok: false,
  resolvedSellerIds: [123],
  retailRows: [
    { SellerID: 123, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
    { SellerID: 123, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 25, row_count: 25 },
  ],
  vendorRows: [],
  adsRows: [],
  matchRows: [],
  errors: [{ query_id: 'sbd-02', message: 'x', friendly: 'unknown query' }],
};

let stdout: string;
let priorExitCode: typeof process.exitCode;

function emitted(): Record<string, unknown> {
  const start = stdout.indexOf('{');
  expect(start, `no JSON in stdout: ${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

beforeEach(() => {
  stdout = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  mockedFetch.mockReset();
  mockedEmitStake.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
});

describe('status/exit-code contract (FINDING 1a/1b)', () => {
  it('status is "ok" and exitCode stays unset when fetched.ok is true', async () => {
    mockedFetch.mockResolvedValue(OK_ROW_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    expect(emitted().status).toBe('ok');
    expect(process.exitCode).toBeUndefined();
  });

  it('status is "error" and exitCode is 1 when seller-id resolution fails', async () => {
    mockedFetch.mockResolvedValue(SELLER_RESOLUTION_FAILED_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    expect(emitted().status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('status is "error" and exitCode is 1 when ALL four sbd-* queries fail', async () => {
    mockedFetch.mockResolvedValue(ALL_QUERIES_FAILED_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    expect(emitted().status).toBe('error');
    expect(process.exitCode).toBe(1);
  });

  it('status is "partial" and exitCode stays unset when SOME (not all) queries fail', async () => {
    mockedFetch.mockResolvedValue(PARTIAL_FAILURE_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    expect(emitted().status).toBe('partial');
    expect(process.exitCode).toBeUndefined();
  });

  it('never reports "ok" when fetched.ok is false, even in human (non-JSON) mode', async () => {
    mockedFetch.mockResolvedValue(ALL_QUERIES_FAILED_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: false }));
    expect(stdout).toContain('FAILED');
    expect(process.exitCode).toBe(1);
  });
});

describe('classification override on total failure (FINDING 1c)', () => {
  it('proposal is null (never a heuristic single_brand) when seller resolution fails', async () => {
    mockedFetch.mockResolvedValue(SELLER_RESOLUTION_FAILED_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    const out = emitted();
    const report = out.report as { classification: { proposal: unknown; evidence: string[] } };
    expect(report.classification.proposal).toBeNull();
    expect(report.classification.evidence.join(' ')).toContain('A1EXAMPLE23456');
  });

  it('proposal is null when all four queries fail', async () => {
    mockedFetch.mockResolvedValue(ALL_QUERIES_FAILED_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    const out = emitted();
    const report = out.report as { classification: { proposal: unknown } };
    expect(report.classification.proposal).toBeNull();
  });

  it('a partial failure keeps a REAL classification built from whatever succeeded', async () => {
    mockedFetch.mockResolvedValue(PARTIAL_FAILURE_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    const out = emitted();
    const report = out.report as { classification: { proposal: unknown } };
    // Two real, substantial retail labels came back even though ads failed —
    // the report is incomplete, not fabricated, so classification proceeds.
    expect(report.classification.proposal).toBe('brand_nested_candidate');
  });
});

describe('--emit-stake is skipped, loudly, unless fetched.ok (FINDING 1d)', () => {
  it('calls emitCoverageStake when the fetch fully succeeded', async () => {
    mockedFetch.mockResolvedValue(OK_ROW_FIXTURE);
    const stakeResult: EmitCoverageStakeResult = {
      ok: true,
      outcome: 'created',
      event_id: 'evt-1',
      brand_slug: 'acct-a1example23456',
    };
    mockedEmitStake.mockResolvedValue(stakeResult);
    await runSubbrandDiscovery(
      { sellerId: 'A1EXAMPLE23456', emitStake: true },
      stubCommand({ json: true }),
    );
    expect(mockedEmitStake).toHaveBeenCalledTimes(1);
    expect((emitted().stake as { outcome: string }).outcome).toBe('created');
  });

  it('does NOT call emitCoverageStake on a total failure, and says so loudly', async () => {
    mockedFetch.mockResolvedValue(SELLER_RESOLUTION_FAILED_FIXTURE);
    await runSubbrandDiscovery(
      { sellerId: 'A1EXAMPLE23456', emitStake: true },
      stubCommand({ json: true }),
    );
    expect(mockedEmitStake).not.toHaveBeenCalled();
    const out = emitted();
    expect(out.stake_skipped).toBe(true);
    expect(typeof out.stake_skip_reason).toBe('string');
  });

  it('does NOT call emitCoverageStake on a PARTIAL failure either', async () => {
    mockedFetch.mockResolvedValue(PARTIAL_FAILURE_FIXTURE);
    await runSubbrandDiscovery(
      { sellerId: 'A1EXAMPLE23456', emitStake: true },
      stubCommand({ json: true }),
    );
    expect(mockedEmitStake).not.toHaveBeenCalled();
    expect(emitted().stake_skipped).toBe(true);
  });

  it('the skip message surfaces in human-readable output too', async () => {
    mockedFetch.mockResolvedValue(ALL_QUERIES_FAILED_FIXTURE);
    await runSubbrandDiscovery(
      { sellerId: 'A1EXAMPLE23456', emitStake: true },
      stubCommand({ json: false }),
    );
    expect(mockedEmitStake).not.toHaveBeenCalled();
    expect(stdout).toContain('Skipped --emit-stake');
  });

  it('never calls emitCoverageStake when --emit-stake was not passed at all', async () => {
    mockedFetch.mockResolvedValue(OK_ROW_FIXTURE);
    await runSubbrandDiscovery({ sellerId: 'A1EXAMPLE23456' }, stubCommand({ json: true }));
    expect(mockedEmitStake).not.toHaveBeenCalled();
  });
});
