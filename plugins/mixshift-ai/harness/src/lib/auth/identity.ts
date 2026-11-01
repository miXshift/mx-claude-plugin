/**
 * Who am I signed in as: the identity line for `mixshift auth status` and
 * `mixshift doctor` (mx-ops#204 S6).
 *
 * Reads two gateway endpoints with the person's own bearer token:
 *   GET /v1/me                      verified (boolean), org (org id | null), scopes
 *   GET /v1/manifest?surface=plugin org.{name,registered}, person.{role_name,role,denied_scopes}
 *
 * Compatibility: a gateway that predates `verified` / `org` simply omits them.
 * An absent field is UNKNOWN, never false. A manifest failure only drops the
 * role / org name / denied scopes; a /v1/me failure makes the whole read fail
 * soft (`read: false`), and the caller prints that instead of an identity.
 * Nothing here ever prints or returns a token.
 */

import { getValidAccessToken, loadCredentials } from './credentials.js';

export interface IdentityOk {
  read: true;
  /** true = the person's own sign-in verified this session; false = typed email on a shared login; undefined = older gateway. */
  verified?: boolean;
  /** Org id from /v1/me (present only for a verified session). */
  org?: string;
  /** Org display name from the manifest. */
  org_name?: string;
  /** False = the tenant has no registered org (open default); the role is then not meaningful. */
  org_registered?: boolean;
  role?: string;
  denied_scopes?: string[];
}

export interface IdentityFailed {
  read: false;
  reason: string;
}

export type IdentityResult = IdentityOk | IdentityFailed;

const IDENTITY_TIMEOUT_MS = 8_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

async function getJson(url: string, token: string, fetchImpl: typeof fetch): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Pure: fold the two response bodies into an IdentityOk. */
export function parseIdentity(me: unknown, manifest: unknown): IdentityOk {
  const m = (me && typeof me === 'object' ? me : {}) as Record<string, unknown>;
  const out: IdentityOk = { read: true };
  if (typeof m.verified === 'boolean') out.verified = m.verified;
  const org = str(m.org);
  if (org) out.org = org;

  const mf = (manifest && typeof manifest === 'object' ? manifest : {}) as Record<string, unknown>;
  const mfOrg = (mf.org && typeof mf.org === 'object' ? mf.org : {}) as Record<string, unknown>;
  const mfPerson = (mf.person && typeof mf.person === 'object' ? mf.person : {}) as Record<string, unknown>;
  const orgName = str(mfOrg.name);
  if (orgName) out.org_name = orgName;
  if (typeof mfOrg.registered === 'boolean') out.org_registered = mfOrg.registered;
  const role = str(mfPerson.role_name) ?? str(mfPerson.role);
  if (role) out.role = role;
  if (Array.isArray(mfPerson.denied_scopes)) {
    const denied = mfPerson.denied_scopes.filter((s): s is string => typeof s === 'string' && s !== '');
    if (denied.length > 0) out.denied_scopes = denied;
  }
  return out;
}

/**
 * Call /v1/me (and the plugin manifest) for the stored human sign-in. Never
 * throws. Uses the normal token path, so an expired access token refreshes the
 * same way every other command does; a refresh refusal (for example a Google
 * re-check) comes back as the failure reason.
 */
export async function fetchIdentity(
  dataDirOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityResult> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    const apiBase = credentials?.datahub?.api_base;
    if (!apiBase) return { read: false, reason: 'no saved sign-in' };
    const token = await getValidAccessToken(dataDirOverride);
    const base = apiBase.replace(/\/+$/, '');
    const [me, manifest] = await Promise.all([
      getJson(`${base}/v1/me`, token, fetchImpl),
      getJson(`${base}/v1/manifest?surface=plugin`, token, fetchImpl).catch(() => null),
    ]);
    if (me.status < 200 || me.status >= 300) {
      return { read: false, reason: `the service answered ${me.status}` };
    }
    return parseIdentity(me.json, manifest && manifest.status >= 200 && manifest.status < 300 ? manifest.json : null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep the gateway's own refusal text (it names the cause); otherwise a short generic reason.
    return {
      read: false,
      reason: /^AUTH REQUIRED:/.test(msg) ? msg.replace(/^AUTH REQUIRED:\s*/, '') : 'the service could not be reached',
    };
  }
}

/** Pure: the one-line identity statement, plus an optional second line for denied scopes. */
export function formatIdentityLines(who: string, tenantLogin: string | undefined, id: IdentityResult): string[] {
  if (!id.read) {
    return [`Signed in as ${who} (your identity could not be read: ${id.reason})`];
  }
  const orgLabel = id.org_name ?? id.org;
  const hasOrg = id.org_registered !== false && orgLabel !== undefined;
  const role = id.org_registered === false ? undefined : id.role;
  let line: string;
  if (id.verified === true) {
    const where = hasOrg ? `member of ${orgLabel}` : 'member';
    line = `Signed in as ${who} (verified ${where}${role ? `, ${role}` : ''})`;
  } else if (id.verified === false) {
    const shared = hasOrg ? `the shared ${orgLabel} login` : tenantLogin ? `the shared ${tenantLogin} login` : 'the shared login';
    line = `Signed in as ${who} on ${shared} (typed email, not verified)`;
  } else {
    const bits = [hasOrg ? orgLabel : undefined, role].filter(Boolean).join(', ');
    const note = 'this service does not report whether your sign-in is verified';
    line = `Signed in as ${who} (${bits ? `${bits}; ` : ''}${note})`;
  }
  const lines = [line];
  if (id.denied_scopes && id.denied_scopes.length > 0) {
    lines.push(`Not allowed for you: ${id.denied_scopes.join(', ')} (set by your organization; ask an org admin)`);
  }
  return lines;
}
