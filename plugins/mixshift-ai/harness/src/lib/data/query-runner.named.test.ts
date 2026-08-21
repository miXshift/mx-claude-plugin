import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * runNamedQuery: the client half of the named query pack
 * (POST /api/named-query on mx-legacy-auth). Network is stubbed at the
 * global fetch level; credential refresh + telemetry are mocked.
 */

vi.mock('../auth/credentials.js', () => ({
  loadCredentials: vi.fn(),
  getValidAccessToken: vi.fn(),
}));

vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

import { runNamedQuery, TRANSIENT_NETWORK_RETRIES } from './query-runner.js';
import { getValidAccessToken } from '../auth/credentials.js';
import type { DatahubCreds, MysqlCreds } from '../auth/schema.js';

const getTokenMock = vi.mocked(getValidAccessToken);

const datahubCreds = {
  api_base: 'https://mcp.test',
  access_token: 'stored-token',
} as DatahubCreds;

const mysqlCreds = {
  host: 'h',
  port: 3306,
  user: 'u',
  password: 'p',
  database: 'd',
} as MysqlCreds;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue('bearer-1');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runNamedQuery', () => {
  it('POSTs {id, sellerIds, params} to /api/named-query and passes rows through', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [{ ID: 574 }], rowCount: 1, durationMs: 42, id: 'BRAIN-SELLER' }),
    );

    const result = await runNamedQuery('BRAIN-SELLER', {
      creds: datahubCreds,
      sellerIds: [573, 574],
      params: { lookback_days: 30 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mcp.test/api/named-query');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      id: 'BRAIN-SELLER',
      sellerIds: [573, 574],
      params: { lookback_days: 30 },
    });
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe(
      'Bearer bearer-1',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toEqual([{ ID: 574 }]);
      expect(result.durationMs).toBe(42);
    }
  });

  it('passes the entry revision through on success', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [], rowCount: 0, durationMs: 5, id: 'CS-28', revision: '211bbe1a' }),
    );
    const result = await runNamedQuery('CS-28', { creds: datahubCreds, params: { seller_id_list: [574] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.revision).toBe('211bbe1a');
  });

  it('surfaces missing_params (kind + names) so the runner can defer it', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          kind: 'missing_params',
          missing_params: ['window_asin_set'],
          message: "Query 'ANEG-04' is missing required param(s): window_asin_set.",
          friendly: "Query 'ANEG-04' needs param(s) this request didn't carry: window_asin_set.",
          durationMs: 0,
          id: 'ANEG-04',
        },
        400,
      ),
    );
    const result = await runNamedQuery('ANEG-04', { creds: datahubCreds, params: { seller_id: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing_params');
      expect(result.missing_params).toEqual(['window_asin_set']);
    }
  });

  it('omits sellerIds from the body when the list is empty', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, rows: [{ pong: 1 }], rowCount: 1, durationMs: 1, id: 'PING' }),
    );

    await runNamedQuery('PING', { creds: datahubCreds, sellerIds: [] });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect('sellerIds' in body).toBe(false);
  });

  it('passes server failure kinds through (unknown_query)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: false,
          kind: 'unknown_query',
          message: "No query pack entry with id 'CS-99'.",
          friendly: "'CS-99' is not a known library query.",
          durationMs: 0,
          id: 'CS-99',
        },
        404,
      ),
    );

    const result = await runNamedQuery('CS-99', { creds: datahubCreds });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown_query');
      expect(result.friendly).toContain('CS-99');
    }
  });

  it('force-refreshes and retries exactly once on a mid-session 401', async () => {
    getTokenMock.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'token_expired' }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, rows: [], rowCount: 0, durationMs: 2, id: 'PING' }),
      );

    const result = await runNamedQuery('PING', { creds: datahubCreds });

    expect(getTokenMock).toHaveBeenCalledTimes(2);
    expect(getTokenMock.mock.calls[1]![1]).toBe(true); // force refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('maps network failures to host_unreachable once retries are exhausted', async () => {
    // mockRejectedValue (not ...Once): the network is genuinely down, so
    // every replay fails too. Previously this test queued a SINGLE rejection,
    // which stopped describing the contract the moment transient retry landed.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await runNamedQuery('PING', { creds: datahubCreds });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('host_unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(TRANSIENT_NETWORK_RETRIES + 1);
  });

  it('maps network failures to host_unreachable with the doctor-pointing text (US4)', async () => {
    // mockRejectedValue, NOT ...Once (mx-ops#6): with the transient replay in
    // place a single queued rejection leaves the later attempts resolving to
    // `undefined`, and the kind degrades to 'unknown' — the assertion below
    // would then be describing the retry's absence, not the classifier.
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const result = await runNamedQuery('PING', { creds: datahubCreds });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      // No `.cause` on this bare TypeError, so classify.ts's helpers land on
      // the "unclassified transport failure" bucket rather than a specific
      // ENOTFOUND/403 branch — it still names the host and points at doctor.
      expect(result.friendly).toContain('Could not reach mcp.test');
      expect(result.friendly).toContain('mixshift doctor');
    }
  });

  it('classifies an ENOTFOUND-shaped fetch failure the same way the raw-SQL path does', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND mcp.test'), {
      code: 'ENOTFOUND',
    });
    const fetchFailed = new TypeError('fetch failed');
    (fetchFailed as { cause?: unknown }).cause = cause;
    // Same reasoning as above: every replayed attempt must reject.
    fetchMock.mockRejectedValue(fetchFailed);

    const result = await runNamedQuery('PING', { creds: datahubCreds });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toContain('Could not resolve mcp.test');
      expect(result.friendly).toContain('mixshift doctor');
    }
  });
});

/**
 * Transient-network replay (mx-ops#6).
 *
 * A caller that fans several named queries out at once opens several NEW
 * connections simultaneously; on a network where each fresh connect is slow,
 * one can exceed undici's 10s connect timeout and die while its siblings
 * succeed. Gateway metering proved the dropped request never arrived. These
 * pin the two halves of the contract: replay what never landed, never replay
 * what the service already has.
 */
describe('runNamedQuery :: transient network replay', () => {
  it('recovers when a connect failure is followed by a success', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, rows: [{ n: 1 }], rowCount: 1, durationMs: 5, id: 'PING' }),
      );

    const result = await runNamedQuery('PING', { creds: datahubCreds });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT replay a request that blew its own time budget', async () => {
    // AbortSignal.timeout rejects with a TimeoutError DOMException — the
    // service HAD the request. Replaying spends the budget again on a query
    // the server is already struggling with, so it must surface immediately.
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeoutErr);

    const result = await runNamedQuery('PING', { creds: datahubCreds });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('host_unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-retryable HTTP failure without replaying it', async () => {
    // A classified error envelope is a real answer from the service, not a
    // transport failure — one call, no replay.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, kind: 'bad_params', message: 'nope', friendly: 'Nope.' }),
    );

    const result = await runNamedQuery('PING', { creds: datahubCreds });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('bad_params');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses legacy raw-MySQL credentials with a sign-in pointer', async () => {
    const result = await runNamedQuery('BRAIN-SELLER', {
      creds: mysqlCreds,
      sellerIds: [574],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.friendly).toContain('mixshift auth login');
    }
  });
});
