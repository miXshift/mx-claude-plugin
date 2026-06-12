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

import { runNamedQuery } from './query-runner.js';
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

  it('maps network failures to host_unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await runNamedQuery('PING', { creds: datahubCreds });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('host_unreachable');
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
