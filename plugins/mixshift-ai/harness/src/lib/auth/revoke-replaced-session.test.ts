import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  revokeReplacedSession,
  saveDatahub,
  _refreshState,
} from './credentials.js';
import type { DatahubCreds } from './schema.js';

/**
 * revokeReplacedSession: best-effort logout of the session this machine is
 * about to overwrite on re-login. Precise by construction (we hold the old
 * refresh token), never throws, and a failure just leaves the old row to
 * age out via the server's 30d idle expiry.
 */

let testDir: string;

const OLD_SESSION: DatahubCreds = {
  api_base: 'https://svc.test',
  access_token: 'old-access',
  refresh_token: 'old-refresh-token',
  expires_at: '2026-06-11T00:00:00.000Z',
  refresh_expires_at: '2026-07-10T00:00:00.000Z',
  user_id: '205',
  email: 'tenant@x.com',
  person_label: 'sam@x.com',
  device_label: 'claude',
  client_id: 'mx-claude-plugin',
};

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-revoke-test-'));
  _refreshState.inFlight = null;
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

describe('revokeReplacedSession', () => {
  it('POSTs the old refresh token to the old api_base /auth/logout', async () => {
    await saveDatahub(OLD_SESSION, testDir);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const revoked = await revokeReplacedSession(testDir, fetchImpl);

    expect(revoked).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/auth/logout');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      refresh_token: 'old-refresh-token',
    });
  });

  it('returns false without calling out when no session exists (fresh sandbox)', async () => {
    const fetchImpl = vi.fn();
    const revoked = await revokeReplacedSession(testDir, fetchImpl);
    expect(revoked).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws: network failure is swallowed and reported as false', async () => {
    await saveDatahub(OLD_SESSION, testDir);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(revokeReplacedSession(testDir, fetchImpl)).resolves.toBe(false);
  });

  it('never throws: non-2xx is reported as false', async () => {
    await saveDatahub(OLD_SESSION, testDir);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(revokeReplacedSession(testDir, fetchImpl)).resolves.toBe(false);
  });
});
