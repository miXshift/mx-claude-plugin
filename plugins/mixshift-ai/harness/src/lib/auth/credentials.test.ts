import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  loadOrInit,
  saveDatahub,
  clearDatahub,
  getValidAccessToken,
  refreshLockPath,
  _refreshState,
} from './credentials.js';
import {
  newCredentials,
  type DatahubCreds,
  type MysqlCreds,
} from './schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-creds-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// loadCredentials — base behavior
// ---------------------------------------------------------------------------

describe('loadCredentials', () => {
  it('returns null when no file exists', async () => {
    const result = await loadCredentials(testDir);
    expect(result.credentials).toBeNull();
    expect(result.path).toContain('credentials');
  });

  it('throws on malformed JSON', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(join(testDir, 'auth', 'credentials'), '{not valid json');
    await expect(loadCredentials(testDir)).rejects.toThrow(/malformed/i);
  });

  it('throws on schema violation', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(
      join(testDir, 'auth', 'credentials'),
      JSON.stringify({ schema_version: 999, created_at: 'not-a-date' }),
    );
    await expect(loadCredentials(testDir)).rejects.toThrow(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// v1 → v2 migration
// ---------------------------------------------------------------------------

describe('loadCredentials :: v1 → v2 migration', () => {
  it('migrates a v1 file to v2 silently, preserving the mysql block', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    const v1Payload = {
      schema_version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      mysql: {
        host: 'db.example.com',
        port: 3306,
        user: 'tester',
        password: 'sekret',
        database: 'testdb',
      },
    };
    await writeFile(
      join(testDir, 'auth', 'credentials'),
      JSON.stringify(v1Payload, null, 2),
    );

    const { credentials } = await loadCredentials(testDir);

    // Returned in-memory shape is v2
    expect(credentials?.schema_version).toBe(2);
    // mysql block intact
    expect(credentials?.mysql?.host).toBe('db.example.com');
    expect(credentials?.mysql?.password).toBe('sekret');

    // On-disk file has been rewritten as v2
    const raw = await readFile(
      join(testDir, 'auth', 'credentials'),
      'utf-8',
    );
    const reparsed = JSON.parse(raw);
    expect(reparsed.schema_version).toBe(2);
    expect(reparsed.mysql.host).toBe('db.example.com');
  });

  it('leaves a v2 file untouched on load (no-op migration)', async () => {
    const original = newCredentials();
    original.mysql = {
      host: 'h',
      port: 3306,
      user: 'u',
      password: 'p',
      database: 'd',
    };
    await saveCredentials(original, testDir);
    const beforeRaw = await readFile(
      join(testDir, 'auth', 'credentials'),
      'utf-8',
    );

    await loadCredentials(testDir); // should not rewrite

    const afterRaw = await readFile(
      join(testDir, 'auth', 'credentials'),
      'utf-8',
    );
    expect(afterRaw).toBe(beforeRaw);
  });
});

// ---------------------------------------------------------------------------
// saveCredentials round-trip + file mode
// ---------------------------------------------------------------------------

describe('saveCredentials + round-trip', () => {
  it('round-trips a credentials object through disk', async () => {
    const creds = newCredentials();
    creds.mysql = {
      host: 'localhost',
      port: 3306,
      user: 'tester',
      password: 'sekret',
      database: 'testdb',
    };

    await saveCredentials(creds, testDir);
    const { credentials, path } = await loadCredentials(testDir);

    expect(credentials).not.toBeNull();
    expect(credentials!.schema_version).toBe(2);
    expect(credentials!.mysql?.host).toBe('localhost');
    expect(credentials!.mysql?.password).toBe('sekret');
    expect(path).toContain('credentials');
  });

  it.runIf(platform() !== 'win32')(
    'writes the credentials file with mode 0600',
    async () => {
      const creds = newCredentials();
      creds.mysql = {
        host: 'h',
        port: 3306,
        user: 'u',
        password: 'p',
        database: 'd',
      };
      const { path } = await saveCredentials(creds, testDir);
      const st = await stat(path);
      expect(st.mode & 0o777).toBe(0o600);
    },
  );
});

// ---------------------------------------------------------------------------
// loadOrInit
// ---------------------------------------------------------------------------

describe('loadOrInit', () => {
  it('returns fresh v2 skeleton when no file exists', async () => {
    const creds = await loadOrInit(testDir);
    expect(creds.schema_version).toBe(2);
    expect(creds.mysql).toBeUndefined();
    expect(creds.datahub).toBeUndefined();
  });

  it('returns existing credentials when file exists', async () => {
    const original = newCredentials();
    original.mysql = {
      host: 'h',
      port: 3306,
      user: 'u',
      password: 'p',
      database: 'd',
    };
    await saveCredentials(original, testDir);

    const loaded = await loadOrInit(testDir);
    expect(loaded.mysql?.host).toBe('h');
  });
});

// ---------------------------------------------------------------------------
// saveDatahub + clearDatahub
// ---------------------------------------------------------------------------

describe('saveDatahub', () => {
  it('writes a datahub block to disk', async () => {
    const datahub = validDatahubFixture();
    await saveDatahub(datahub, testDir);
    const { credentials } = await loadCredentials(testDir);

    expect(credentials?.datahub?.access_token).toBe(datahub.access_token);
    expect(credentials?.datahub?.person_label).toBe(datahub.person_label);
    expect(credentials?.schema_version).toBe(2);
  });

  it('preserves an existing mysql block when adding a datahub block', async () => {
    const mysqlOnly = newCredentials();
    mysqlOnly.mysql = sampleMysql();
    await saveCredentials(mysqlOnly, testDir);

    await saveDatahub(validDatahubFixture(), testDir);

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.mysql?.host).toBe('h');
    expect(credentials?.datahub).toBeDefined();
  });

  it('overwrites an existing datahub block', async () => {
    await saveDatahub(validDatahubFixture(), testDir);
    const updated = { ...validDatahubFixture(), access_token: 'new-token' };
    await saveDatahub(updated, testDir);

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub?.access_token).toBe('new-token');
  });
});

describe('clearDatahub', () => {
  it('removes the datahub block while preserving mysql', async () => {
    const mysqlOnly = newCredentials();
    mysqlOnly.mysql = sampleMysql();
    await saveCredentials(mysqlOnly, testDir);
    await saveDatahub(validDatahubFixture(), testDir);

    await clearDatahub(testDir);

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub).toBeUndefined();
    expect(credentials?.mysql?.host).toBe('h');
  });

  it('is a no-op when no datahub block exists', async () => {
    const mysqlOnly = newCredentials();
    mysqlOnly.mysql = sampleMysql();
    await saveCredentials(mysqlOnly, testDir);

    await expect(clearDatahub(testDir)).resolves.toBeUndefined();
  });

  it('is a no-op when no credentials file exists', async () => {
    await expect(clearDatahub(testDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getValidAccessToken
// ---------------------------------------------------------------------------

describe('getValidAccessToken', () => {
  it('throws when no datahub block is present', async () => {
    await expect(getValidAccessToken(testDir)).rejects.toThrow(
      /mixshift auth login/,
    );
  });

  it('returns the cached access_token when fresh (outside the safety margin)', async () => {
    const fresh = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    await saveDatahub(fresh, testDir);

    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const token = await getValidAccessToken(testDir);
    expect(token).toBe(fresh.access_token);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes when within the 60s safety margin', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() + 30 * 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const refreshed = mockRefreshResponse({ access_token: 'new-access' });
    const mockFetch = vi.fn().mockResolvedValue(refreshed);
    vi.stubGlobal('fetch', mockFetch);

    const token = await getValidAccessToken(testDir);
    expect(token).toBe('new-access');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Persisted update
    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub?.access_token).toBe('new-access');
  });

  it('clears datahub + throws on 401 from refresh (replay revocation)', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"ok":false,"error":"invalid_refresh_token"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(getValidAccessToken(testDir)).rejects.toThrow(
      /session expired.*auth login/i,
    );

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub).toBeUndefined();
  });

  it('throws (with the raw status) on non-401 server errors', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response('internal error', { status: 503 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(getValidAccessToken(testDir)).rejects.toThrow(/503/);
  });

  it('shares a single refresh across concurrent callers', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    // Defer the mock response so both callers can reach the refresh
    // step before either completes.
    let resolveRefresh!: (r: Response) => void;
    const refreshPromise = new Promise<Response>((r) => {
      resolveRefresh = r;
    });
    const mockFetch = vi.fn().mockReturnValue(refreshPromise);
    vi.stubGlobal('fetch', mockFetch);

    const callA = getValidAccessToken(testDir);
    const callB = getValidAccessToken(testDir);

    // Let both calls finish their loadCredentials (real fs read) and
    // reach the singleton-check / fetch step. A 20ms wait is generous
    // enough for the OS to satisfy the reads.
    await new Promise((r) => setTimeout(r, 20));

    // First caller set the singleton; second caller awaited it.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveRefresh(mockRefreshResponse({ access_token: 'shared-token' }));

    const [a, b] = await Promise.all([callA, callB]);
    expect(a).toBe('shared-token');
    expect(b).toBe('shared-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-process refresh lock (C1)
// ---------------------------------------------------------------------------

describe('cross-process refresh lock', () => {
  it('acquires the lock during the refresh critical section and releases it afterward', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);
    const lockPath = refreshLockPath(testDir);

    let lockExistedDuringFetch = false;
    const mockFetch = vi.fn(async () => {
      lockExistedDuringFetch = await stat(lockPath).then(
        () => true,
        () => false,
      );
      return mockRefreshResponse({ access_token: 'locked-refresh' });
    });
    vi.stubGlobal('fetch', mockFetch);

    const token = await getValidAccessToken(testDir);

    expect(token).toBe('locked-refresh');
    expect(lockExistedDuringFetch).toBe(true);
    // Released afterward.
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('takes over a stale lock (backdated mtime) instead of waiting out the full timeout', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const lockPath = refreshLockPath(testDir);
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, ts: new Date(Date.now() - 60_000).toISOString() }),
    );
    // Backdate mtime past the ~20s staleness threshold so acquisition
    // takes it over instead of polling out the full ~15s wait.
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    const mockFetch = vi
      .fn()
      .mockResolvedValue(mockRefreshResponse({ access_token: 'took-over-lock' }));
    vi.stubGlobal('fetch', mockFetch);

    const start = Date.now();
    const token = await getValidAccessToken(testDir);
    const elapsed = Date.now() - start;

    expect(token).toBe('took-over-lock');
    // Fast takeover, not the ~15s wait-then-degrade path.
    expect(elapsed).toBeLessThan(5_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-reads after acquiring a contested lock, finds a sibling's fresh token, and skips its own refresh call", async () => {
    const stale = {
      ...validDatahubFixture(),
      refresh_token: 'token-old',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const lockPath = refreshLockPath(testDir);
    await mkdir(join(testDir, 'auth'), { recursive: true });
    // Simulate another (real) process currently holding the lock.
    await writeFile(lockPath, JSON.stringify({ pid: 424242, ts: new Date().toISOString() }));

    const mockFetch = vi.fn(); // must NOT be called
    vi.stubGlobal('fetch', mockFetch);

    const siblingFinishes = async () => {
      await new Promise((r) => setTimeout(r, 220));
      // Simulate the sibling finishing its own refresh (rotating the
      // on-disk refresh_token) and then releasing the lock, partway
      // through our poll loop (which polls every ~150ms).
      await saveDatahub(
        {
          ...stale,
          refresh_token: 'token-fresh',
          access_token: 'sibling-access',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        testDir,
      );
      await rm(lockPath, { force: true });
    };

    const [token] = await Promise.all([getValidAccessToken(testDir), siblingFinishes()]);

    expect(token).toBe('sibling-access');
    expect(mockFetch).not.toHaveBeenCalled();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Stale-compare before clearing (C2)
// ---------------------------------------------------------------------------

describe('doRefresh :: stale-compare before clearing', () => {
  it('does not clear when the on-disk token already rotated past the one just refused, and retries with the on-disk token', async () => {
    const stale = {
      ...validDatahubFixture(),
      refresh_token: 'token-A',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    let callCount = 0;
    const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init.body)) as { refresh_token: string };
      if (callCount === 1) {
        expect(body.refresh_token).toBe('token-A');
        // Simulate a sibling process winning the race: it rotates the
        // on-disk refresh_token to B before our POST is refused.
        await saveDatahub(
          { ...stale, refresh_token: 'token-B', access_token: 'access-B' },
          testDir,
        );
        return new Response(
          JSON.stringify({ ok: false, error: 'invalid_refresh_token' }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      // Retry: must use the on-disk (winner's) token, not the stale one.
      expect(body.refresh_token).toBe('token-B');
      return mockRefreshResponse({
        access_token: 'new-access-from-B',
        refresh_token: 'token-C',
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const token = await getValidAccessToken(testDir);

    expect(token).toBe('new-access-from-B');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub).toBeDefined(); // NOT cleared
    expect(credentials?.datahub?.refresh_token).toBe('token-C');
  });

  it('clears on a genuine 401 (on-disk token matches the one just refused) without retrying', async () => {
    const stale = {
      ...validDatahubFixture(),
      refresh_token: 'token-A',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_refresh_token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await expect(getValidAccessToken(testDir)).rejects.toThrow(
      /session expired.*auth login/i,
    );

    // No retry -- the on-disk token matched the one that was refused.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AUTH REQUIRED mapping (C3)
// ---------------------------------------------------------------------------

describe('doRefresh :: AUTH REQUIRED mapping', () => {
  it.each(['session_expired', 'session_revoked'] as const)(
    'maps the new %s body to a loud, prefixed error carrying the server message verbatim',
    async (errorCode) => {
      const stale = {
        ...validDatahubFixture(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      };
      await saveDatahub(stale, testDir);

      const serverMessage =
        'Another sign-in replaced this session. Run `mixshift auth login` to continue.';
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: errorCode,
            reason: 'replay',
            message: serverMessage,
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      );
      vi.stubGlobal('fetch', mockFetch);

      let caught: unknown;
      try {
        await getValidAccessToken(testDir);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message.startsWith('AUTH REQUIRED:')).toBe(true);
      expect(message).toContain(serverMessage);
    },
  );

  it('falls back to a sensible AUTH REQUIRED message when the server omits `message`', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: 'session_revoked', reason: 'revoked' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', mockFetch);

    let caught: unknown;
    try {
      await getValidAccessToken(testDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message.startsWith('AUTH REQUIRED:')).toBe(true);
    expect(message).toMatch(/mixshift auth login/);
  });

  it('preserves the existing unprefixed message for the old invalid_refresh_token shape', async () => {
    const stale = {
      ...validDatahubFixture(),
      expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    await saveDatahub(stale, testDir);

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_refresh_token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    let caught: unknown;
    try {
      await getValidAccessToken(testDir);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/^Your MixShift session expired\. Run `mixshift auth login`/);
    expect(message.startsWith('AUTH REQUIRED:')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleMysql(): MysqlCreds {
  return {
    host: 'h',
    port: 3306,
    user: 'u',
    password: 'p',
    database: 'd',
  };
}

function validDatahubFixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJhbGciOiJIUzI1NiJ9.token',
    refresh_token: 'r'.repeat(48),
    expires_at: '2026-05-28T15:23:13.000Z',
    refresh_expires_at: '2026-06-26T15:23:13.000Z',
    user_id: '3',
    email: 'amazon+clients@example.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}

function mockRefreshResponse(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string;
  user_id: string;
}> = {}): Response {
  const body = {
    ok: true,
    access_token: overrides.access_token ?? 'fresh-access-token',
    refresh_token: overrides.refresh_token ?? 'fresh-refresh-token',
    expires_at:
      overrides.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    refresh_expires_at:
      overrides.refresh_expires_at ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    user_id: overrides.user_id ?? '3',
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
