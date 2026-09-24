import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Client HTTP budget expiry (mx-ops#79).
 *
 * The data-query budget is queryTimeoutMs + 5s and includes connect and
 * transfer time, so on a slow link it can expire before the service's own
 * `timeout` envelope arrives. That abort used to be reported as
 * host_unreachable with "Timed out connecting to <host>. Run mixshift
 * doctor", sending the user after a network problem that did not exist.
 * These pin both halves: a budget expiry after the statement limit reads as
 * a query timeout (kind timeout, raw_code client_budget) on /api/query,
 * /api/named-query and the pager, and a genuine connect failure still reads
 * exactly as before.
 *
 * Date.now is driven by hand so "elapsed" is exact without waiting a minute.
 */

vi.mock('../auth/credentials.js', () => ({
  loadCredentials: vi.fn(),
  getValidAccessToken: vi.fn(),
}));

const { trackSpy } = vi.hoisted(() => ({ trackSpy: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, track: trackSpy };
});

import {
  runQuery,
  runNamedQuery,
  streamQuery,
  CLIENT_BUDGET_RAW_CODE,
  TRANSIENT_NETWORK_RETRIES,
} from './query-runner.js';
import { getValidAccessToken } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';
import net from 'node:net';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const getTokenMock = vi.mocked(getValidAccessToken);

const creds = {
  api_base: 'https://mcp.test',
  access_token: 'stored-token',
} as DatahubCreds;

const fetchMock = vi.fn<typeof fetch>();

/** Manual clock: each fetch attempt advances it by what that attempt "took". */
let clock = 0;

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  fetchMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue('bearer-1');
  trackSpy.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** What AbortSignal.timeout rejects with when the budget fires. */
function budgetAbort(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/** undici's `TypeError: fetch failed` with the real reason on `.cause`. */
function fetchFailed(code: string): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return e;
}

/** A fetch attempt that takes `ms` and then rejects with `err`. */
function slowReject(ms: number, err: unknown) {
  return async () => {
    clock += ms;
    throw err;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const lastFailedEmit = () => {
  const calls = trackSpy.mock.calls.filter((c) => c[0].event_name === 'query.failed');
  return calls[calls.length - 1]![0];
};

function expectQueryTimeoutCopy(friendly: string): void {
  expect(friendly).not.toContain('mixshift doctor');
  expect(friendly).not.toContain('connecting');
  expect(friendly).not.toContain('Could not reach');
  expect(friendly).not.toContain('—'); // no em dashes in customer copy
}

describe('client budget expiry after the statement limit reads as a query timeout', () => {
  it('/api/query: kind timeout, raw_code client_budget, date-filter-first copy, no replay', async () => {
    fetchMock.mockImplementation(slowReject(65_000, budgetAbort()));

    const result = await runQuery('SELECT 1', [], { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    expect(result.friendly).toContain('did not finish within the 60s query limit');
    expect(result.friendly).toContain('date filter');
    expect(result.friendly).toContain('mixshift data describe');
    expect(result.friendly).toContain('for catalogued tables');
    expect(result.friendly).toContain('EXPLAIN');
    expect(result.friendly).toContain('narrow the date range');
    expectQueryTimeoutCopy(result.friendly);
    // The service had the request: a budget expiry is never replayed.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const emit = lastFailedEmit();
    expect(emit.error_class).toBe('timeout');
    expect(emit.payload.raw_code).toBe('client_budget');
    expect(emit.duration_ms).toBe(65_000);
  });

  it('/api/query: the budget firing while the body is still being read is the same timeout, not unknown', async () => {
    fetchMock.mockImplementation(async () => {
      clock += 62_000;
      return {
        status: 200,
        json: async () => {
          clock += 3_000;
          throw budgetAbort();
        },
      } as unknown as Response;
    });

    const result = await runQuery('SELECT 1', [], { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    expectQueryTimeoutCopy(result.friendly);
  });

  it('/api/query: a library query dispatched as sql/sproc (query_id set) gets the library copy, not EXPLAIN', async () => {
    fetchMock.mockImplementation(slowReject(65_000, budgetAbort()));

    const result = await runQuery('CALL sp_example(?, ?)', ['{}', '[]'], { creds, query_id: 'LIB-01' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    expect(result.friendly).toContain('Library query LIB-01 did not finish within the 60s query limit');
    expect(result.friendly).not.toContain('EXPLAIN');
    expectQueryTimeoutCopy(result.friendly);
    expect(lastFailedEmit().payload.raw_code).toBe('client_budget');
  });

  it('/api/named-query: kind timeout, raw_code client_budget, library-query copy', async () => {
    fetchMock.mockImplementation(slowReject(65_000, budgetAbort()));

    const result = await runNamedQuery('PING', { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('timeout');
    expect(result.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    expect(result.friendly).toContain('Library query PING did not finish within the 60s query limit');
    expect(result.friendly).toContain('Narrow the date range');
    expectQueryTimeoutCopy(result.friendly);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const emit = lastFailedEmit();
    expect(emit.error_class).toBe('timeout');
    expect(emit.query_id).toBe('PING');
    expect(emit.payload).toMatchObject({ named_query: true, raw_code: 'client_budget' });
  });

  it('/api/named-query: the copy names the caller\'s own statement limit', async () => {
    fetchMock.mockImplementation(slowReject(95_000, budgetAbort()));

    const result = await runNamedQuery('PING', { creds, queryTimeoutMs: 90_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.friendly).toContain('within the 90s query limit');
  });

  it('pager: a page that runs out the budget surfaces as the same timeout', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const sql = JSON.parse(String(init?.body)).sql as string;
      // The raw shot trips the row cap, the column probe answers, and the
      // first real page is the slow one.
      if (!sql.includes('_mx_page')) {
        return jsonResponse({ ok: false, kind: 'unknown', message: 'Query returned 60000 rows; service cap is 50000.', friendly: '' });
      }
      if (/LIMIT 1$/.test(sql)) return jsonResponse({ ok: true, rows: [{ id: 1 }], rowCount: 1, durationMs: 1 });
      clock += 65_000;
      throw budgetAbort();
    });

    const res = await streamQuery('SELECT id FROM t', [], { creds }, () => {});

    expect(res.ok).toBe(false);
    expect(res.paginated).toBe(true);
    expect(res.failure?.kind).toBe('timeout');
    expect(res.failure?.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    expectQueryTimeoutCopy(res.failure!.friendly);
  });
});

describe('genuine network failures classify exactly as before', () => {
  it('/api/query: an early connect timeout stays host_unreachable with the connect copy and no raw_code', async () => {
    fetchMock.mockImplementation(slowReject(10_000, fetchFailed('UND_ERR_CONNECT_TIMEOUT')));

    const result = await runQuery('SELECT 1', [], { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('host_unreachable');
    expect(result.raw_code).toBeUndefined();
    expect(result.friendly).toBe(
      'Timed out connecting to mcp.test. Run `mixshift doctor` if this keeps happening.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(TRANSIENT_NETWORK_RETRIES + 1);

    const emit = lastFailedEmit();
    expect(emit.error_class).toBe('host_unreachable');
    expect(emit.payload.raw_code).toBeUndefined();
  });

  it('/api/query: connect failures whose retries add up past the limit are still not a query timeout', async () => {
    // Elapsed alone never reclassifies: only the budget firing does.
    fetchMock.mockImplementation(slowReject(25_000, fetchFailed('UND_ERR_CONNECT_TIMEOUT')));

    const result = await runQuery('SELECT 1', [], { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(result.kind).toBe('host_unreachable');
    expect(result.friendly).toContain('Timed out connecting to mcp.test');
  });

  it('/api/named-query: ECONNREFUSED stays host_unreachable with the refused copy', async () => {
    fetchMock.mockImplementation(slowReject(40, fetchFailed('ECONNREFUSED')));

    const result = await runNamedQuery('PING', { creds });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('host_unreachable');
    expect(result.friendly).toBe(
      'Connection to mcp.test was refused. Run `mixshift doctor` if this keeps happening.',
    );
    expect(lastFailedEmit().payload.raw_code).toBeUndefined();
  });

  it('/api/named-query: a budget that fires BEFORE the statement limit is not called a query timeout', async () => {
    // Only reachable when a caller sets an HTTP budget shorter than the
    // statement limit; the service cannot have hit its own limit yet.
    fetchMock.mockImplementation(slowReject(10_000, budgetAbort()));

    const result = await runNamedQuery('PING', { creds, httpTimeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('host_unreachable');
    expect(result.raw_code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('known limitation: a proxy that never answers the tunnel CONNECT', () => {
  it('reads as a client_budget timeout although the request never reached the service', async () => {
    // Real fetch, real clock and a real undici proxy tunnel (the Cowork and
    // Claude Code sandbox path). undici sends the CONNECT with only the
    // request's signal and no connect timeout of its own, so the budget is
    // what ends a hung CONNECT. Only the budget's length is shortened here.
    // If this starts returning host_unreachable, the CONNECT got its own
    // bound (lib/net/proxy.ts): update the isClientBudgetExpiry comment.
    vi.unstubAllGlobals();
    vi.mocked(Date.now).mockRestore();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(500));

    const firstLines: string[] = [];
    const sockets = new Set<net.Socket>();
    const blackhole = net.createServer((s) => {
      sockets.add(s);
      s.on('error', () => {});
      s.once('data', (d) => firstLines.push(d.toString('latin1').split('\r\n')[0]!));
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(blackhole.address() as net.AddressInfo).port}`;
    const previous = getGlobalDispatcher();
    const agent = new EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '' });
    setGlobalDispatcher(agent);
    try {
      const result = await runQuery('SELECT 1', [], { creds, queryTimeoutMs: 100 });

      expect(firstLines.some((l) => l.startsWith('CONNECT mcp.test:443'))).toBe(true);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.kind).toBe('timeout');
      expect(result.raw_code).toBe(CLIENT_BUDGET_RAW_CODE);
    } finally {
      setGlobalDispatcher(previous);
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => blackhole.close(resolve));
      await agent.destroy().catch(() => {});
    }
  }, 15_000);
});
