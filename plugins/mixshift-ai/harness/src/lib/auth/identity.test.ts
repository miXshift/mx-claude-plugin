/**
 * Identity line + refusal copy (mx-ops#204 S6). Fake data only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchIdentity, formatIdentityLines, parseIdentity } from './identity.js';
import { insufficientScopeCopy, notAMemberCopy, reverifyCopy, isScopeRefusalReason } from './refusal-copy.js';
import { saveDatahub } from './credentials.js';

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
  it('verified member: org, role and denied scopes', async () => {
    const f = router({ me: () => json(200, { verified: true, org: 'org-1', scopes: [] }), manifest: () => json(200, MANIFEST) });
    const id = await fetchIdentity(dataDir, f);
    expect(formatIdentityLines('person@example.com', 'tenant@example.test', id)).toEqual([
      'Signed in as person@example.com (verified member of acme-co, builder)',
      'Not allowed for you: ads:write (set by your organization; ask an org admin)',
    ]);
  });

  it('typed email on a shared login: not verified', async () => {
    const f = router({
      me: () => json(200, { verified: false, org: null }),
      manifest: () => json(200, { ...MANIFEST, person: { ...MANIFEST.person, denied_scopes: [] } }),
    });
    const id = await fetchIdentity(dataDir, f);
    expect(formatIdentityLines('person@example.com', undefined, id)).toEqual([
      'Signed in as person@example.com on the shared acme-co login (typed email, not verified)',
    ]);
  });

  it('old gateway: absent verified/org read as unknown, never as false', async () => {
    const f = router({ me: () => json(200, { mixshift_tenant_id: '1', scopes: [] }) });
    const id = await fetchIdentity(dataDir, f);
    expect(id).toEqual({ read: true });
    const [line] = formatIdentityLines('person@example.com', 'tenant@example.test', id);
    expect(line).toBe('Signed in as person@example.com (this service does not report whether your sign-in is verified)');
    expect(line).not.toMatch(/not verified|typed/);
  });

  it('open (unregistered) org: no role is claimed', () => {
    const id = parseIdentity({ verified: false }, { org: { name: 'tenant-login', registered: false }, person: { role_name: 'member' } });
    expect(formatIdentityLines('person@example.com', 'tenant@example.test', id)[0]).toBe(
      'Signed in as person@example.com on the shared tenant@example.test login (typed email, not verified)',
    );
  });

  it('manifest failure drops role and denied scopes but keeps verified', async () => {
    const f = router({ me: () => json(200, { verified: true, org: 'org-1' }), manifest: () => json(500, {}) });
    const id = await fetchIdentity(dataDir, f);
    expect(formatIdentityLines('person@example.com', undefined, id)).toEqual([
      'Signed in as person@example.com (verified member of org-1)',
    ]);
  });

  it('/v1/me failure: says the identity could not be read, never prints a token', async () => {
    const f = router({ me: () => json(500, { error: 'server_error' }) });
    const id = await fetchIdentity(dataDir, f);
    expect(id).toEqual({ read: false, reason: 'the service answered 500' });
    const text = formatIdentityLines('person@example.com', undefined, id).join('\n');
    expect(text).toBe('Signed in as person@example.com (your identity could not be read: the service answered 500)');
    expect(text).not.toContain(SECRET);
    // The bearer goes only in the header, to /v1/me and the manifest.
    expect(JSON.stringify(f.mock.calls.map((c: unknown[]) => c[0]))).not.toContain(SECRET);
  });

  it('network failure fails soft', async () => {
    const f = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    expect(await fetchIdentity(dataDir, f)).toEqual({ read: false, reason: 'the service could not be reached' });
  });

  it('a re-verify refusal on refresh surfaces the gateway cause', async () => {
    await saveDatahub(creds({ expires_at: iso(-HOUR) }), dataDir);
    const f = vi.fn().mockResolvedValue(
      json(401, { ok: false, error: 'session_expired', reason: 'reverify', message: reverifyCopy() }),
    );
    vi.stubGlobal('fetch', f);
    try {
      const id = await fetchIdentity(dataDir, f as unknown as typeof fetch);
      expect(id).toEqual({ read: false, reason: reverifyCopy() });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('insufficient_scope envelope: no reason keeps the gateway text, or the new fallback', async () => {
    const { toReportFailure } = await import('../amazon/reports.js');
    expect(toReportFailure({ ok: false, kind: 'insufficient_scope', friendly: 'server text' }, 403).friendly).toBe('server text');
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
