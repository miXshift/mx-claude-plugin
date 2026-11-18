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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('amazon call: commit safety and honest outcomes', () => {
  const commitArgs = [
    'call',
    'fulfillment_inbound.confirm_placement_option',
    '--commit',
    '--preview-id',
    'p-1',
    '--approved-quote-hash',
    'h-1',
  ];
  const answer = (outcome: string) => ({
    ok: true as const,
    operation: 'fulfillment_inbound.confirm_placement_option',
    amazonSellerId: 'A1',
    legacySellerId: 71,
    marketplaceId: 'ATVPDKIKX0DER',
    payload: undefined,
    write: { dryRun: false, outcome, operationId: 'op-1' },
  });

  it('refuses --commit without an idempotency key, before anything is sent', async () => {
    await runAmazon('--json', ...commitArgs);
    expect(vi.mocked(spapiCall)).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('--idempotency-key');
    expect(process.exitCode).toBe(1);
  });

  it('refuses an idempotency key without --commit', async () => {
    await runAmazon('--json', 'call', 'fulfillment_inbound.confirm_placement_option', '--idempotency-key', REPLAY_TOKEN);
    expect(vi.mocked(spapiCall)).not.toHaveBeenCalled();
    expect(lastJsonOut()).toMatchObject({ status: 'error' });
  });

  it('a FAILED commit is a failure: status, exit code and telemetry', async () => {
    vi.mocked(spapiCall).mockResolvedValue(answer('FAILED') as never);
    await runAmazon('--json', ...commitArgs, '--idempotency-key', REPLAY_TOKEN);
    expect(lastJsonOut()).toMatchObject({ status: 'failed', write: { outcome: 'FAILED' } });
    expect(process.exitCode).toBe(1);
    expect(lastFailurePayload()).toMatchObject({ kind: 'commit_failed' });
  });

  it('an UNCERTAIN or PENDING commit is not success: status uncertain, exit 21', async () => {
    for (const outcome of ['UNCERTAIN', 'PENDING']) {
      process.exitCode = undefined;
      vi.mocked(spapiCall).mockResolvedValue(answer(outcome) as never);
      await runAmazon('--json', ...commitArgs, '--idempotency-key', REPLAY_TOKEN);
      expect(lastJsonOut()).toMatchObject({ status: 'uncertain' });
      expect(process.exitCode).toBe(21);
      expect(lastFailurePayload()).toMatchObject({ kind: 'commit_uncertain' });
    }
  });

  it('a DONE commit is still ok and exits clean', async () => {
    process.exitCode = undefined;
    vi.mocked(spapiCall).mockResolvedValue(answer('DONE') as never);
    await runAmazon('--json', ...commitArgs, '--idempotency-key', REPLAY_TOKEN);
    expect(lastJsonOut()).toMatchObject({ status: 'ok', write: { outcome: 'DONE' } });
    expect(process.exitCode).toBeUndefined();
  });

  it('an unknown-outcome failure shows requestOutcome in the --json output', async () => {
    vi.mocked(spapiCall).mockResolvedValue({
      ok: false,
      kind: 'host_unreachable',
      friendly: 'No answer came back.',
      requestOutcome: 'unknown',
    } as never);
    await runAmazon('--json', ...commitArgs, '--idempotency-key', REPLAY_TOKEN);
    expect(lastJsonOut()).toMatchObject({ status: 'error', request_outcome: 'unknown' });
    expect(lastFailurePayload()).toMatchObject({ request_outcome: 'unknown' });
  });

  it('a plain read prints exactly what it did before: payload only, no write key', async () => {
    vi.mocked(spapiCall).mockResolvedValue({
      ok: true,
      operation: 'fulfillment_inbound.list_inbound_plans',
      amazonSellerId: 'A1',
      legacySellerId: 71,
      marketplaceId: 'ATVPDKIKX0DER',
      payload: { inboundPlans: [] },
    } as never);
    await runAmazon('--json', 'call', 'fulfillment_inbound.list_inbound_plans');
    expect(lastJsonOut()).toEqual({
      status: 'ok',
      operation: 'fulfillment_inbound.list_inbound_plans',
      amazon_seller_id: 'A1',
      legacy_seller_id: 71,
      marketplace_id: 'ATVPDKIKX0DER',
      payload: { inboundPlans: [] },
    });
    const input = vi.mocked(spapiCall).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty('previewId');
    expect(input).not.toHaveProperty('idempotencyKey');
    expect(input).not.toHaveProperty('dryRun');
  });
});

describe('amazon call listings.patch_listings_item: the change set goes top-level, not under body.body (mx-ops#295)', () => {
  const CHANGE_SET = {
    items: [
      {
        sku: 'SKU-1',
        productType: 'PRODUCT',
        patches: [{ op: 'replace', path: '/attributes/generic_keyword', value: [{ value: 'a b c' }] }],
      },
    ],
  };
  const HASH = 'c'.repeat(64);
  let dir: string;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mx-listings-'));
    fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          operation: 'listings.patch_listings_item',
          amazonSellerId: 'A1',
          legacySellerId: 71,
          marketplaceId: 'ATVPDKIKX0DER',
          mode: 'preview',
          changeSetId: 'cs-1',
          changeSetHash: HASH,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    // Run the REAL client against a fake service, so these tests pin the JSON
    // that actually leaves the CLI, not just the input object.
    const actual = await vi.importActual<typeof import('../lib/amazon/spapi-call.js')>(
      '../lib/amazon/spapi-call.js',
    );
    vi.mocked(spapiCall).mockImplementation((input, opts) =>
      actual.spapiCall(input, {
        ...opts,
        apiBaseOverride: 'https://svc.test',
        tokenProvider: async () => 'tok',
        fetchImpl: fetchImpl as never,
      }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function file(name: string, content: unknown): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, JSON.stringify(content), 'utf8');
    return p;
  }

  function sentBody(): Record<string, unknown> {
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://svc.test/api/amazon/spapi/call');
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it('--change-set-file previews: changeSet and mode=preview are top-level, no body', async () => {
    const f = await file('cs.json', CHANGE_SET);
    await runAmazon('--json', 'call', 'listings.patch_listings_item', '--path', 'sku=SKU-1', '--change-set-file', f);
    expect(sentBody()).toEqual({
      operation: 'listings.patch_listings_item',
      pathParams: { sku: 'SKU-1' },
      changeSet: CHANGE_SET,
      mode: 'preview',
    });
    // The preview's id and hash reach the caller for the commit.
    expect(lastJsonOut()).toMatchObject({ status: 'ok', write: { changeSetId: 'cs-1', changeSetHash: HASH } });
  });

  it('--change-set inline previews the same way', async () => {
    await runAmazon('call', 'listings.patch_listings_item', '--change-set', JSON.stringify(CHANGE_SET));
    const sent = sentBody();
    expect(sent.changeSet).toEqual(CHANGE_SET);
    expect(sent.mode).toBe('preview');
    expect(sent).not.toHaveProperty('body');
  });

  it('a --body-file holding { changeSet, mode } (what the customer sent) is lifted to the top level', async () => {
    const f = await file('body.json', { changeSet: CHANGE_SET, mode: 'preview' });
    await runAmazon('call', 'listings.patch_listings_item', '--path', 'sku=SKU-1', '--body-file', f);
    const sent = sentBody();
    expect(sent).not.toHaveProperty('body');
    expect(sent.changeSet).toEqual(CHANGE_SET);
    expect(sent.mode).toBe('preview');
  });

  it('a --body that is the change set itself is sent as the top-level changeSet', async () => {
    await runAmazon('call', 'listings.patch_listings_item', '--body', JSON.stringify(CHANGE_SET));
    const sent = sentBody();
    expect(sent).not.toHaveProperty('body');
    expect(sent.changeSet).toEqual(CHANGE_SET);
    expect(sent.mode).toBe('preview');
  });

  it('--commit sends mode=commit, changeSetId and approvedChangeSetHash top-level; no change set, no dryRun', async () => {
    await runAmazon(
      'call',
      'listings.patch_listings_item',
      '--path',
      'sku=SKU-1',
      '--commit',
      '--change-set-id',
      'cs-1',
      '--approved-change-set-hash',
      HASH,
    );
    expect(sentBody()).toEqual({
      operation: 'listings.patch_listings_item',
      pathParams: { sku: 'SKU-1' },
      mode: 'commit',
      changeSetId: 'cs-1',
      approvedChangeSetHash: HASH,
    });
  });

  it('--commit with a --body-file holding { changeSetId, approvedChangeSetHash } lifts them top-level', async () => {
    const f = await file('commit.json', { mode: 'commit', changeSetId: 'cs-1', approvedChangeSetHash: HASH });
    await runAmazon('call', 'listings.patch_listings_item', '--commit', '--body-file', f);
    const sent = sentBody();
    expect(sent).toMatchObject({ mode: 'commit', changeSetId: 'cs-1', approvedChangeSetHash: HASH });
    expect(sent).not.toHaveProperty('body');
    expect(sent).not.toHaveProperty('changeSet');
  });

  it('refuses a preview with no change set, before anything is sent', async () => {
    await runAmazon('--json', 'call', 'listings.patch_listings_item', '--path', 'sku=SKU-1');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('--change-set-file');
    expect(process.exitCode).toBe(1);
  });

  it('refuses --commit without the id and hash, before anything is sent', async () => {
    await runAmazon('--json', 'call', 'listings.patch_listings_item', '--commit', '--change-set-id', 'cs-1');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('--approved-change-set-hash');
  });

  it('refuses an id and hash without --commit', async () => {
    await runAmazon(
      '--json',
      'call',
      'listings.patch_listings_item',
      '--change-set-id',
      'cs-1',
      '--approved-change-set-hash',
      HASH,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('--commit');
  });

  it('refuses the FBA inbound commit flags on a listing write', async () => {
    await runAmazon('--json', 'call', 'listings.patch_listings_item', '--commit', '--preview-id', 'p-1');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('--change-set-id');
  });

  it('refuses the change set flags on any other operation', async () => {
    await runAmazon('--json', 'call', 'listings.get_listings_item', '--change-set', '{}');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(lastJsonOut().message)).toContain('listings.patch_listings_item only');
  });

  it('other operations still send --body under body, unchanged', async () => {
    await runAmazon('call', 'data_kiosk.create_query', '--body', '{"query":"q"}');
    const sent = sentBody();
    expect(sent).toEqual({ operation: 'data_kiosk.create_query', body: { query: 'q' } });
  });
});
