/**
 * Command-level tests for `mixshift ads call --propose` and
 * `mixshift ads proposals ...` against a MOCKED gateway.
 *
 * The transport is the real `amazonRequest` (so request shapes, headers and
 * the failure-envelope mapping are the production code); only the network
 * edge is replaced: every request goes to `gateway`, a vi.fn that answers
 * with whatever the test queues. Pins:
 *   - propose sends the same selectors/pathParams/query/body an `ads call`
 *     would, plus title/rationale/evidence/expiresInHours, and never dryRun;
 *   - --propose with --commit is refused before anything is sent;
 *   - list/show render; approve prints what it approves and sends the FETCHED
 *     hash and acknowledgeGuard; commit sends the fetched hash;
 *   - every proposal error kind: exit code + --json envelope.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAdsCommands } from './ads.js';
import { track } from '../lib/telemetry/index.js';

const gateway = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock('../lib/amazon/reports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/reports.js')>();
  return {
    ...actual,
    amazonRequest: (
      spec: Parameters<typeof actual.amazonRequest>[0],
      opts: Parameters<typeof actual.amazonRequest>[1],
    ) =>
      actual.amazonRequest(spec, {
        ...opts,
        apiBaseOverride: 'https://svc.test',
        tokenProvider: async () => 'tok',
        fetchImpl: ((url: string, init: RequestInit) =>
          gateway(url, init)) as unknown as typeof fetch,
      }),
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
  registerAdsCommands(program);
  return program;
}

let out: string[];
let err: string[];
let exitCodeBefore: typeof process.exitCode;
let tmp: string;

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

function json(): Record<string, unknown> {
  return JSON.parse(out.join(''));
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** What the test sent on call n (0-based): path, method, parsed body. */
function sent(n = 0): { url: string; method: string; body: Record<string, unknown> | undefined } {
  const [url, init] = gateway.mock.calls[n]!;
  return {
    url,
    method: String(init.method),
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  };
}

const PROPOSAL = {
  id: '11111111-2222-3333-4444-555555555555',
  status: 'PROPOSED',
  operation: 'sp.update_campaigns',
  profileId: 'p1',
  legacySellerId: 71,
  itemsCount: 2,
  title: 'Weekly budget pass',
  rationale: 'Two capped campaigns',
  payloadHash: 'abcdef0123456789abcdef0123456789',
  createdAt: '2026-10-22T00:00:00Z',
  expiresAt: '2026-10-25T00:00:00Z',
  proposedBy: 'routine',
  guard: { thresholdPct: 25, flagged: [] as unknown[] },
  guardAcknowledged: false,
  request: {
    pathParams: {},
    query: {},
    body: { campaigns: [{ campaignId: '1', budget: { budget: 30 } }, { campaignId: '2', budget: { budget: 12 } }] },
  },
};

const FLAGGED = {
  ...PROPOSAL,
  guard: {
    thresholdPct: 25,
    flagged: [{ index: 0, id: '1', field: 'budget.budget', from: 20, to: 30, pctChange: 50 }],
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  gateway.mockReset();
  out = [];
  err = [];
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown): boolean => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown): boolean => {
    err.push(String(c));
    return true;
  });
  tmp = await mkdtemp(join(tmpdir(), 'mx-proposals-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmp, { recursive: true, force: true });
});

describe('ads call --propose', () => {
  it('POSTs the call body plus proposal fields to /proposals and never sends dryRun', async () => {
    const evidencePath = join(tmp, 'evidence.json');
    await writeFile(evidencePath, JSON.stringify({ acos: 0.21 }));
    gateway.mockResolvedValue(reply(201, { status: 'ok', proposal: PROPOSAL }));

    await run(
      '--json', 'ads', 'call', 'sp.update_campaigns',
      '--legacy-seller-id', '71',
      '--profile-id', 'p1',
      '--path', 'advertiserId=123',
      '--query', 'x=1',
      '--body', '{"campaigns":[{"campaignId":"1","budget":{"budget":30}}]}',
      '--propose',
      '--title', 'Weekly budget pass',
      '--rationale', 'Two capped campaigns',
      '--evidence-file', evidencePath,
      '--expires-hours', '48',
    );

    expect(process.exitCode ?? 0).toBe(0);
    expect(gateway).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://svc.test/api/amazon/ads/proposals');
    expect(req.body).toEqual({
      operation: 'sp.update_campaigns',
      profileId: 'p1',
      legacySellerId: 71,
      pathParams: { advertiserId: '123' },
      query: { x: '1' },
      body: { campaigns: [{ campaignId: '1', budget: { budget: 30 } }] },
      title: 'Weekly budget pass',
      rationale: 'Two capped campaigns',
      evidence: { acos: 0.21 },
      expiresInHours: 48,
    });
    expect(req.body).not.toHaveProperty('dryRun');
    expect(json()).toMatchObject({ status: 'ok', proposal: { id: PROPOSAL.id, status: 'PROPOSED' } });

    const ev = vi.mocked(track).mock.calls[0]![0];
    expect(ev.event_name).toBe('ads.proposal_created');
    expect(ev.outcome).toBe('ok');
    expect(ev.payload).toMatchObject({ proposal_id: PROPOSAL.id, operation: 'sp.update_campaigns', items_count: 2, has_evidence: true });
    // No change set, rationale or evidence in telemetry.
    expect(JSON.stringify(ev.payload)).not.toContain('Two capped');
    expect(JSON.stringify(ev.payload)).not.toContain('0.21');
  });

  it('prints a human summary on stderr and the id on stdout without --json', async () => {
    gateway.mockResolvedValue(reply(201, { status: 'ok', proposal: PROPOSAL }));
    await run('ads', 'call', 'sp.update_campaigns', '--legacy-seller-id', '71', '--body', '{"campaigns":[]}', '--propose');
    expect(err.join('')).toContain('PROPOSED sp.update_campaigns');
    expect(err.join('')).toContain('nothing applied');
    expect(JSON.parse(out.join(''))).toMatchObject({ id: PROPOSAL.id, payloadHash: PROPOSAL.payloadHash });
  });

  it('refuses --propose together with --commit before anything is sent', async () => {
    await run('--json', 'ads', 'call', 'sp.update_campaigns', '--propose', '--commit');
    expect(gateway).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(json()).toMatchObject({ status: 'error' });
    expect(String(json().message)).toContain('cannot be combined');
  });

  it('refuses proposal-only flags without --propose, and a bad --expires-hours', async () => {
    await run('--json', 'ads', 'call', 'sp.update_campaigns', '--title', 'x');
    expect(process.exitCode).toBe(1);
    expect(String(json().message)).toContain('--title only applies with --propose');
    out = [];
    process.exitCode = undefined;
    await run('--json', 'ads', 'call', 'sp.update_campaigns', '--propose', '--expires-hours', '500');
    expect(process.exitCode).toBe(1);
    expect(String(json().message)).toContain('1 to 168');
    expect(gateway).not.toHaveBeenCalled();
  });

  it('a gateway refusal (non-write operation) comes back as invalid_request, exit 15', async () => {
    gateway.mockResolvedValue(
      reply(400, {
        ok: false,
        kind: 'invalid_request',
        source: 'request',
        retryable: false,
        friendly: 'sp.list_campaigns is not a write operation; only writes can be proposed.',
        fix: 'Call it directly with `ads call` instead.',
      }),
    );
    await run('--json', 'ads', 'call', 'sp.list_campaigns', '--legacy-seller-id', '71', '--propose');
    expect(process.exitCode).toBe(15);
    expect(json()).toMatchObject({ status: 'error', failure_kind: 'invalid_request', retryable: false });
  });
});

describe('ads proposals list / show', () => {
  it('list sends status (uppercased) and limit, renders a table, and --json is a count + array', async () => {
    gateway.mockImplementation(async () => reply(200, { status: 'ok', proposals: [PROPOSAL] }));
    await run('ads', 'proposals', 'list', '--status', 'proposed', '--limit', '10');
    expect(sent().method).toBe('GET');
    expect(sent().url).toBe('https://svc.test/api/amazon/ads/proposals?status=PROPOSED&limit=10');
    expect(out.join('')).toContain('| id | status | operation | items | expires | title |');
    expect(out.join('')).toContain(PROPOSAL.id);
    expect(err.join('')).toContain('1 proposal(s)');

    out = [];
    await run('--json', 'ads', 'proposals', 'list');
    expect(sent(1).url).toBe('https://svc.test/api/amazon/ads/proposals');
    expect(json()).toMatchObject({ status: 'ok', count: 1 });
  });

  it('show renders operation, items, guard flags and expiry on stderr and full JSON on stdout', async () => {
    gateway.mockResolvedValue(reply(200, { status: 'ok', proposal: FLAGGED }));
    await run('ads', 'proposals', 'show', FLAGGED.id);
    expect(sent().url).toBe(`https://svc.test/api/amazon/ads/proposals/${FLAGGED.id}`);
    const text = err.join('');
    expect(text).toContain('operation: sp.update_campaigns');
    expect(text).toContain('items: 2');
    expect(text).toContain('expires: 2026-10-25T00:00:00Z');
    expect(text).toContain('1 money change(s) above the 25% threshold');
    expect(text).toContain('1 budget.budget: 20 -> 30 (+50%)');
    expect(text).toContain('1. budget={"budget":30} | other: {"campaignId":"1"}');
    expect(JSON.parse(out.join(''))).toMatchObject({ id: FLAGGED.id });
  });
});

describe('ads proposals approve', () => {
  it('fetches, prints what it approves, then sends the FETCHED hash and acknowledgeGuard', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: FLAGGED }))
      .mockResolvedValueOnce(
        reply(200, { status: 'ok', proposal: { ...FLAGGED, status: 'APPROVED', approvedBy: 'a person', guardAcknowledged: true } }),
      );
    await run('--json', 'ads', 'proposals', 'approve', FLAGGED.id, '--acknowledge-guard', '--note', 'ok by me');

    expect(gateway).toHaveBeenCalledTimes(2);
    expect(sent(0).method).toBe('GET');
    expect(sent(1).url).toBe(`https://svc.test/api/amazon/ads/proposals/${FLAGGED.id}/approve`);
    expect(sent(1).body).toEqual({
      payloadHash: FLAGGED.payloadHash,
      acknowledgeGuard: true,
      note: 'ok by me',
    });
    // The approver sees what is being approved before the approval is sent.
    expect(err.join('')).toContain('Approving this proposal');
    expect(err.join('')).toContain('operation: sp.update_campaigns');
    expect(json()).toMatchObject({ status: 'ok', proposal: { status: 'APPROVED' } });
    expect(process.exitCode ?? 0).toBe(0);
    const ev = vi.mocked(track).mock.calls.at(-1)![0];
    expect(ev.event_name).toBe('ads.proposal_approved');
    expect(ev.payload).toMatchObject({ acknowledged_guard: true, guard_flagged: 1 });
  });

  it('omits acknowledgeGuard unless asked', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: PROPOSAL }))
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }));
    await run('ads', 'proposals', 'approve', PROPOSAL.id);
    expect(sent(1).body).toEqual({ payloadHash: PROPOSAL.payloadHash });
  });

  it('a flagged proposal without --acknowledge-guard maps proposal_guard_ack_required to exit 18', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: FLAGGED }))
      .mockResolvedValueOnce(reply(409, { ok: false, kind: 'proposal_guard_ack_required', friendly: 'Acknowledge the guard.' }));
    await run('--json', 'ads', 'proposals', 'approve', FLAGGED.id);
    expect(sent(1).body).not.toHaveProperty('acknowledgeGuard');
    expect(process.exitCode).toBe(18);
    expect(json()).toMatchObject({ status: 'error', failure_kind: 'proposal_guard_ack_required' });
    const ev = vi.mocked(track).mock.calls.at(-1)![0];
    expect(ev.event_name).toBe('ads.proposal_failed');
    expect(ev.payload).toMatchObject({ action: 'approve', kind: 'proposal_guard_ack_required' });
  });
});

describe('ads proposals reject / commit', () => {
  it('reject sends the reason', async () => {
    gateway.mockResolvedValue(reply(200, { status: 'ok', proposal: { ...PROPOSAL, status: 'REJECTED', rejectReason: 'too big' } }));
    await run('--json', 'ads', 'proposals', 'reject', PROPOSAL.id, '--reason', 'too big');
    expect(sent().url).toBe(`https://svc.test/api/amazon/ads/proposals/${PROPOSAL.id}/reject`);
    expect(sent().body).toEqual({ reason: 'too big' });
    expect(json()).toMatchObject({ proposal: { status: 'REJECTED' } });
    expect(vi.mocked(track).mock.calls.at(-1)![0].event_name).toBe('ads.proposal_rejected');
  });

  it('commit fetches then sends the fetched hash, and reports the response', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
      .mockResolvedValueOnce(
        reply(200, {
          status: 'ok',
          proposal: { ...PROPOSAL, status: 'COMMITTED', commitAuditId: 'audit-1', response: { success: [{}, {}], error: [] } },
        }),
      );
    await run('ads', 'proposals', 'commit', PROPOSAL.id);
    expect(sent(1).url).toBe(`https://svc.test/api/amazon/ads/proposals/${PROPOSAL.id}/commit`);
    expect(sent(1).body).toEqual({ payloadHash: PROPOSAL.payloadHash });
    expect(err.join('')).toContain('COMMITTED proposal');
    expect(err.join('')).toContain('audit: audit-1');
    expect(JSON.parse(out.join(''))).toEqual({ response: { success: [{}, {}], error: [] } });
    expect(process.exitCode ?? 0).toBe(0);
    const ev = vi.mocked(track).mock.calls.at(-1)![0];
    expect(ev.event_name).toBe('ads.proposal_committed');
    expect(ev.payload).toMatchObject({ audit_id: 'audit-1', items_count: 2 });
    expect(JSON.stringify(ev.payload)).not.toContain('success');
  });

  it('success envelope: audit id and counts come from `commit`, proposal is COMMITTED', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { ok: true, status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
      .mockResolvedValueOnce(
        reply(200, {
          ok: true,
          status: 'ok',
          proposal: { ...PROPOSAL, status: 'COMMITTED', itemsCount: undefined },
          commit: { auditId: 'audit-9', itemsCount: 2, successCount: 2, errorCount: 0 },
        }),
      );
    await run('ads', 'proposals', 'commit', PROPOSAL.id);
    expect(process.exitCode ?? 0).toBe(0);
    expect(err.join('')).toContain('audit: audit-9');
    const ev = vi.mocked(track).mock.calls.at(-1)![0];
    expect(ev.event_name).toBe('ads.proposal_committed');
    expect(ev.payload).toMatchObject({ audit_id: 'audit-9', items_count: 2 });
  });
});

describe('a commit that ends FAILED or UNCERTAIN arrives as an ERROR envelope', () => {
  const UNCERTAIN_HINT =
    'Amazon may have applied it. Do NOT commit again and do not propose it again: re-list the targeted entities and check them first.';
  const CASES: Array<
    [proposalStatus: string, kind: string, httpStatus: number, hint: string, notHint: string]
  > = [
    ['UNCERTAIN', 'host_unreachable', 502, UNCERTAIN_HINT, 'nothing was applied'],
    ['UNCERTAIN', 'unknown', 500, UNCERTAIN_HINT, 'nothing was applied'],
    ['FAILED', 'bad_request', 400, 'Amazon refused it and nothing was applied', 'Do NOT commit again'],
  ];

  it.each(CASES)(
    'proposalStatus %s with kind %s: original exit code, id and status kept, right words',
    async (proposalStatus, kind, httpStatus, hint, notHint) => {
      const envelope = { ok: false, kind, friendly: 'Amazon did not take the write.', proposalId: PROPOSAL.id, proposalStatus };
      gateway
        .mockResolvedValueOnce(reply(200, { ok: true, status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
        .mockResolvedValueOnce(reply(httpStatus, envelope));
      await run('ads', 'proposals', 'commit', PROPOSAL.id);
      const code = process.exitCode;
      expect(code).toBeGreaterThan(0);
      const text = err.join('');
      expect(text).toContain(hint);
      expect(text).not.toContain(notHint);
      expect(text).toContain(`proposal: ${PROPOSAL.id} (${proposalStatus})`);
      const ev = vi.mocked(track).mock.calls.at(-1)![0];
      expect(ev.event_name).toBe('ads.proposal_failed');
      expect(ev.payload).toMatchObject({ action: 'commit', kind, proposal_status: proposalStatus });

      // Same call with --json: the envelope keeps the id, the state and the next step.
      process.exitCode = undefined;
      out = [];
      gateway
        .mockResolvedValueOnce(reply(200, { ok: true, status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
        .mockResolvedValueOnce(reply(httpStatus, envelope));
      await run('--json', 'ads', 'proposals', 'commit', PROPOSAL.id);
      expect(process.exitCode).toBe(code);
      expect(json()).toMatchObject({
        status: 'error',
        failure_kind: kind,
        proposal_id: PROPOSAL.id,
        proposal_status: proposalStatus,
      });
      expect(String(json().next_step)).toContain(hint);
    },
  );

  it('the proposal id and status from the envelope are sanitized before use', async () => {
    gateway
      .mockResolvedValueOnce(reply(200, { ok: true, status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
      .mockResolvedValueOnce(
        reply(502, {
          ok: false,
          kind: 'host_unreachable',
          friendly: 'x',
          proposalId: 'p-1\u001b[2J',
          proposalStatus: 'uncertain\n',
        }),
      );
    await run('--json', 'ads', 'proposals', 'commit', PROPOSAL.id);
    expect(json()).toMatchObject({ proposal_id: 'p-12J', proposal_status: 'UNCERTAIN' });
  });
});

describe('wrong-state refusals name the actual state', () => {
  it.each([
    ['UNCERTAIN', 'may have applied it'],
    ['COMMITTED', 'already committed'],
    ['REJECTED', 'was rejected'],
    ['COMMITTING', 'another commit of this proposal is in flight'],
    ['PROPOSED', 'still waiting for approval'],
    ['EXPIRED', 'expired'],
  ])('proposal_not_approved with proposalStatus %s', async (status, words) => {
    gateway.mockResolvedValue(
      reply(409, {
        ok: false,
        kind: 'proposal_not_approved',
        friendly: 'has not been approved (or was rejected)',
        proposalId: PROPOSAL.id,
        proposalStatus: status,
      }),
    );
    await run('--json', 'ads', 'proposals', 'show', PROPOSAL.id);
    expect(process.exitCode).toBe(16);
    const msg = String(json().message);
    expect(msg.toLowerCase()).toContain(words.toLowerCase());
    expect(msg).not.toContain('or was rejected');
    expect(json()).toMatchObject({ proposal_status: status });
  });

  it('approval_requires_human default text: a person, own sign-in, different session', async () => {
    gateway.mockResolvedValue(reply(403, { ok: false, kind: 'approval_requires_human' }));
    await run('--json', 'ads', 'proposals', 'show', PROPOSAL.id);
    expect(process.exitCode).toBe(19);
    const msg = String(json().message);
    expect(msg).toContain("person's own sign-in");
    expect(msg).toContain('different session');
    expect(msg).toContain('Service credentials and scheduled routines cannot approve');
  });
});

describe('proposal error kinds: exit code + --json envelope', () => {
  const CASES: Array<[kind: string, status: number, exit: number]> = [
    ['proposal_not_found', 404, 16],
    ['proposal_expired', 409, 16],
    ['proposal_not_approved', 409, 16],
    ['proposal_hash_mismatch', 409, 16],
    ['proposal_before_state_unavailable', 409, 16],
    ['proposal_stale', 409, 17],
    ['proposal_guard_ack_required', 409, 18],
    ['approval_requires_human', 403, 19],
    ['proposal_limit_reached', 429, 20],
    ['insufficient_scope', 403, 11],
  ];

  it.each(CASES)('%s (HTTP %i) -> exit %i with the failure envelope', async (kind, status, exit) => {
    gateway.mockResolvedValue(
      reply(status, {
        ok: false,
        kind,
        friendly: `friendly for ${kind}`,
        message: 'detail text',
        source: 'request',
        retryable: false,
        fix: 'do the fix',
      }),
    );
    await run('--json', 'ads', 'proposals', 'show', 'p-1');
    expect(process.exitCode).toBe(exit);
    expect(json()).toMatchObject({
      status: 'error',
      failure_kind: kind,
      message: `friendly for ${kind}`,
      source: 'request',
      retryable: false,
      fix: 'do the fix',
    });
    expect(json()).not.toHaveProperty('unrecognized_kind', expect.anything());
    const ev = vi.mocked(track).mock.calls.at(-1)![0];
    expect(ev.event_name).toBe('ads.proposal_failed');
    expect(ev.payload).toMatchObject({ action: 'show', kind, proposal_id: 'p-1', retryable: false, has_fix: true });
  });

  it('proposal_stale carries the drift list to --json and stderr, and only its count to telemetry', async () => {
    const drift = [{ index: 0, id: '1', field: 'budget.budget', before: 20, live: 35 }];
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
      .mockResolvedValueOnce(reply(409, { ok: false, kind: 'proposal_stale', friendly: 'Live values changed.', drift }));
    await run('--json', 'ads', 'proposals', 'commit', PROPOSAL.id);
    expect(process.exitCode).toBe(17);
    expect(json()).toMatchObject({ failure_kind: 'proposal_stale', drift });
    expect(vi.mocked(track).mock.calls.at(-1)![0].payload).toMatchObject({ drift_count: 1 });

    err = [];
    out = [];
    gateway
      .mockResolvedValueOnce(reply(200, { status: 'ok', proposal: { ...PROPOSAL, status: 'APPROVED' } }))
      .mockResolvedValueOnce(reply(409, { ok: false, kind: 'proposal_stale', friendly: 'Live values changed.', drift }));
    await run('ads', 'proposals', 'commit', PROPOSAL.id);
    expect(err.join('')).toContain('changed since the proposal');
    expect(err.join('')).toContain('"live":35');
  });

  it('an error on the pre-flight fetch of approve/commit stops before anything is approved or sent', async () => {
    gateway.mockResolvedValue(reply(404, { ok: false, kind: 'proposal_not_found', friendly: 'No such proposal.' }));
    await run('ads', 'proposals', 'approve', 'missing');
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(16);
  });
});
