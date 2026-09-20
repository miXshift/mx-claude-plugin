/**
 * Command-level tests for the `mixshift amazon call` FAILURE telemetry payload.
 *
 * The pin that matters is a privacy invariant, not a feature: the failure event
 * records which parameters the caller supplied by NAME, and must never record
 * their VALUES. Values on this surface are seller-level business data (SKUs,
 * ASINs, order ids, marketplace ids), which is exactly what the telemetry
 * module's own rule in events.ts refuses to send.
 *
 * Without a test, the difference between `Object.keys(input.query)` and
 * `input.query` is one word, reads as a simplification, and would start
 * shipping customer data to our telemetry store silently. See mx-ops#70.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerAmazonSpApiCommands } from './amazon-spapi.js';
import { spapiCall } from '../lib/amazon/spapi-call.js';
import { track } from '../lib/telemetry/index.js';

vi.mock('../lib/amazon/spapi-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/spapi-call.js')>();
  return { ...actual, spapiCall: vi.fn(), listSpApiOperations: vi.fn() };
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
  const amazon = program.command('amazon');
  registerAmazonSpApiCommands(amazon);
  return program;
}

async function runAmazon(...args: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(['node', 'mixshift', 'amazon', ...args]);
  } catch {
    // commander's exitOverride throws on a non-zero exit; the failure path under
    // test sets process.exitCode and that is not what these assertions are about.
  }
}

/** The one real 400 shape from the field: Amazon rejected it and sent no code. */
const BAD_REQUEST = {
  ok: false as const,
  kind: 'bad_request' as const,
  friendly: 'Amazon rejected this SP-API request (HTTP 400): ShipmentStatusList is required.',
  message: 'ShipmentStatusList is required',
  httpStatus: 400,
  amazonStatus: 400,
};

let exitCodeBefore: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
});

function lastFailurePayload(): Record<string, unknown> {
  const calls = vi.mocked(track).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const arg = calls[calls.length - 1]![0] as unknown as Record<string, unknown>;
  return (arg.payload ?? arg) as Record<string, unknown>;
}

describe('amazon call: failure telemetry records parameter NAMES, never values', () => {
  it('stamps query_keys and path_keys, sorted, on a rejected call', async () => {
    vi.mocked(spapiCall).mockResolvedValue(BAD_REQUEST as never);

    await runAmazon(
      'call',
      'listings.get_listings_item',
      '--query',
      'marketplaceIds=ATVPDKIKX0DER',
      '--query',
      'includedData=summaries',
      '--path',
      'sku=ACME-BLUE-42',
    );

    const payload = lastFailurePayload();
    expect(payload.query_keys).toEqual(['includedData', 'marketplaceIds']);
    expect(payload.path_keys).toEqual(['sku']);
  });

  it('NEVER puts a parameter value in the payload', async () => {
    vi.mocked(spapiCall).mockResolvedValue(BAD_REQUEST as never);

    await runAmazon(
      'call',
      'listings.get_listings_item',
      '--query',
      'marketplaceIds=ATVPDKIKX0DER',
      '--path',
      'sku=ACME-BLUE-42',
    );

    // The whole point. Serialise the payload and assert the seller-level values
    // appear nowhere in it, however the shape changes in future.
    const serialised = JSON.stringify(lastFailurePayload());
    expect(serialised).not.toContain('ACME-BLUE-42');
    expect(serialised).not.toContain('ATVPDKIKX0DER');
    expect(serialised).toContain('sku');
    expect(serialised).toContain('marketplaceIds');
  });

  it('omits both keys entirely when the caller supplied no parameters', async () => {
    vi.mocked(spapiCall).mockResolvedValue(BAD_REQUEST as never);

    await runAmazon('call', 'sellers.get_marketplace_participations');

    const payload = lastFailurePayload();
    expect(payload).not.toHaveProperty('query_keys');
    expect(payload).not.toHaveProperty('path_keys');
  });
});
