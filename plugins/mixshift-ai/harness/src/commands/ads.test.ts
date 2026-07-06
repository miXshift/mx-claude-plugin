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
