/**
 * Command-level tests for the `mixshift ads call --commit` → brand-timeline
 * emission wiring (workstream D of the P2 org-brain build).
 *
 * adsCall and emitAdsCommitEvent are mocked; the pins are:
 *   - a successful COMMIT emits exactly one timeline event carrying the
 *     change set, the commit audit id, and the threaded --proposal-id;
 *   - dry runs and failures emit nothing;
 *   - a broken emitter (even a rejecting one) can NEVER fail the commit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import { registerAdsCommands } from './ads.js';
import { adsCall } from '../lib/amazon/ads-call.js';
import { emitAdsCommitEvent } from '../lib/timeline/ads-emit.js';
import { track } from '../lib/telemetry/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../lib/auth/credentials.js';
import { loadCreativeMap } from '../lib/ads/dsp-creative-map.js';

vi.mock('../lib/amazon/ads-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/ads-call.js')>();
  return {
    ...actual,
    adsCall: vi.fn(),
    listAdsProfiles: vi.fn(),
    listAdsOperations: vi.fn(),
  };
});

vi.mock('../lib/timeline/ads-emit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/timeline/ads-emit.js')>();
  return {
    ...actual,
    emitAdsCommitEvent: vi.fn(async () => ({ posted: true, id: 'evt', brand_slug: 'acme' })),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerAdsCommands(program);
  return program;
}

async function runAds(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'ads', ...args]);
}

let exitCodeBefore: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(emitAdsCommitEvent).mockResolvedValue({
    posted: true,
    id: 'evt',
    brand_slug: 'acme',
  });
  exitCodeBefore = process.exitCode;
  vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
});

const COMMIT_RESULT = {
  ok: true as const,
  operation: 'sp.update_keywords',
  profileId: 'p1',
  legacySellerId: 574,
  marketplaceId: 'ATVPDKIKX0DER',
  dryRun: false,
  itemsCount: 2,
  auditId: 'audit_commit',
  payload: { success: [{}, {}], error: [] },
};

describe('ads call --commit → timeline emission', () => {
  it('emits one event with the change set, audit id, and threaded proposal id', async () => {
    vi.mocked(adsCall).mockResolvedValue(COMMIT_RESULT);

    await runAds(
      'call',
      'sp.update_keywords',
      '--legacy-seller-id',
      '574',
      '--body',
      '[{"keywordId":"111","bid":0.8}]',
      '--commit',
      '--proposal-id',
      'audit_preview',
      '--data-dir',
      '/tmp/mx-test',
    );

    expect(process.exitCode ?? 0).toBe(0);
    expect(emitAdsCommitEvent).toHaveBeenCalledTimes(1);
    expect(emitAdsCommitEvent).toHaveBeenCalledWith(
      {
        operation: 'sp.update_keywords',
        legacySellerId: 574,
        auditId: 'audit_commit',
        itemsCount: 2,
        requestBody: [{ keywordId: '111', bid: 0.8 }],
        responsePayload: { success: [{}, {}], error: [] },
        proposalId: 'audit_preview',
      },
      { dataDirOverride: '/tmp/mx-test' },
    );
  });

  it('omits proposalId when --proposal-id is not passed (lib falls back to auditId)', async () => {
    vi.mocked(adsCall).mockResolvedValue(COMMIT_RESULT);
    await runAds('call', 'sp.update_keywords', '--commit');
    const [input] = vi.mocked(emitAdsCommitEvent).mock.calls[0]!;
    expect(input).not.toHaveProperty('proposalId');
    expect(input.auditId).toBe('audit_commit');
  });

  it('does NOT emit for a dry run', async () => {
    vi.mocked(adsCall).mockResolvedValue({
      ...COMMIT_RESULT,
      dryRun: true,
      preview: { items: [] },
      payload: undefined,
    });
    await runAds('call', 'sp.update_keywords');
    expect(emitAdsCommitEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit for a read (no dryRun flag at all)', async () => {
    vi.mocked(adsCall).mockResolvedValue({
      ok: true,
      operation: 'sp.list_campaigns',
      profileId: 'p1',
      legacySellerId: 574,
      marketplaceId: null,
      payload: { campaigns: [] },
    });
    await runAds('call', 'sp.list_campaigns');
    expect(emitAdsCommitEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit when the call itself failed', async () => {
    vi.mocked(adsCall).mockResolvedValue({
      ok: false,
      kind: 'insufficient_scope',
      friendly: 'needs ads:write',
      message: 'nope',
    });
    await runAds('call', 'sp.update_keywords', '--commit');
    expect(emitAdsCommitEvent).not.toHaveBeenCalled();
    expect(process.exitCode).not.toBe(0);
  });

  it('a REJECTING emitter still leaves the commit successful (exit 0)', async () => {
    vi.mocked(adsCall).mockResolvedValue(COMMIT_RESULT);
    vi.mocked(emitAdsCommitEvent).mockRejectedValue(new Error('emitter exploded'));
    await runAds('call', 'sp.update_keywords', '--commit');
    expect(emitAdsCommitEvent).toHaveBeenCalledTimes(1);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each([
    'has spaces',
    'semi;colon',
    'a'.repeat(129),
    'sneaky/../path',
    'ünï',
  ])('rejects malformed --proposal-id %j before calling the service', async (bad) => {
    vi.mocked(adsCall).mockResolvedValue(COMMIT_RESULT);
    await runAds('call', 'sp.update_keywords', '--commit', '--proposal-id', bad);
    expect(process.exitCode).toBe(1);
    expect(adsCall).not.toHaveBeenCalled();
    expect(emitAdsCommitEvent).not.toHaveBeenCalled();
  });
});

describe('ads call failure: unknown outcome reaches --json and telemetry', () => {
  it('emits request_outcome, automatic_retry and retry_after_ms, and records the outcome', async () => {
    vi.mocked(adsCall).mockResolvedValue({
      ok: false,
      kind: 'upstream_unavailable',
      friendly: 'Amazon may have already accepted this request.',
      message: 'HTTP 503',
      httpStatus: 502,
      requestOutcome: 'unknown',
      automaticRetry: false,
      retryAfterMs: 5000,
    });
    const out: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    });
    await buildProgram().parseAsync([
      'node',
      'mixshift',
      '--json',
      'ads',
      'call',
      'reporting_v1.create_report',
      '--legacy-seller-id',
      '71',
    ]);
    const emitted = JSON.parse(out.join(''));
    expect(emitted).toMatchObject({
      status: 'error',
      failure_kind: 'upstream_unavailable',
      request_outcome: 'unknown',
      automatic_retry: false,
      retry_after_ms: 5000,
    });
    expect(emitted).not.toHaveProperty('concurrency_cap');
    const payload = vi.mocked(track).mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ request_outcome: 'unknown' });
    expect(process.exitCode).not.toBe(0);
  });
});

describe('ads call: a MixShift refusal reaches the agent as one (mx-ops#144 P5)', () => {
  const REFUSED = {
    ok: false as const,
    kind: 'invalid_request' as const,
    friendly: "pathParams.reportId 'ok' is not an id.",
    httpStatus: 400,
    source: 'request',
    retryable: false,
    fix: 'Poll the value of the `reportId` field returned by reporting.create_report. Nothing was sent to Amazon.',
    invalidParams: ['pathParams.reportId'],
  };

  it('--json carries source, retryable, fix and invalid_params; exit 15', async () => {
    vi.mocked(adsCall).mockResolvedValue(REFUSED);
    const out: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    });
    await buildProgram().parseAsync([
      'node', 'mixshift', '--json', 'ads', 'call', 'reporting.get_report',
      '--legacy-seller-id', '71', '--path', 'reportId=ok',
    ]);
    expect(JSON.parse(out.join(''))).toMatchObject({
      status: 'error',
      failure_kind: 'invalid_request',
      source: 'request',
      retryable: false,
      invalid_params: ['pathParams.reportId'],
      fix: REFUSED.fix,
    });
    expect(process.exitCode).toBe(15);
  });

  it('telemetry records source, retryable and has_fix, never the fix text', async () => {
    vi.mocked(adsCall).mockResolvedValue(REFUSED);
    await runAds('call', 'reporting.get_report', '--legacy-seller-id', '71', '--path', 'reportId=ok');
    const payload = vi.mocked(track).mock.calls[0]?.[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: 'invalid_request', source: 'request', retryable: false, has_fix: true });
    expect(JSON.stringify(payload)).not.toContain('Nothing was sent');
  });
});

// ---------------------------------------------------------------------------
// dsp.create_ads --for-order: the build records its intended order (synthetic ids)
// ---------------------------------------------------------------------------

describe('ads call dsp.create_ads --for-order', () => {
  const ADV = '1000000000000000001';
  const ORDER = '2000000000000000002';
  const AD = '4000000000000000011';
  let dir: string;

  const jwt = (claims: Record<string, unknown>): string => {
    const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${seg({ alg: 'HS256' })}.${seg(claims)}.sig`;
  };

  async function signIn(): Promise<void> {
    await saveCredentials(
      {
        schema_version: 2,
        created_at: new Date().toISOString(),
        datahub: {
          api_base: 'https://mcp.mixshift.io',
          access_token: jwt({ sub: 'tenant-1', actor: 'person@example.test' }),
          refresh_token: 'r'.repeat(24),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
          user_id: 'tenant-1',
          email: 'login@example.test',
          person_label: 'person@example.test',
          device_label: 'test-host',
          client_id: 'mx-claude-plugin',
        },
      },
      dir,
    );
  }

  const create = (extra: string[] = []): Promise<void> =>
    runAds(
      'call',
      'dsp.create_ads',
      '--legacy-seller-id',
      '574',
      '--path',
      `advertiserId=${ADV}`,
      '--body',
      '{"ads":[{"adProduct":"AMAZON_DSP","adType":"COMPONENT","state":"PAUSED","creative":{}}]}',
      '--data-dir',
      dir,
      ...extra,
    );

  const committed = {
    ok: true as const,
    operation: 'dsp.create_ads',
    profileId: 'p1',
    legacySellerId: 574,
    marketplaceId: null,
    dryRun: false,
    itemsCount: 1,
    auditId: 'audit_create',
    payload: { success: [{ index: 0, ad: { adId: AD } }], error: [] },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ads-for-order-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records each created ad as built for the named order after a commit', async () => {
    await signIn();
    vi.mocked(adsCall).mockResolvedValue(committed);
    await create(['--commit', '--for-order', ORDER]);
    expect(process.exitCode ?? 0).toBe(0);
    const loaded = await loadCreativeMap(dir);
    expect(loaded).toMatchObject({
      ok: true,
      entries: [
        {
          tenant: 'user:tenant-1',
          advertiser_id: ADV,
          order_id: ORDER,
          creative_id: AD,
          source: 'plugin_build',
          audit_id: 'audit_create',
        },
      ],
    });
    const ev = vi.mocked(track).mock.calls.map((c) => c[0]).find((e) => e.event_name === 'dsp.creative_map_changed');
    expect(ev?.payload).toEqual({ action: 'build', added: 1, existing: 0 });
    expect(JSON.stringify(ev)).not.toContain(AD);
  });

  it('records nothing on a dry run', async () => {
    await signIn();
    vi.mocked(adsCall).mockResolvedValue({ ...committed, dryRun: true, payload: undefined });
    await create(['--for-order', ORDER]);
    expect(await loadCreativeMap(dir)).toEqual({ ok: true, entries: [] });
  });

  it('never fails the commit when nothing can be recorded (not signed in here), and says so', async () => {
    vi.mocked(adsCall).mockResolvedValue(committed);
    const out: string[] = [];
    vi.mocked(process.stdout.write).mockImplementation((c: unknown): boolean => {
      out.push(String(c));
      return true;
    });
    await runAds(
      '--json',
      'call',
      'dsp.create_ads',
      '--path',
      `advertiserId=${ADV}`,
      '--body',
      '{"ads":[]}',
      '--data-dir',
      dir,
      '--commit',
      '--for-order',
      ORDER,
    );
    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.creative_map.recorded).toEqual([]);
    expect(parsed.creative_map.message).toContain('NOT recorded');
  });

  it('refuses --for-order on another operation, on a proposal, or without the advertiser, before any call', async () => {
    await runAds('call', 'dsp.create_ad_associations', '--path', `advertiserId=${ADV}`, '--body', '{}', '--for-order', ORDER);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await create(['--propose', '--for-order', ORDER]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await runAds('call', 'dsp.create_ads', '--body', '{}', '--for-order', ORDER);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await create(['--for-order', 'order-one']);
    expect(process.exitCode).toBe(1);
    expect(adsCall).not.toHaveBeenCalled();
  });
});
