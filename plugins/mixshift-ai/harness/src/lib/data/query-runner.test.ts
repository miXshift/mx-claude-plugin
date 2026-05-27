import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runQuery } from './query-runner.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-runner-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  // Windows occasionally holds file handles longer than the test
  // teardown; one retry is sufficient for the flaky-rmdir ENOTEMPTY
  // pattern we see when datahub creds were written + read in the same
  // test. Swallow the second-try error if it lingers (the OS will
  // eventually clean the temp dir).
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Datahub: happy path
// ---------------------------------------------------------------------------

describe('runQuery :: datahub happy path', () => {
  it('returns rows from the server (passes auth_path: datahub)', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        rows: [{ ok: 1, db_time: '2026-05-27 08:23:14' }],
        rowCount: 1,
        durationMs: 460,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ ok: 1, db_time: '2026-05-27 08:23:14' }]);
      expect(result.durationMs).toBe(460);
    }

    // /api/query called once with Bearer
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mcp.mixshift.io/api/query');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${creds.access_token}`,
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.sql).toBe('SELECT 1');
  });
});

// ---------------------------------------------------------------------------
// Datahub: mid-session 401 → force-refresh → retry
// ---------------------------------------------------------------------------

describe('runQuery :: datahub 401 retry', () => {
  it('force-refreshes the token on 401 and retries once', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    let queryCalls = 0;
    let refreshCalls = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/query')) {
        queryCalls++;
        if (queryCalls === 1) return jsonResponse(401, { ok: false });
        return jsonResponse(200, {
          ok: true,
          rows: [{ ok: 1 }],
          rowCount: 1,
          durationMs: 100,
        });
      }
      if (u.endsWith('/auth/refresh')) {
        refreshCalls++;
        return jsonResponse(200, {
          ok: true,
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          user_id: '3',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(true);
    expect(queryCalls).toBe(2);
    expect(refreshCalls).toBe(1);

    // Second /api/query used the fresh token
    const secondQueryInit = mockFetch.mock.calls.find(
      ([u], i) => String(u).endsWith('/api/query') && i > 0,
    )?.[1] as RequestInit | undefined;
    expect(secondQueryInit?.headers).toMatchObject({
      Authorization: 'Bearer fresh-access',
    });
  });

  it('throws "Run mixshift auth login" when refresh + retry both 401', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/query')) return jsonResponse(401, { ok: false });
      if (u.endsWith('/auth/refresh')) {
        return jsonResponse(200, {
          ok: true,
          access_token: 'still-stale',
          refresh_token: 'r',
          expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          user_id: '3',
        });
      }
      throw new Error(`unexpected: ${u}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown'); // wrapper around the throw
      expect(result.message).toMatch(/session expired.*auth login/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Datahub: server-side classified errors pass through
// ---------------------------------------------------------------------------

describe('runQuery :: datahub error envelope', () => {
  it('passes server access_denied_table envelope through', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: false,
        kind: 'access_denied_table',
        table_name: 'campaigns',
        raw_code: 'ER_TABLEACCESS_DENIED_ERROR',
        message: "SELECT command denied to user 'foo'@'1.2.3.4' for table 'campaigns'",
        friendly:
          'Your MySQL user does not have SELECT permission on `campaigns`. ' +
          'Send a table-access request to MixShift ops.',
        durationMs: 12,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT * FROM campaigns', [], {
      dataDirOverride: testDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('access_denied_table');
      expect(result.table_name).toBe('campaigns');
      expect(result.friendly).toMatch(/SELECT permission on `campaigns`/);
      expect(result.raw_code).toBe('ER_TABLEACCESS_DENIED_ERROR');
    }
  });

  it('passes server syntax_error envelope through', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: false,
        kind: 'syntax_error',
        raw_code: 'ER_PARSE_ERROR',
        message: 'You have an error in your SQL syntax',
        friendly: 'SQL error: parse error near `WHEER`',
        durationMs: 5,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1 WHEER x=1', [], {
      dataDirOverride: testDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('syntax_error');
      expect(result.friendly).toMatch(/SQL error/);
    }
  });
});

// ---------------------------------------------------------------------------
// Datahub: network failures classify as host_unreachable
// ---------------------------------------------------------------------------

describe('runQuery :: datahub network failure', () => {
  it('classifies DNS / ECONNREFUSED as host_unreachable', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND mcp.mixshift.io'), {
        code: 'ENOTFOUND',
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toMatch(/unreachable/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Resolve preference: datahub wins when both blocks coexist
// ---------------------------------------------------------------------------

describe('runQuery :: resolveCreds preference', () => {
  it('prefers datahub when both blocks exist on disk', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    // Manually inject a mysql block alongside datahub via the
    // credentials file. (saveDatahub preserves any existing mysql block;
    // here we simulate the rollout scenario where both coexist.)
    const { saveCredentials, loadCredentials } = await import(
      '../auth/credentials.js'
    );
    const loaded = await loadCredentials(testDir);
    await saveCredentials(
      {
        ...loaded.credentials!,
        mysql: {
          host: 'h',
          port: 3306,
          user: 'u',
          password: 'p',
          database: 'd',
        },
      },
      testDir,
    );

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    // Datahub branch was taken — fetch was called (no mysql connection)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws clear error when no creds exist', async () => {
    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    // Throws inside runQuery → returns the wrapped unknown failure
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.message).toMatch(/No credentials configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDatahubFixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@dashapplications.com',
    person_label: 'sam.hager@mixshift.io',
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
