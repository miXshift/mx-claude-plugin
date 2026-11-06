/**
 * Command-level tests for `mixshift walmart marketplace ...`: flag-to-wire
 * mapping, the --json shapes the skill reads, exit codes, and telemetry that
 * names the operation and seller but never carries the payload.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerWalmartCommands } from './walmart.js';
import { parseJsonObject, renderSellers } from './walmart-marketplace.js';
import { listMarketplaceSellers, marketplaceCall } from '../lib/walmart/marketplace-call.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/walmart/marketplace-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/walmart/marketplace-call.js')>();
  return {
    ...actual,
    marketplaceCall: vi.fn(),
    listMarketplaceSellers: vi.fn(),
    listMarketplaceOperations: vi.fn(),
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
  program.option('--json', 'emit machine-readable JSON to stdout', false).option('--data-dir <path>', 'override');
  registerWalmartCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

let stdout = '';
let stderr = '';
beforeEach(() => {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(marketplaceCall).mockReset();
  vi.mocked(listMarketplaceSellers).mockReset();
  vi.mocked(track).mockClear();
  process.exitCode = undefined;
});

const lastTrack = () =>
  vi.mocked(track).mock.calls.at(-1)![0] as { event_name: string; outcome: string; payload: Record<string, unknown> };

describe('walmart marketplace call', () => {
  it('passes seller, environment and query through and keeps Walmart status as walmart_status', async () => {
    vi.mocked(marketplaceCall).mockResolvedValueOnce({
      ok: true,
      operation: 'mp.sku_snapshot',
      sellerId: '1234567890',
      environment: 'production',
      status: 200,
      payload: { skus: [{ sku: 'ABC-1' }], complete: true },
    });
    await run(
      '--json', 'walmart', 'marketplace', 'call', 'mp.sku_snapshot',
      '--seller', '1234567890', '--environment', 'production', '--query', '{"sku":"ABC-1"}',
    );
    const input = vi.mocked(marketplaceCall).mock.calls[0][0];
    expect(input).toEqual({
      operation: 'mp.sku_snapshot',
      sellerId: '1234567890',
      environment: 'production',
      query: { sku: 'ABC-1' },
    });
    const out = JSON.parse(stdout);
    expect(out.status).toBe('ok');
    expect(out.walmart_status).toBe(200);
    expect(out.payload.complete).toBe(true);
    const t = lastTrack();
    expect(t.event_name).toBe('walmart.marketplace.called');
    expect(JSON.stringify(t.payload)).not.toMatch(/ABC-1/);
  });

  it('requires --seller', async () => {
    await run('--json', 'walmart', 'marketplace', 'call', 'mp.list_orders');
    expect(marketplaceCall).not.toHaveBeenCalled();
    expect(JSON.parse(stdout).message).toMatch(/--seller is required/);
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-object --query and a bad --environment before any call', async () => {
    await run('--json', 'walmart', 'marketplace', 'call', 'x', '--seller', '1', '--query', '[1]');
    expect(JSON.parse(stdout).message).toMatch(/JSON object/);
    stdout = '';
    await run('--json', 'walmart', 'marketplace', 'call', 'x', '--seller', '1', '--environment', 'prod');
    expect(JSON.parse(stdout).message).toMatch(/sandbox or production/);
    expect(marketplaceCall).not.toHaveBeenCalled();
  });

  it('has no --commit flag: writes cannot be applied from the plugin', async () => {
    await expect(
      run('walmart', 'marketplace', 'call', 'mp.update_price', '--seller', '1', '--commit'),
    ).rejects.toThrow();
    expect(marketplaceCall).not.toHaveBeenCalled();
  });

  it('emits a typed failure with the right exit code', async () => {
    vi.mocked(marketplaceCall).mockResolvedValueOnce({
      ok: false,
      kind: 'write_refused',
      friendly: 'Make this change in the MixShift app.',
      sellerId: '1234567890',
    });
    await run('--json', 'walmart', 'marketplace', 'call', 'mp.update_price', '--seller', '1234567890');
    const out = JSON.parse(stdout);
    expect(out.status).toBe('error');
    expect(out.failure_kind).toBe('write_refused');
    expect(process.exitCode).toBe(11);
    expect(lastTrack().outcome).toBe('failed');
  });

  it('carries walmart_status on a refused read', async () => {
    vi.mocked(marketplaceCall).mockResolvedValueOnce({
      ok: false,
      kind: 'upstream_auth',
      friendly: 'Walmart refused this one read.',
      walmartStatus: 403,
    });
    await run('--json', 'walmart', 'marketplace', 'call', 'mp.list_orders', '--seller', '1234567890');
    const out = JSON.parse(stdout);
    expect(out.walmart_status).toBe(403);
    expect(process.exitCode).toBe(14);
  });

  it('sends unknown_operation to telemetry when the catalog did not know the id', async () => {
    vi.mocked(marketplaceCall).mockResolvedValueOnce({
      ok: false,
      kind: 'invalid_request',
      friendly: 'x',
      operationKnown: false,
    });
    await run('--json', 'walmart', 'marketplace', 'call', 'my private note', '--seller', '1234567890');
    expect(lastTrack().payload.operation).toBe('unknown_operation');
    vi.mocked(marketplaceCall).mockResolvedValueOnce({ ok: false, kind: 'seller_not_allowed', friendly: 'x', operationKnown: true });
    await run('--json', 'walmart', 'marketplace', 'call', 'mp.list_orders', '--seller', '1234567890');
    expect(lastTrack().payload.operation).toBe('mp.list_orders');
  });

  it('carries the gateway reason in --json', async () => {
    vi.mocked(marketplaceCall).mockResolvedValueOnce({
      ok: false,
      kind: 'upstream_auth',
      friendly: 'Reconnect.',
      walmartStatus: 400,
      reason: 'reauth_required',
    });
    await run('--json', 'walmart', 'marketplace', 'call', 'mp.list_orders', '--seller', '1234567890');
    expect(JSON.parse(stdout).reason).toBe('reauth_required');
  });
});

describe('walmart marketplace sellers', () => {
  it('lists sellers as JSON and records ids without labels', async () => {
    vi.mocked(listMarketplaceSellers).mockResolvedValueOnce({
      ok: true,
      sellers: [{ sellerId: '1234567890', environment: 'sandbox', label: 'acme', scopes: ['marketplace:read'] }],
    });
    await run('--json', 'walmart', 'marketplace', 'sellers');
    const out = JSON.parse(stdout);
    expect(out.count).toBe(1);
    expect(out.sellers[0].sellerId).toBe('1234567890');
    expect(lastTrack().event_name).toBe('walmart.marketplace.sellers_listed');
    expect(JSON.stringify(lastTrack().payload)).not.toMatch(/acme/);
  });

  it('flags a seller that must reconnect in the human table', () => {
    const out = renderSellers([
      { sellerId: '1', environment: 'production', label: 'acme', reconnectRequired: true },
      { sellerId: '2', environment: 'production', label: 'beta', connectionExpiresAt: '2026-12-01' },
    ]);
    expect(out).toMatch(/RECONNECT NEEDED: https:\/\/mcp\.mixshift\.io\/walmart\/marketplace\/connect/);
    expect(out).toMatch(/connection expires 2026-12-01/);
  });

  it('renders a table, and an empty state', () => {
    expect(renderSellers([])).toMatch(/no Walmart Marketplace sellers/);
    expect(renderSellers([{ sellerId: '1', environment: 'production', label: 'acme', scopes: ['a', 'b'] }])).toMatch(
      /\| acme \| 1 \| production \| a, b \|/,
    );
  });
});

describe('parseJsonObject', () => {
  it('parses objects and rejects everything else', () => {
    expect(parseJsonObject('--query', undefined)).toBeUndefined();
    expect(parseJsonObject('--query', '{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonObject('--query', 'nope')).toThrow(/JSON object/);
    expect(() => parseJsonObject('--query', 'null')).toThrow(/JSON object/);
  });
});
