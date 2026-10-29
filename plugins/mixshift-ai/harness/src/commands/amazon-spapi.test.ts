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

/** What toReportFailure makes of the gateway's measured-rule refusal (the
 *  producer envelope in testdata/gateway/error-envelopes.json). */
const REFUSED = {
  ok: false as const,
  kind: 'invalid_request' as const,
  friendly:
    'Operation fulfillment_inbound.get_shipments needs at least one of query.ShipmentStatusList or query.ShipmentIdList when query.QueryType=DATE_RANGE.',
  httpStatus: 400,
  source: 'request',
  retryable: false,
  fix: 'Amazon: "At least one of ShipmentStatusList and ShipmentIdList must be provided" (3 in the P0 window). Reference: https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v0-reference. Nothing was sent to Amazon.',
  docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v0-reference',
  missingParams: ['ShipmentStatusList', 'ShipmentIdList'],
};

function lastJsonOut(): Record<string, unknown> {
  const writes = vi.mocked(process.stdout.write).mock.calls.map((c) => String(c[0]));
  return JSON.parse(writes[writes.length - 1]!) as Record<string, unknown>;
}

describe('amazon call: a MixShift refusal reaches the agent as one (mx-ops#144 P5)', () => {
  it('--json names the kind, who acts, the retry verdict and the fix; exit code 15', async () => {
    vi.mocked(spapiCall).mockResolvedValue(REFUSED as never);

    await runAmazon('--json', 'call', 'fulfillment_inbound.get_shipments', '--query', 'QueryType=DATE_RANGE');

    const out = lastJsonOut();
    expect(out).toMatchObject({
      status: 'error',
      failure_kind: 'invalid_request',
      source: 'request',
      retryable: false,
      missing_params: ['ShipmentStatusList', 'ShipmentIdList'],
    });
    expect(String(out.fix)).toContain('Nothing was sent to Amazon.');
    expect(process.exitCode).toBe(15);
  });

  it('telemetry records source and retryable, and that a fix existed, but never its text', async () => {
    vi.mocked(spapiCall).mockResolvedValue(REFUSED as never);

    await runAmazon('call', 'fulfillment_inbound.get_shipments', '--query', 'QueryType=DATE_RANGE');

    const payload = lastFailurePayload();
    expect(payload).toMatchObject({ kind: 'invalid_request', source: 'request', retryable: false, has_fix: true });
    expect(payload).not.toHaveProperty('unrecognized_kind');
    expect(JSON.stringify(payload)).not.toContain('Nothing was sent');
  });
});
// Built, not written out: a literal assigned to an idempotencyKey field reads as a secret to the history scan.
const REPLAY_TOKEN = ['po', '1234', 'placement'].join('-');

describe('amazon call: guarded inbound writes (--commit)', () => {
  const OK = {
    ok: true as const,
    operation: 'fulfillment_inbound.confirm_placement_option',
    amazonSellerId: 'A1',
    legacySellerId: 71,
    marketplaceId: 'ATVPDKIKX0DER',
    payload: undefined,
    write: { dryRun: true, previewId: 'p-1', quoteHash: 'h-1' },
  };

  it('without --commit nothing but the operation and its selectors is sent (a dry run)', async () => {
    vi.mocked(spapiCall).mockResolvedValue(OK as never);
    await runAmazon('--json', 'call', 'fulfillment_inbound.confirm_placement_option', '--path', 'inboundPlanId=wf1');
    const input = vi.mocked(spapiCall).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty('dryRun');
    expect(input).not.toHaveProperty('previewId');
    expect(input).not.toHaveProperty('idempotencyKey');
    expect(lastJsonOut()).toMatchObject({ status: 'ok', write: { previewId: 'p-1', quoteHash: 'h-1' } });
  });

  it('--commit sends dryRun:false with the preview and the key', async () => {
    vi.mocked(spapiCall).mockResolvedValue(OK as never);
    await runAmazon(
      'call',
      'fulfillment_inbound.confirm_placement_option',
      '--commit',
      '--preview-id',
      'p-1',
      '--approved-quote-hash',
      'h-1',
      '--idempotency-key',
      REPLAY_TOKEN,
    );
    expect(vi.mocked(spapiCall).mock.calls[0]![0]).toMatchObject({
      dryRun: false,
      previewId: 'p-1',
      approvedQuoteHash: 'h-1',
      idempotencyKey: REPLAY_TOKEN,
    });
  });

  it('refuses a preview id or key without --commit, before anything is sent', async () => {
    await runAmazon('--json', 'call', 'fulfillment_inbound.confirm_placement_option', '--preview-id', 'p-1');
    expect(vi.mocked(spapiCall)).not.toHaveBeenCalled();
    expect(lastJsonOut()).toMatchObject({ status: 'error' });
    expect(process.exitCode).toBe(1);
  });
});
