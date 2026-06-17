import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

import { testDatahubConnection } from './test-connection.js';
import type { DatahubCreds } from './schema.js';

beforeEach(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('testDatahubConnection :: happy path', () => {
  it('returns claims + db_reachable=true on 200', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        user_id: '3',
        email: 'amazon+clients@dashapplications.com',
        actor: 'someone@example.com',
        client_id: 'mx-claude-plugin',
        sid: 'd620ab5c-8de9-4597-a715-9f1104ead870',
        db_reachable: true,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.db_reachable).toBe(true);
      expect(result.claims.user_id).toBe('3');
      expect(result.claims.actor).toBe('someone@example.com');
      expect(result.claims.client_id).toBe('mx-claude-plugin');
    }

    // Sent Bearer auth
    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer eyJfresh.token',
    });
  });

  it('surfaces db_reachable=false when service can reach the user but not the DB', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        user_id: '3',
        email: 'tenant@example.com',
        actor: 'person@example.com',
        client_id: 'mx-claude-plugin',
        sid: 'sid-1',
        db_reachable: false,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.db_reachable).toBe(false);
  });
});

describe('testDatahubConnection :: failure modes', () => {
  it('returns unauthorized on 401', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse(401, 'unauthorized'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unauthorized');
      expect(result.message).toMatch(/auth login/i);
    }
  });

  it('returns host_unreachable on DNS / network error', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND mcp.mixshift.io'), {
          code: 'ENOTFOUND',
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('host_unreachable');
  });

  it('returns timeout when AbortSignal trips', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('timeout');
  });

  it('returns unknown for unexpected non-OK statuses', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse(503, 'service unavailable'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await testDatahubConnection(fixture());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.raw_status).toBe(503);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@dashapplications.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}
