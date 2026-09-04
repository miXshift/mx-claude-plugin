import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  catalog,
  run,
  pollRun,
  getRunResult,
  isAccepted,
  isIntelligenceFailure,
  exitCodeForKind,
  type IntelligenceClientOptions,
  type IntelligenceFailureKind,
  type InsightResult,
} from './client.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

/**
 * Plugin-side Intelligence client tests. Verify the HTTP request shapes the
 * client sends to mx-legacy-auth (path, method, Authorization, body) and the
 * failure-envelope discrimination, mirroring lib/amazon/reports.test.ts's
 * coverage of amazonRequest — this module is a parallel (not shared)
 * transport, so its own auth/retry/envelope-mapping logic needs its own
 * coverage rather than inheriting reports.test.ts's.
 */

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mx-intelligence-client-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
  vi.unstubAllGlobals();
});

function injected(
  fetchImpl: IntelligenceClientOptions['fetchImpl'],
  tokenProvider: IntelligenceClientOptions['tokenProvider'] = async () => 'tok',
): IntelligenceClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function freshDatahubFixture(): DatahubCreds {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: future,
    refresh_expires_at: future,
    user_id: 'u1',
    email: 'amazon+clients@example.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('catalog', () => {
  it('GETs /api/intelligence/ids and returns entries', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        entries: [
          { id: 'INS-OPS-BRIDGE-01', version: '1.2.0', revision: 'r7', purpose: 'MoM ops bridge', status: 'active' },
        ],
      }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) {
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]!.id).toBe('INS-OPS-BRIDGE-01');
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/intelligence/ids');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('tolerates a missing entries array', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) expect(r.entries).toEqual([]);
  });

  it('recognizes a gateway kind that used to be stamped unknown (mx-ops#43)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(422, { ok: false, kind: 'decomposition_budget_exceeded', friendly: 'Over budget.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('decomposition_budget_exceeded');
      expect(r.unrecognizedKind).toBeUndefined();
      expect(r.friendly).toBe('Over budget.');
    }
  });

  it('recognizes the /api scope gate: insufficient_scope at 403 is itself, not not_enrolled', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, { ok: false, kind: 'insufficient_scope', friendly: 'Lacks intelligence:read.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('insufficient_scope');
      expect(r.unrecognizedKind).toBeUndefined();
      expect(exitCodeForKind(r.kind)).toBe(12);
    }
  });

  it('recognizes the gateway rate limiter: throttled at 429 is itself, not busy', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(429, { ok: false, kind: 'throttled', friendly: 'Slow down.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('throttled');
      expect(r.unrecognizedKind).toBeUndefined();
    }
  });

  it('does NOT guess not_enrolled from a 403: the /api scope gate emits insufficient_scope there (mx-ops#43)', async () => {
    // A real not_enrolled always carries its explicit kind, so a 403 fallback could only mislabel.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, { ok: false, kind: 'a_future_403_kind', friendly: 'No.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('unknown');
      expect(r.unrecognizedKind).toBe('a_future_403_kind');
    }
  });

  it('does NOT guess from a 404, which is three Intelligence kinds on the service (mx-ops#43)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(404, { ok: false, kind: 'a_future_404_kind', friendly: 'Gone.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('unknown');
      expect(r.unrecognizedKind).toBe('a_future_404_kind');
    }
  });

  it('records (absent) when the envelope carries no kind, and maps a 429 to busy (mx-ops#43)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(429, { ok: false, friendly: 'Busy.' }));
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('busy');
      expect(r.unrecognizedKind).toBe('(absent)');
    }
  });

  it('propagates a typed failure (not_enrolled)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, { ok: false, kind: 'not_enrolled', friendly: 'Switched off.' }),
    );
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('not_enrolled');
      expect(r.friendly).toBe('Switched off.');
      expect(r.httpStatus).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// run — sync
// ---------------------------------------------------------------------------

describe('run (sync)', () => {
  it('POSTs {id, params} to /api/intelligence/run', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        momOpsDelta: 1234.5,
        limitations: ['partial data'],
        meta: {
          insightId: 'INS-OPS-BRIDGE-01',
          revision: 'r7',
          engineSha: 'abc123',
          methodologyVersion: '1.0',
          computedAt: '2026-07-27T10:00:00Z',
          cache: { hit: false },
        },
      }),
    );
    const r = await run(
      { id: 'INS-OPS-BRIDGE-01', params: { merchant: { brand: 'acme' } } },
      injected(fetchImpl),
    );
    expect(isIntelligenceFailure(r)).toBe(false);
    expect(isAccepted(r as never)).toBe(false);
    if (!isIntelligenceFailure(r) && !isAccepted(r)) {
      expect(r.meta.insightId).toBe('INS-OPS-BRIDGE-01');
      expect(r.limitations).toEqual(['partial data']);
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/intelligence/run');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ id: 'INS-OPS-BRIDGE-01', params: { merchant: { brand: 'acme' } } });
  });

  it('returns the accepted/async shape when the server signals it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(202, { ok: true, accepted: true, runId: 'run-1', status: 'IN_QUEUE' }),
    );
    const r = await run(
      { id: 'INS-MONTHLY-01', params: { merchant: { brand: 'acme' }, async: true } },
      injected(fetchImpl),
    );
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) {
      expect(isAccepted(r)).toBe(true);
      if (isAccepted(r)) {
        expect(r.runId).toBe('run-1');
        expect(r.status).toBe('IN_QUEUE');
      }
    }
  });

  it('propagates a typed failure (account_too_large_use_async)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: false, kind: 'account_too_large_use_async', friendly: 'Too big.' }),
    );
    const r = await run({ id: 'INS-MONTHLY-01', params: {} }, injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('account_too_large_use_async');
  });

  it('propagates bad_params with the echoed insightId', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, { ok: false, kind: 'bad_params', insightId: 'INS-DUO-01', friendly: 'Bad params.' }),
    );
    const r = await run({ id: 'INS-DUO-01', params: {} }, injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('bad_params');
      expect(r.insightId).toBe('INS-DUO-01');
    }
  });
});

// ---------------------------------------------------------------------------
// pollRun / getRunResult
// ---------------------------------------------------------------------------

describe('pollRun', () => {
  it('GETs /runs/:id and reports ready:true on status DONE', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, status: 'DONE', result: { ok: true, limitations: [], meta: {} } }),
    );
    const r = await pollRun('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) {
      expect(r.ready).toBe(true);
      expect(r.status).toBe('DONE');
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/intelligence/runs/run-1');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('surfaces the not_ready failure kind while the run is still going', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { ok: false, kind: 'not_ready', friendly: 'Still running.' }));
    const r = await pollRun('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('not_ready');
      expect(r.httpStatus).toBe(202);
    }
  });

  it('surfaces run_not_found for an unknown runId', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { ok: false, kind: 'run_not_found', runId: 'run-zzz' }));
    const r = await pollRun('run-zzz', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('run_not_found');
      expect(r.runId).toBe('run-zzz');
    }
  });

  it('does not encode the (potentially large) result in its return shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: { ok: true, hugeField: 'x'.repeat(1000), limitations: [], meta: {} },
      }),
    );
    const r = await pollRun('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) {
      expect('result' in r).toBe(false);
      expect('hugeField' in r).toBe(false);
    }
  });
});

describe('getRunResult', () => {
  it('normalizes a DONE run into an InsightResult with ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: {
          tacosDelta: -0.8,
          limitations: [],
          meta: { insightId: 'INS-ADS-BRIDGE-01', revision: 'r3', engineSha: 'x', methodologyVersion: '1', computedAt: 't' },
        },
      }),
    );
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) {
      expect(r.ok).toBe(true);
      expect(r.tacosDelta).toBe(-0.8);
      expect((r.meta as InsightResult['meta']).insightId).toBe('INS-ADS-BRIDGE-01');
    }
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/intelligence/runs/run-1');
  });

  it('surfaces not_ready as a failure when the server says so', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { ok: false, kind: 'not_ready', friendly: 'Still running.' }));
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('not_ready');
  });

  it('defensively synthesizes not_ready when the server answers ok:true with a non-DONE status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, status: 'IN_PROGRESS' }));
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('not_ready');
  });

  it('propagates engine_error for a run that finished badly', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: false, kind: 'engine_error', friendly: 'Boom.' }));
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('engine_error');
  });

  // -------------------------------------------------------------------------
  // DONE row whose nested `result` is itself a failure envelope. The server
  // signals "still running" via the not_ready failure kind at the TOP level
  // (covered above) — but once status is DONE, the *nested* result can also
  // be `{ ok:false, kind, ... }` when the insight computation itself failed.
  // getRunResult must route that through the same mapping the sync path
  // uses (mirrors run (sync)'s failure tests above), not force ok:true onto
  // it.
  // -------------------------------------------------------------------------

  it('propagates a nested bad_params failure instead of forcing ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: {
          ok: false,
          kind: 'bad_params',
          friendly: 'Bad params on this run.',
          insightId: 'INS-DUO-01',
        },
      }),
    );
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('bad_params');
      expect(r.friendly).toBe('Bad params on this run.');
      expect(r.insightId).toBe('INS-DUO-01');
      expect(exitCodeForKind(r.kind)).toBe(4);
    }
  });

  it('propagates a nested engine_error failure instead of forcing ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: { ok: false, kind: 'engine_error', message: 'divide by zero in engine' },
      }),
    );
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) {
      expect(r.kind).toBe('engine_error');
      expect(r.friendly.length).toBeGreaterThan(0); // no `friendly` sent -> defaultFriendly fallback
      expect(r.message).toBe('divide by zero in engine');
      expect(exitCodeForKind(r.kind)).toBe(1);
    }
  });

  it('coerces an unrecognized nested failure kind to unknown, same as the sync path', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: { ok: false, kind: 'some_future_kind' },
      }),
    );
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('unknown');
  });

  it('still normalizes to ok:true when `ok` is genuinely absent from the nested result', async () => {
    // Regression guard: the fix must not start requiring an explicit
    // `ok:true` on every nested success — most success payloads never echo
    // `ok` at all (see InsightResult's module doc).
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        status: 'DONE',
        result: { momOpsDelta: 42, limitations: [], meta: {} },
      }),
    );
    const r = await getRunResult('run-1', injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(false);
    if (!isIntelligenceFailure(r)) expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure envelope mapping
// ---------------------------------------------------------------------------

describe('failure envelope mapping', () => {
  it('trusts every documented server kind verbatim', async () => {
    const kinds: IntelligenceFailureKind[] = [
      'not_enrolled',
      'unknown_insight',
      'bad_params',
      'merchant_not_resolved',
      'no_data_for_period',
      'account_too_large_use_async',
      'busy',
      'engine_error',
      'not_ready',
      'run_not_found',
    ];
    for (const kind of kinds) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: false, kind }));
      const r = await catalog(injected(fetchImpl));
      expect(isIntelligenceFailure(r)).toBe(true);
      if (isIntelligenceFailure(r)) {
        expect(r.kind).toBe(kind);
        expect(r.friendly.length).toBeGreaterThan(0);
      }
    }
  });

  it('coerces an unrecognized kind to unknown rather than passing it through', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: false, kind: 'some_future_kind' }));
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('unknown');
  });

  it('falls back to a status-derived kind on a non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 503 }));
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('engine_error');
  });

  it('classifies network failures as host_unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND svc.test'), { code: 'ENOTFOUND' }));
    const r = await catalog(injected(fetchImpl));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('host_unreachable');
  });
});

// ---------------------------------------------------------------------------
// 401 → force-refresh → retry
// ---------------------------------------------------------------------------

describe('401 retry', () => {
  it('force-refreshes the token and retries once', async () => {
    const tokenProvider = async (force?: boolean) => (force ? 'fresh' : 'stale');
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      calls++;
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer stale') return jsonResponse(401, { ok: false });
      return jsonResponse(200, { ok: true, entries: [] });
    });
    const r = await catalog(injected(fetchImpl, tokenProvider));
    expect(isIntelligenceFailure(r)).toBe(false);
    expect(calls).toBe(2);
  });

  it('returns session_expired when the forced refresh throws', async () => {
    const tokenProvider = async (force?: boolean) => {
      if (force) throw new Error('Your MixShift session expired');
      return 'stale';
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { ok: false }));
    const r = await catalog(injected(fetchImpl, tokenProvider));
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('session_expired');
  });
});

// ---------------------------------------------------------------------------
// Disk-backed creds path
// ---------------------------------------------------------------------------

describe('credential resolution from disk', () => {
  it('returns not_authenticated when no creds exist', async () => {
    const r = await catalog({ dataDirOverride: testDir });
    expect(isIntelligenceFailure(r)).toBe(true);
    if (isIntelligenceFailure(r)) expect(r.kind).toBe('not_authenticated');
  });

  it('uses api_base + access_token from disk creds', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, entries: [] }));
    const r = await catalog({ dataDirOverride: testDir, fetchImpl });
    expect(isIntelligenceFailure(r)).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://mcp.mixshift.io/api/intelligence/ids');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer eyJfresh.token' });
  });
});

// ---------------------------------------------------------------------------
// exitCodeForKind — exhaustive mapping
// ---------------------------------------------------------------------------

describe('exitCodeForKind', () => {
  it('maps every IntelligenceFailureKind to a documented exit code', () => {
    // A full Record so adding a kind without deciding its exit code fails to
    // compile (mirrors the same guard in reports.test.ts).
    const table: Record<IntelligenceFailureKind, number> = {
      not_authenticated: 2,
      session_expired: 2,
      not_enrolled: 3,
      bad_params: 4,
      merchant_not_resolved: 5,
      unknown_insight: 6,
      account_too_large_use_async: 7,
      busy: 8,
      no_data_for_period: 9,
      not_ready: 10,
      run_not_found: 11,
      engine_error: 1,
      host_unreachable: 1,
      // Recognized as of mx-ops#43. Both keep exit code 1, which is exactly
      // what they returned before (they landed in `unknown`), so recognizing
      // them changes no caller's behaviour.
      decomposition_budget_exceeded: 1,
      not_implemented: 1,
      // Cross-cutting /api gate kinds (independent review on PR #161).
      insufficient_scope: 12,
      throttled: 8,
      unknown: 1,
    };
    for (const [kind, code] of Object.entries(table)) {
      expect(exitCodeForKind(kind as IntelligenceFailureKind)).toBe(code);
    }
  });

  it('exit codes are distinct except for the shared unknown-bucket (1) and auth (2)', () => {
    const kinds: IntelligenceFailureKind[] = [
      'not_enrolled',
      'bad_params',
      'merchant_not_resolved',
      'unknown_insight',
      'account_too_large_use_async',
      'busy',
      'no_data_for_period',
      'not_ready',
      'run_not_found',
    ];
    const codes = kinds.map(exitCodeForKind);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
