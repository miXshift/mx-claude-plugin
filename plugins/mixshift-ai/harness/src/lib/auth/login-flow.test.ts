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
import { request as httpRequest } from 'node:http';

import { runAuthLogin } from './login-flow.js';
import { loadCredentials } from './credentials.js';

/**
 * Simulate the browser hitting the localhost callback. Uses Node's
 * built-in `http.request` instead of `fetch` so the test bypasses any
 * fetch stub (which mocks the API endpoints, not our own localhost
 * callback server).
 */
function hitLocalhostCallback(
  redirectUri: string,
  params: { code?: string; state?: string; error?: string },
): void {
  const url = new URL(redirectUri);
  const query = new URLSearchParams();
  if (params.code !== undefined) query.set('code', params.code);
  if (params.state !== undefined) query.set('state', params.state);
  if (params.error !== undefined) query.set('error', params.error);
  const req = httpRequest(
    {
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}?${query.toString()}`,
    },
    (res) => {
      res.resume(); // drain body so the socket closes
    },
  );
  req.on('error', () => {
    // Swallow — the test only cares that the callback was triggered;
    // the response body is irrelevant.
  });
  req.end();
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-login-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// person_label validation
// ---------------------------------------------------------------------------

describe('runAuthLogin :: person_label validation', () => {
  it('throws when person_label is missing', async () => {
    // @ts-expect-error — verify runtime guard
    await expect(runAuthLogin({})).rejects.toThrow(/Missing --person-label/);
  });

  it('throws when person_label is not an email', async () => {
    await expect(
      runAuthLogin({ personLabel: 'sam' }),
    ).rejects.toThrow(/must be an email/);
  });
});

// ---------------------------------------------------------------------------
// PKCE flow
// ---------------------------------------------------------------------------

describe('runAuthLogin :: PKCE happy path', () => {
  it('exchanges the auth code and persists datahub creds', async () => {
    // Mock fetch — only /auth/exchange should be hit during PKCE.
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string, _init?: RequestInit) => {
        if (!url.endsWith('/auth/exchange')) {
          throw new Error(`unexpected fetch: ${url}`);
        }
        return jsonResponse(200, validExchangeBody());
      });
    vi.stubGlobal('fetch', mockFetch);

    // Browser-open replacement: parse the login URL, simulate the
    // browser hitting the localhost callback with code+state.
    const openedUrls: string[] = [];
    const openBrowser = async (url: string) => {
      openedUrls.push(url);
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      if (!redirectUri || !state) throw new Error('login URL missing params');
      setTimeout(
        () => hitLocalhostCallback(redirectUri, { code: 'test-auth-code', state }),
        20,
      );
    };

    const result = await runAuthLogin({
      personLabel: 'alice@acmeco.com',
      mode: 'pkce',
      apiBase: 'https://mcp.test',
      dataDirOverride: testDir,
      postLoginDiscovery: false,
      openBrowser,
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('pkce');
    expect(result.email).toBe('amazon+clients@example.com');
    expect(result.personLabel).toBe('alice@acmeco.com');
    expect(result.userId).toBe('3');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // /auth/exchange called once with the verifier + code
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [exchangeUrl, exchangeInit] = mockFetch.mock.calls[0];
    expect(exchangeUrl).toBe('https://mcp.test/auth/exchange');
    const body = JSON.parse(exchangeInit.body as string);
    expect(body.auth_code).toBe('test-auth-code');
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url

    // Login URL had the expected params
    expect(openedUrls).toHaveLength(1);
    const parsed = new URL(openedUrls[0]);
    expect(parsed.searchParams.get('client_id')).toBe('mx-claude-plugin');
    expect(parsed.searchParams.get('actor')).toBe('alice@acmeco.com');
    expect(parsed.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parsed.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);

    // Creds were persisted
    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub?.access_token).toBe('eyJtest.token');
    expect(credentials?.datahub?.person_label).toBe('alice@acmeco.com');
    expect(credentials?.datahub?.api_base).toBe('https://mcp.test');
  });
});

describe('runAuthLogin :: PKCE failure modes', () => {
  it('rejects callback with state mismatch (CSRF defense)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const openBrowser = async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      // Hit callback with WRONG state
      setTimeout(
        () =>
          hitLocalhostCallback(redirectUri, {
            code: 'test-code',
            state: 'tampered-state',
          }),
        20,
      );
    };

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'pkce',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
        openBrowser,
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('rejects callback with missing code', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const openBrowser = async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      const state = new URL(url).searchParams.get('state')!;
      setTimeout(() => hitLocalhostCallback(redirectUri, { state }), 20);
    };

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'pkce',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
        openBrowser,
      }),
    ).rejects.toThrow(/missing code or state/i);
  });

  it('surfaces a PkceBrowserOpenError when openBrowser throws (in pkce mode, no fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const openBrowser = async () => {
      throw new Error('No browser found');
    };

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'pkce',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
        openBrowser,
      }),
    ).rejects.toThrow(/Failed to open browser/);
  });

  it('throws on /auth/exchange 500', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, 'internal error'));
    vi.stubGlobal('fetch', mockFetch);

    const openBrowser = async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      const state = new URL(url).searchParams.get('state')!;
      setTimeout(
        () => hitLocalhostCallback(redirectUri, { code: 'test-code', state }),
        20,
      );
    };

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'pkce',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
        openBrowser,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

describe('runAuthLogin :: device-code happy path', () => {
  it('polls until approved, then persists datahub creds', async () => {
    // Note: the production poll interval is 3s. To keep the test fast,
    // approve on the FIRST poll rather than waiting for multiple
    // intervals. The "pending → approved" sequence is exercised
    // implicitly: device-code-init returns a 'pending' state at the
    // server, but our first poll call returns 'approved' (mocked).
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/device/init')) {
          return jsonResponse(200, {
            ok: true,
            deviceCode: 'dev-code-1',
            loginUrl: 'https://mcp.test/login?device_code=dev-code-1',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          });
        }
        if (url.endsWith('/auth/device/poll')) {
          return jsonResponse(200, {
            ...validExchangeBody(),
            state: 'approved',
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runAuthLogin({
      personLabel: 'alice@acmeco.com',
      mode: 'device',
      apiBase: 'https://mcp.test',
      dataDirOverride: testDir,
      postLoginDiscovery: false,
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('device');
    expect(result.email).toBe('amazon+clients@example.com');

    const { credentials } = await loadCredentials(testDir);
    expect(credentials?.datahub?.access_token).toBe('eyJtest.token');
    expect(credentials?.datahub?.person_label).toBe('alice@acmeco.com');
  }, 15_000);
});

describe('runAuthLogin :: device-code failure modes', () => {
  it('throws when /auth/device/init returns 500', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, 'down'));
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'device',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
      }),
    ).rejects.toThrow(/device\/init.*HTTP 500/);
  });

  it('throws when /auth/device/poll returns an error envelope', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/device/init')) {
          return jsonResponse(200, {
            ok: true,
            deviceCode: 'dev-code-1',
            loginUrl: 'https://mcp.test/login',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          });
        }
        if (url.endsWith('/auth/device/poll')) {
          return jsonResponse(401, {
            ok: false,
            error: 'device_code_unknown_or_expired',
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'device',
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
      }),
    ).rejects.toThrow(/Device-code poll failed.*device_code_unknown_or_expired/);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Auto mode fallback
// ---------------------------------------------------------------------------

describe('runAuthLogin :: auto mode', () => {
  it('falls back to device-code when PKCE browser-open fails', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/device/init')) {
          return jsonResponse(200, {
            ok: true,
            deviceCode: 'dev-code-1',
            loginUrl: 'https://mcp.test/login',
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          });
        }
        if (url.endsWith('/auth/device/poll')) {
          return jsonResponse(200, {
            ...validExchangeBody(),
            state: 'approved',
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    vi.stubGlobal('fetch', mockFetch);

    const openBrowser = async () => {
      throw new Error('No display');
    };

    const result = await runAuthLogin({
      personLabel: 'alice@acmeco.com',
      mode: 'auto',
      apiBase: 'https://mcp.test',
      dataDirOverride: testDir,
      postLoginDiscovery: false,
      openBrowser,
    });

    expect(result.mode).toBe('device');
    expect(result.email).toBe('amazon+clients@example.com');
  }, 10_000);

  it('respects --no-fallback: PKCE failure does NOT fall back', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const openBrowser = async () => {
      throw new Error('No display');
    };

    await expect(
      runAuthLogin({
        personLabel: 'alice@acmeco.com',
        mode: 'auto',
        noFallback: true,
        apiBase: 'https://mcp.test',
        dataDirOverride: testDir,
        postLoginDiscovery: false,
        openBrowser,
      }),
    ).rejects.toThrow(/Failed to open browser/);
  });

  it('uses PKCE when browser open succeeds (no fallback to device)', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/exchange')) {
          return jsonResponse(200, validExchangeBody());
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
    vi.stubGlobal('fetch', mockFetch);

    const openBrowser = async (url: string) => {
      const redirectUri = new URL(url).searchParams.get('redirect_uri')!;
      const state = new URL(url).searchParams.get('state')!;
      setTimeout(
        () => hitLocalhostCallback(redirectUri, { code: 'test-code', state }),
        20,
      );
    };

    const result = await runAuthLogin({
      personLabel: 'alice@acmeco.com',
      mode: 'auto',
      apiBase: 'https://mcp.test',
      dataDirOverride: testDir,
      postLoginDiscovery: false,
      openBrowser,
    });

    expect(result.mode).toBe('pkce');
    // /auth/device/init NEVER called
    const deviceCalls = mockFetch.mock.calls.filter(([u]) =>
      String(u).includes('/auth/device'),
    );
    expect(deviceCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validExchangeBody() {
  return {
    ok: true,
    access_token: 'eyJtest.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@example.com',
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
