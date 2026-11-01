/**
 * Identity line + refusal copy (mx-ops#204 S6). Fake data only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchIdentity, formatIdentityLines, parseIdentity } from './identity.js';
import { insufficientScopeCopy, notAMemberCopy, reverifyCopy, isScopeRefusalReason } from './refusal-copy.js';
import { saveDatahub, loadCredentials } from './credentials.js';

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const SECRET = 'synthetic-access-token';

let dataDir: string;

function creds(over: Record<string, unknown> = {}) {
  return {
    api_base: 'https://auth.example.test',
    access_token: SECRET,
    refresh_token: 'synthetic-refresh-token',
    expires_at: iso(12 * HOUR),
    refresh_expires_at: iso(24 * 30 * HOUR),
    user_id: '1',
    email: 'tenant@example.test',
    person_label: 'person@example.com',
    device_label: 'test-device',
    client_id: 'mx-claude-plugin',
    ...over,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function router(routes: { me: () => Response | Promise<Response>; manifest?: () => Response | Promise<Response> }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/v1/me')) return routes.me();
    if (u.includes('/v1/manifest')) return routes.manifest ? routes.manifest() : json(404, {});
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const MANIFEST = {
  org: { id: 'org-1', name: 'acme-co', registered: true },
  person: { label: 'person@example.com', role: 'member', role_name: 'builder', denied_scopes: ['ads:write'] },
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-identity-'));
  await saveDatahub(creds(), dataDir);
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('identity line', () => {
  it('verified member: org name, role and denied scopes', async () => {
    const f = router({ me: () => json(200, { verified: true, org: 'org-1', scopes: [] }), manifest: () => json(200, MANIFEST) });
    const id = await fetchIdentity(dataDir, f);
    expect(formatIdentityLines('person@example.com', id)).toEqual([
      'Signed in as person@example.com (verified member of acme-co, builder)',
      'Not allowed for you: ads:write (set by your organization; ask an org admin)',
    ]);
  });

  it('shared login (verified false) is a quiet line: no "not verified", no "typed email"', async () => {
    const f = router({
      me: () => json(200, { verified: false, org: null }),
      manifest: () => json(200, { ...MANIFEST, person: { ...MANIFEST.person, denied_scopes: [] } }),
    });
    const id = await fetchIdentity(dataDir, f);
    const lines = formatIdentityLines('person@example.com', id);
    expect(lines).toEqual(['Signed in as person@example.com (acme-co, builder)']);
    expect(lines.join(' ')).not.toMatch(/not verified|typed email|does not report/);
  });

  it('old gateway: absent verified/org print nothing about verification', async () => {
    const f = router({ me: () => json(200, { mixshift_tenant_id: '1', scopes: [] }) });
    const id = await fetchIdentity(dataDir, f);
    expect(id).toEqual({ read: true });
    expect(formatIdentityLines('person@example.com', id)).toEqual(['Signed in as person@example.com']);
  });

  it('open (unregistered) org: no org name and no role', () => {
    const id = parseIdentity({ verified: false }, { org: { name: 'tenant-login', registered: false }, person: { role_name: 'member' } });
    expect(formatIdentityLines('person@example.com', id)).toEqual(['Signed in as person@example.com']);
  });

  it('never prints a role of unknown', () => {
    const id = parseIdentity({ verified: true }, { org: { name: 'acme-co', registered: true }, person: { role_name: 'unknown' } });
    expect(formatIdentityLines('person@example.com', id)).toEqual(['Signed in as person@example.com (verified member of acme-co)']);
  });

  it('manifest failure omits the org name (never a raw org id) and the role', async () => {
    const f = router({ me: () => json(200, { verified: true, org: 'org-1' }), manifest: () => json(500, {}) });
    const id = await fetchIdentity(dataDir, f);
    expect(formatIdentityLines('person@example.com', id)).toEqual(['Signed in as person@example.com (verified member)']);
  });

  it('/v1/me failure: says the identity could not be read, never prints a token', async () => {
    const f = router({ me: () => json(500, { error: 'server_error' }) });
    const id = await fetchIdentity(dataDir, f);
    expect(id).toEqual({ read: false, reason: 'the service answered 500' });
    const text = formatIdentityLines('person@example.com', id).join('\n');
    expect(text).toBe('Signed in as person@example.com (your identity could not be read: the service answered 500)');
    expect(text).not.toContain(SECRET);
    // The bearer goes only in the header, to /v1/me and the manifest.
    expect(JSON.stringify(f.mock.calls.map((c: unknown[]) => c[0]))).not.toContain(SECRET);
  });

  it('network failure fails soft', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    expect(await fetchIdentity(dataDir, f)).toEqual({ read: false, reason: 'the service could not be reached' });
  });

  it('an expired access token is never refreshed: no network call, credentials untouched', async () => {
    await saveDatahub(creds({ expires_at: iso(-HOUR) }), dataDir);
    const { path } = await loadCredentials(dataDir);
    const before = await readFile(path, 'utf-8');
    const f = vi.fn() as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const id = await fetchIdentity(dataDir, f);
    expect(id).toMatchObject({ read: false, deferred: true });
    expect(f).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf-8')).toBe(before);
    expect(formatIdentityLines('person@example.com', id)).toEqual([
      'Signed in as person@example.com (identity: shown after your next MixShift call refreshes the sign-in)',
    ]);
  });

  it('a slow service does not stall past the timeout', async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      }),
    ) as unknown as typeof fetch;
    const t0 = Date.now();
    const id = await fetchIdentity(dataDir, hang, 100);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(id).toEqual({ read: false, reason: 'the service could not be reached' });
  });
});

describe('refusal copy', () => {
  it('insufficient_scope with a reason names it', () => {
    expect(insufficientScopeCopy('member_ceiling', ['ads:write'])).toContain('Your organization has turned this permission off for you (ads:write)');
    expect(insufficientScopeCopy('role')).toContain('Your role in your organization does not include this');
    expect(insufficientScopeCopy('credential_kind')).toContain('Sign in as yourself');
  });

  it('insufficient_scope without a reason no longer claims signed-in users hold the scope', () => {
    const t = insufficientScopeCopy(undefined, ['ads:write']);
    expect(t).toContain('may be off for you in your organization');
    expect(t).toContain('ask your organization admin');
    expect(t).not.toMatch(/Signed-in user sessions hold it/i);
    expect(insufficientScopeCopy('something_new')).toBe(insufficientScopeCopy());
  });

  it('scope list is allowlisted: odd strings are dropped', () => {
    expect(insufficientScopeCopy(undefined, ['ads:write', 'x y; rm -rf', 7])).toContain('(ads:write)');
    expect(insufficientScopeCopy(undefined, ['x y; rm -rf'])).not.toContain('rm -rf');
  });

  it('not_a_member names the org when sent, falls back when not', () => {
    expect(notAMemberCopy('acme-co')).toBe(
      'You are not a member of acme-co. Ask an owner or admin of acme-co to add you, then sign in again.',
    );
    expect(notAMemberCopy()).toContain('not a member of your organization');
  });

  it('reverify says to sign in again, with Google if the org uses it', () => {
    expect(reverifyCopy()).toContain('sign in again, with Google if your organization uses it');
  });

  it('reason guard', () => {
    expect(isScopeRefusalReason('role')).toBe(true);
    expect(isScopeRefusalReason('nope')).toBe(false);
    expect(isScopeRefusalReason(undefined)).toBe(false);
  });
});

describe('refusal copy wired into the gateway envelopes', () => {
  it('insufficient_scope envelope: reason present names the cause', async () => {
    const { toReportFailure } = await import('../amazon/reports.js');
    const f = toReportFailure(
      { ok: false, kind: 'insufficient_scope', reason: 'member_ceiling', required_scopes: ['ads:write'], friendly: 'server text' },
      403,
    );
    expect(f.kind).toBe('insufficient_scope');
    expect(f.friendly).toContain('Your organization has turned this permission off for you (ads:write)');
  });

  it('insufficient_scope envelope: no reason uses the plugin copy, not the gateway text', async () => {
    const { toReportFailure } = await import('../amazon/reports.js');
    // The gateway's own text is never passed through: older gateways still say signed-in sessions hold the scope.
    const stale = toReportFailure(
      { ok: false, kind: 'insufficient_scope', friendly: 'Delegated user sessions hold it', required_scope: 'ads:write' },
      403,
    ).friendly;
    expect(stale).not.toContain('Delegated');
    expect(stale).toContain('(ads:write)');
    expect(stale).toContain('granted when');
    const bare = toReportFailure({ ok: false, kind: 'insufficient_scope' }, 403).friendly;
    expect(bare).toContain('may be off for you in your organization');
    expect(bare).not.toMatch(/Signed-in user sessions hold it/i);
  });

  it('reverify on refresh: gateway message is used; without one, the plugin copy', async () => {
    for (const body of [
      { ok: false, error: 'session_expired', reason: 'reverify', message: 'gateway words' },
      { ok: false, error: 'session_expired', reason: 'reverify' },
    ]) {
      await saveDatahub(creds({ expires_at: iso(-HOUR) }), dataDir);
      const { getValidAccessToken } = await import('./credentials.js');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, body)));
      try {
        await expect(getValidAccessToken(dataDir)).rejects.toThrow(
          body.message ? 'AUTH REQUIRED: gateway words' : `AUTH REQUIRED: ${reverifyCopy()}`,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});

describe('device login instructions', () => {
  it('shows the link and the code as its own step', async () => {
    const { deviceLoginInstructions } = await import('./login-flow.js');
    const t = deviceLoginInstructions('https://auth.example.test/login?device_code=ABCD-EFGH', 'ABCD-EFGH');
    expect(t).toContain('1. Open this URL in any browser:\n     https://auth.example.test/login?device_code=ABCD-EFGH');
    expect(t).toContain('2. If the page asks for a code, type: ABCD-EFGH');
    expect(t).toContain('3. Sign in and confirm the device on the page.');
  });
});

describe('review round 2', () => {
  it('shipping:write gateway text passes through; only the stale claim is replaced', async () => {
    const { toReportFailure } = await import('../amazon/reports.js');
    const shipping = 'Only service credentials hold shipping:write. Nothing was sent to Amazon.';
    expect(toReportFailure({ ok: false, kind: 'insufficient_scope', friendly: shipping }, 403).friendly).toBe(shipping);
    const stale = toReportFailure(
      { ok: false, kind: 'insufficient_scope', friendly: 'Writes need ads:write. Delegated user sessions hold it.' },
      403,
    ).friendly;
    expect(stale).not.toContain('Delegated');
    expect(stale).toContain('may be off for you in your organization');
    // A known reason still wins over any gateway text.
    expect(
      toReportFailure({ ok: false, kind: 'insufficient_scope', reason: 'role', friendly: shipping }, 403).friendly,
    ).toContain('Your role in your organization');
  });

  it('a 401 from /v1/me with a fresh token suggests signing in again if it keeps happening', async () => {
    const f = router({ me: () => json(401, {}) });
    const id = await fetchIdentity(dataDir, f);
    expect(id).toMatchObject({ read: false });
    expect(formatIdentityLines('person@example.com', id)[0]).toContain('run `mixshift auth login` if this keeps happening');
  });

  it('no saved sign-in (ended) says the sign-in ended, not "could not be read"', async () => {
    const { clearDatahub } = await import('./credentials.js');
    await clearDatahub(dataDir);
    const id = await fetchIdentity(dataDir, vi.fn() as unknown as typeof fetch);
    expect(id).toMatchObject({ read: false, ended: true });
    expect(formatIdentityLines('person@example.com', id)).toEqual([
      'Your sign-in ended. Run `mixshift auth login` to sign in again.',
    ]);
  });
});
