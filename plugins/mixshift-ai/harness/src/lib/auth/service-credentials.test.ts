import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getValidAccessToken,
  saveService,
  serviceTokenCachePath,
  _refreshState,
  _serviceMintState,
} from './credentials.js';
import { serviceCredsSchema } from './schema.js';

/**
 * Service (machine) credential path: client_credentials mint, on-disk token
 * cache, forceRefresh re-mint, precedence vs the datahub block, and the
 * 401-revoked UX. fetch is stubbed globally; everything runs against a temp
 * data dir.
 */

let testDir: string;

const SERVICE = {
  api_base: 'https://svc.test',
  client_id: 'svc_abcdefgh123',
  client_secret: 's'.repeat(43),
  label: 'svc:test-cron',
};

function tokenResponse(token: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'account:read ads:read retail:read brand_analytics:read',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-service-creds-test-'));
  _refreshState.inFlight = null;
  _serviceMintState.inFlight = null;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('schema', () => {
  it('accepts a valid service block', () => {
    expect(serviceCredsSchema.parse(SERVICE).client_id).toBe('svc_abcdefgh123');
  });

  it('rejects non-svc client ids and short secrets', () => {
    expect(serviceCredsSchema.safeParse({ ...SERVICE, client_id: 'helm' }).success).toBe(false);
    expect(serviceCredsSchema.safeParse({ ...SERVICE, client_secret: 'short' }).success).toBe(false);
  });
});

describe('getValidAccessToken (service path)', () => {
  it('mints via client_credentials on first use and caches to disk', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse('minted-token-1'));
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    const token = await getValidAccessToken(testDir);
    expect(token).toBe('minted-token-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://svc.test/oauth/token');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      grant_type: 'client_credentials',
      client_id: SERVICE.client_id,
      client_secret: SERVICE.client_secret,
    });

    // Cache landed on disk with the minted token + client id.
    const cacheRaw = await readFile(serviceTokenCachePath(testDir), 'utf-8');
    const cache = JSON.parse(cacheRaw);
    expect(cache.access_token).toBe('minted-token-1');
    expect(cache.client_id).toBe(SERVICE.client_id);

    // 0600 on POSIX; informational on Windows.
    if (process.platform !== 'win32') {
      const mode = (await stat(serviceTokenCachePath(testDir))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reuses the cached token on subsequent calls (no second mint)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse('minted-token-1'));
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    await getValidAccessToken(testDir);
    const again = await getValidAccessToken(testDir);
    expect(again).toBe('minted-token-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forceRefresh re-mints even with a fresh cache', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('minted-token-1'))
      .mockResolvedValueOnce(tokenResponse('minted-token-2'));
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    await getValidAccessToken(testDir);
    const second = await getValidAccessToken(testDir, true);
    expect(second).toBe('minted-token-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the cached token is near expiry', async () => {
    const fetchMock = vi
      .fn()
      // expires_in 30s is inside the 60s safety margin, so the cache is stale immediately.
      .mockResolvedValueOnce(tokenResponse('short-lived', 30))
      .mockResolvedValueOnce(tokenResponse('minted-token-2'));
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    expect(await getValidAccessToken(testDir)).toBe('short-lived');
    expect(await getValidAccessToken(testDir)).toBe('minted-token-2');
  });

  it('saveService drops a stale cache so a re-pointed credential mints fresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse('old-cred-token'))
      .mockResolvedValueOnce(tokenResponse('new-cred-token'));
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);
    await getValidAccessToken(testDir);

    await saveService({ ...SERVICE, client_id: 'svc_other9999' }, testDir);
    expect(await getValidAccessToken(testDir)).toBe('new-cred-token');
  });

  it('401 surfaces the revoked/rotated message and keeps the block on disk', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    await expect(getValidAccessToken(testDir)).rejects.toThrow(/revoked|rotated/i);
    // Static credential: NOT cleared locally; fixing it is the admin's move.
    const again = getValidAccessToken(testDir);
    await expect(again).rejects.toThrow(/revoked|rotated/i);
  });

  it('concurrent callers share one mint (in-flight singleton)', async () => {
    let resolveFetch: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(gate);
    vi.stubGlobal('fetch', fetchMock);
    await saveService(SERVICE, testDir);

    const a = getValidAccessToken(testDir);
    const b = getValidAccessToken(testDir);
    resolveFetch!(tokenResponse('shared-token'));
    expect(await a).toBe('shared-token');
    expect(await b).toBe('shared-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('errors with both-paths guidance when no credentials exist at all', async () => {
    await expect(getValidAccessToken(testDir)).rejects.toThrow(/service-setup/);
  });
});
