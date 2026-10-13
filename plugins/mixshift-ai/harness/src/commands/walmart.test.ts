/**
 * Command-level tests for `mixshift walmart ads ...`: the flag-to-wire
 * mapping (only --commit sends dryRun:false), the --json shapes the skill
 * reads, exit codes, and telemetry that names the operation and advertiser
 * but never carries the payload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerWalmartCommands, renderAdvertisers } from './walmart.js';
import { listWalmartAdvertisers, walmartAdsCall } from '../lib/walmart/ads-call.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/walmart/ads-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/walmart/ads-call.js')>();
  return {
    ...actual,
    walmartAdsCall: vi.fn(),
    listWalmartAdvertisers: vi.fn(),
    listWalmartOperations: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerWalmartCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

let stdout = '';
beforeEach(() => {
  stdout = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(walmartAdsCall).mockReset();
  vi.mocked(listWalmartAdvertisers).mockReset();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
});

const lastTrack = () => vi.mocked(track).mock.calls.at(-1)![0] as {
  event_name: string;
  outcome: string;
  payload: Record<string, unknown>;
};

describe('walmart ads call', () => {
  it('a read sends no dryRun, prints the --json shape, and tracks operation + advertiser without the payload', async () => {
    vi.mocked(walmartAdsCall).mockResolvedValueOnce({
      ok: true,
      operation: 'ss.list_campaigns',
      environment: 'production',
      advertiserId: '1000001',
      status: 200,
      payload: [{ campaignId: 1, name: 'secret campaign name' }],
    });
    await run('--json', 'walmart', 'ads', 'call', 'ss.list_campaigns', '--advertiser-id', '1000001');

    expect(vi.mocked(walmartAdsCall).mock.calls[0][0]).toEqual({
      operation: 'ss.list_campaigns',
      advertiserId: '1000001',
      query: {},
    });
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ status: 'ok', operation: 'ss.list_campaigns', advertiserId: '1000001', environment: 'production' });
    expect(out).not.toHaveProperty('ok');
    expect(out.walmart_status).toBe(200);
    expect(process.exitCode).toBeUndefined();

    const t = lastTrack();
    expect(t.event_name).toBe('walmart.ads.called');
    expect(t.outcome).toBe('ok');
    expect(t.payload).toMatchObject({ operation: 'ss.list_campaigns', advertiser_id: '1000001', environment: 'production', walmart_status: 200 });
    expect(JSON.stringify(t.payload)).not.toContain('secret campaign name');
  });

  it('only --commit sends dryRun:false', async () => {
    vi.mocked(walmartAdsCall).mockResolvedValue({
      ok: true,
      operation: 'ss.update_campaigns',
      environment: 'sandbox',
      advertiserId: '1000001',
      dryRun: true,
      preview: {},
    });
    await run('walmart', 'ads', 'call', 'ss.update_campaigns', '--advertiser-id', '1000001', '--body', '[]');
    expect(vi.mocked(walmartAdsCall).mock.calls[0][0]).not.toHaveProperty('dryRun');
    expect(lastTrack().payload).toMatchObject({ dry_run: true });

    await run('walmart', 'ads', 'call', 'ss.update_campaigns', '--advertiser-id', '1000001', '--body', '[]', '--commit');
    expect(vi.mocked(walmartAdsCall).mock.calls[1][0]).toMatchObject({ dryRun: false, body: [] });
  });

  it('passes repeated --query params through (limit, groupBy on downloads)', async () => {
    vi.mocked(walmartAdsCall).mockResolvedValueOnce({
      ok: true,
      operation: 'ss.download_report',
      environment: 'production',
      advertiserId: '1000001',
      ready: false,
      message: 'Walmart is still building this file.',
    });
    await run(
      '--json', 'walmart', 'ads', 'call', 'ss.download_report', '--advertiser-id', '1000001',
      '--query', 'snapshotId=42', '--query', 'groupBy=campaignId',
    );
    expect(vi.mocked(walmartAdsCall).mock.calls[0][0].query).toEqual({ snapshotId: '42', groupBy: 'campaignId' });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', ready: false });
    expect(lastTrack().payload).toMatchObject({ ready: false });
  });

  it('refuses a call with no --advertiser-id before any request', async () => {
    await run('--json', 'walmart', 'ads', 'call', 'ss.list_campaigns');
    expect(walmartAdsCall).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({ status: 'error' });
    expect(process.exitCode).toBe(1);
  });

  it('a failure prints the typed kind, sets the exit code, and tracks query KEYS only', async () => {
    vi.mocked(walmartAdsCall).mockResolvedValueOnce({
      ok: false,
      kind: 'advertiser_not_allowed',
      friendly: 'That Walmart advertiser is not connected to this MixShift account.',
      advertiserId: '999',
      httpStatus: 403,
    });
    await run('--json', 'walmart', 'ads', 'call', 'ss.list_campaigns', '--advertiser-id', '999', '--query', 'filter=private-value');
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'error',
      failure_kind: 'advertiser_not_allowed',
      advertiser_id: '999',
      http_status: 403,
    });
    expect(process.exitCode).toBe(7);
    const t = lastTrack();
    expect(t.outcome).toBe('failed');
    expect(t.payload).toMatchObject({ kind: 'advertiser_not_allowed', advertiser_id: '999', query_keys: ['filter'] });
    expect(JSON.stringify(t.payload)).not.toContain('private-value');
  });
});

describe('walmart ads advertisers', () => {
  it('lists advertisers as JSON and tracks ids + link attributes', async () => {
    vi.mocked(listWalmartAdvertisers).mockResolvedValueOnce({
      ok: true,
      advertisers: [{ label: 'acme', advertiserId: '1000001', api: 'sponsored_search', environment: 'production', access: 'read' }],
    });
    await run('--json', 'walmart', 'ads', 'advertisers');
    expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', count: 1 });
    expect(lastTrack()).toMatchObject({
      event_name: 'walmart.ads.advertisers_listed',
      payload: { count: 1, sample: [{ advertiser_id: '1000001', environment: 'production', access: 'read' }] },
    });
  });

  it('tenant_not_allowed exits 6', async () => {
    vi.mocked(listWalmartAdvertisers).mockResolvedValueOnce({
      ok: false,
      kind: 'tenant_not_allowed',
      friendly: 'Walmart Connect is not enabled for this MixShift account yet.',
      httpStatus: 403,
    });
    await run('walmart', 'ads', 'advertisers');
    expect(process.exitCode).toBe(6);
  });

  it('renders a read link as read only and names the ad type', () => {
    const md = renderAdvertisers([
      { label: 'acme', advertiserId: '1000001', api: 'sponsored_search', environment: 'production', access: 'read' },
    ]);
    expect(md).toContain('| acme | 1000001 | Sponsored Search | production | read only |');
  });
});
