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
 *
 * READ-ONLY: this never refreshes a session and never writes credentials. An
 * expired access token is not renewed here; the read is deferred until some
 * other call has renewed it.
 */

import { loadCredentials } from './credentials.js';

export interface IdentityOk {
  read: true;
  /** true = the person's own sign-in verified this session; false = shared login; undefined = older gateway. */
  verified?: boolean;
  /** Org id from /v1/me (present only for a verified session). Never printed; the org name is. */
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
  /** True when the read was skipped (not failed) because the saved access token has expired. */
  deferred?: boolean;
}

export type IdentityResult = IdentityOk | IdentityFailed;

/** Short on purpose: status and doctor must not stall on a slow service. */
export const IDENTITY_TIMEOUT_MS = 3_000;
/** The access token must have at least this long left to be used as-is. */
const FRESH_MARGIN_MS = 5_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

async function getJson(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
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
  if (role && role.toLowerCase() !== 'unknown') out.role = role;
  if (Array.isArray(mfPerson.denied_scopes)) {
    const denied = mfPerson.denied_scopes.filter((s): s is string => typeof s === 'string' && s !== '');
    if (denied.length > 0) out.denied_scopes = denied;
  }
  return out;
}

/**
 * Call /v1/me (and the plugin manifest) for the stored human sign-in with the
 * stored access token. Never throws, never refreshes, never writes. When the
 * stored token has expired the read is skipped (`deferred`), because renewing
 * it would rewrite the credentials file.
 */
export async function fetchIdentity(
  dataDirOverride?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<IdentityResult> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    const d = credentials?.datahub;
    if (!d?.api_base || !d.access_token) return { read: false, reason: 'no saved sign-in' };
    if (!(Date.parse(d.expires_at) - Date.now() > FRESH_MARGIN_MS)) {
      return { read: false, deferred: true, reason: 'the saved access token has expired' };
    }
    const base = d.api_base.replace(/\/+$/, '');
    const [me, manifest] = await Promise.all([
      getJson(`${base}/v1/me`, d.access_token, fetchImpl, timeoutMs),
      getJson(`${base}/v1/manifest?surface=plugin`, d.access_token, fetchImpl, timeoutMs).catch(() => null),
    ]);
    if (me.status < 200 || me.status >= 300) {
      return { read: false, reason: `the service answered ${me.status}` };
    }
    return parseIdentity(me.json, manifest && manifest.status >= 200 && manifest.status < 300 ? manifest.json : null);
  } catch {
    return { read: false, reason: 'the service could not be reached in time' };
  }
}

/**
 * Pure: the identity statement, plus an optional second line for denied scopes.
 * Only a verified member gets the "verified member" wording. Everyone else
 * (shared login, older gateway) gets a quiet line: most orgs do not use member
 * sign-in, so "not verified" is never printed.
 */
export function formatIdentityLines(who: string, id: IdentityResult): string[] {
  if (!id.read) {
    return [
      id.deferred
        ? `Signed in as ${who} (identity: shown after your next MixShift call refreshes the sign-in)`
        : `Signed in as ${who} (your identity could not be read: ${id.reason})`,
    ];
  }
  const registered = id.org_registered !== false;
  const orgName = registered ? id.org_name : undefined;
  const role = registered ? id.role : undefined;
  let line: string;
  if (id.verified === true) {
    const bits = `verified member${orgName ? ` of ${orgName}` : ''}${role ? `, ${role}` : ''}`;
    line = `Signed in as ${who} (${bits})`;
  } else {
    // Role only when the manifest says the org is registered, so it means something.
    const bits = [orgName, orgName && id.org_registered === true ? role : undefined].filter(Boolean).join(', ');
    line = bits ? `Signed in as ${who} (${bits})` : `Signed in as ${who}`;
  }
  const lines = [line];
  if (id.denied_scopes && id.denied_scopes.length > 0) {
    lines.push(`Not allowed for you: ${id.denied_scopes.join(', ')} (set by your organization; ask an org admin)`);
  }
  return lines;
}
