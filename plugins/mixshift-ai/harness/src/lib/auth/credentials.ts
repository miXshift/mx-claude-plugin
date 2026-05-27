/**
 * Load and save ~/.mixshift/auth/credentials.json.
 *
 * Writes are atomic (tmp + rename) and use mode 0600 so other users on a
 * shared system can't read the credentials.
 *
 * Supports two shapes (see schema.ts):
 *
 *   - v1 (legacy): `mysql` block with raw credentials.
 *   - v2 (current): `datahub` block with {access, refresh} tokens. May
 *     coexist with `mysql` during the rollout window.
 *
 * `loadCredentials` transparently migrates v1 files → v2 (no data change,
 * just bumps schema_version + persists). Existing installs keep working
 * with zero user action.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { credentialsPath } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import {
  credentialsSchema,
  newCredentials,
  type Credentials,
  type DatahubCreds,
} from './schema.js';

export interface LoadResult {
  credentials: Credentials | null;
  path: string;
}

/**
 * Load credentials. Returns { credentials: null } if the file doesn't exist
 * yet (first-run state). Throws if the file is malformed.
 *
 * Migrates v1 → v2 silently: if `schema_version === 1`, bumps to 2 and
 * persists back. The `mysql` block is preserved untouched. Existing
 * installs see no behavior change.
 */
export async function loadCredentials(
  dataDirOverride?: string,
): Promise<LoadResult> {
  const path = credentialsPath(dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) return { credentials: null, path };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Credentials file at ${path} is malformed JSON: ${message}\n` +
        `Hint: delete the file and re-run \`mixshift auth login\` to recreate it.`,
    );
  }

  const result = credentialsSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `${formatZodError(result.error, `Credentials at ${path} are invalid`)}\n` +
        `Hint: delete the file and re-run \`mixshift auth login\` to recreate it.`,
    );
  }

  // v1 → v2 silent migration. The `mysql` block is left intact; we just
  // bump schema_version so future code can branch cleanly on v2-only
  // assumptions.
  let creds = result.data;
  if (creds.schema_version === 1) {
    creds = { ...creds, schema_version: 2 };
    await saveCredentials(creds, dataDirOverride);
  }

  return { credentials: creds, path };
}

/**
 * Save credentials atomically at mode 0600. Validates before write.
 */
export async function saveCredentials(
  credentials: Credentials,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const validated = credentialsSchema.parse(credentials);
  const path = credentialsPath(dataDirOverride);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(validated, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  // Ensure mode is 0600 even when umask interferes.
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, path);

  return { path };
}

/**
 * Convenience: load existing credentials or start a fresh skeleton.
 * Use when a flow may need to merge new fields into an existing creds set.
 */
export async function loadOrInit(
  dataDirOverride?: string,
): Promise<Credentials> {
  const { credentials } = await loadCredentials(dataDirOverride);
  return credentials ?? newCredentials();
}

/**
 * Persist a `datahub` block. Merges into any existing credentials file
 * (preserving the `mysql` block when present, so both paths can coexist
 * during the rollout window).
 */
export async function saveDatahub(
  datahub: DatahubCreds,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const existing = await loadOrInit(dataDirOverride);
  return saveCredentials(
    { ...existing, schema_version: 2, datahub },
    dataDirOverride,
  );
}

/**
 * Clear the `datahub` block from credentials, leaving `mysql` intact if
 * present. Called when /auth/refresh returns 401 (replay revocation —
 * the server has invalidated every session for this user, so the local
 * refresh_token is dead).
 */
export async function clearDatahub(
  dataDirOverride?: string,
): Promise<void> {
  const { credentials } = await loadCredentials(dataDirOverride);
  if (!credentials?.datahub) return;
  const next: Credentials = { ...credentials };
  delete next.datahub;
  await saveCredentials(next, dataDirOverride);
}

// ---------------------------------------------------------------------------
// getValidAccessToken — returns a non-expired access_token, refreshing if
// needed. The refresh is gated by an in-flight singleton so concurrent
// callers don't both POST /auth/refresh (the second call would see its
// already-rotated refresh_token and trigger the server's replay defense,
// revoking every active session for the user).
// ---------------------------------------------------------------------------

const REFRESH_SAFETY_MARGIN_MS = 60_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Module-level singleton tracking an in-flight refresh. `null` when no
 * refresh is happening. Reset in the `.finally()` of the refresh promise
 * so consecutive refreshes work independently.
 *
 * Exported only for testing the concurrent-refresh race; production
 * callers should never touch this directly.
 */
export const _refreshState: { inFlight: Promise<DatahubCreds> | null } = {
  inFlight: null,
};

/**
 * Return a non-expired access token. Refreshes the pair via
 * POST /auth/refresh when within REFRESH_SAFETY_MARGIN_MS of expiry,
 * or unconditionally when `forceRefresh: true`.
 *
 * `forceRefresh: true` is used by the query-runner after a mid-session
 * 401 from `/api/query`: the local token looked fresh but the server
 * rejected it (clock skew, server-side invalidation, etc.), so we need
 * a guaranteed-new token before retrying.
 *
 * Throws (with a clear "Run `mixshift auth login`" message) when:
 *   - no datahub block is present
 *   - refresh fails with 401 (server already revoked all sessions for
 *     this user; datahub block is cleared as a side effect)
 *
 * Concurrent calls during a refresh window all await the same refresh
 * promise — including concurrent force-refresh calls.
 */
export async function getValidAccessToken(
  dataDirOverride?: string,
  forceRefresh: boolean = false,
): Promise<string> {
  const { credentials } = await loadCredentials(dataDirOverride);
  if (!credentials?.datahub) {
    throw new Error(
      'No datahub credentials found. Run `mixshift auth login` to sign in.',
    );
  }

  if (!forceRefresh) {
    const expiresAtMs = Date.parse(credentials.datahub.expires_at);
    const fresh = expiresAtMs - Date.now() > REFRESH_SAFETY_MARGIN_MS;
    if (fresh) {
      return credentials.datahub.access_token;
    }
  }

  if (_refreshState.inFlight) {
    const refreshed = await _refreshState.inFlight;
    return refreshed.access_token;
  }

  _refreshState.inFlight = doRefresh(
    credentials.datahub,
    dataDirOverride,
  ).finally(() => {
    _refreshState.inFlight = null;
  });

  const refreshed = await _refreshState.inFlight;
  return refreshed.access_token;
}

interface RefreshResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string;
  user_id: string;
}

async function doRefresh(
  current: DatahubCreds,
  dataDirOverride: string | undefined,
): Promise<DatahubCreds> {
  let res: Response;
  try {
    res = await fetch(`${current.api_base}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refresh_token }),
      signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach ${current.api_base}/auth/refresh: ${message}. ` +
        `Check your network or try again in a minute.`,
    );
  }

  if (res.status === 401) {
    // Replay-revocation path: the server already invalidated every
    // session for this user. Clear local datahub creds so the next
    // command surfaces the friendly "Run auth login" message instead
    // of looping on the dead refresh_token.
    await clearDatahub(dataDirOverride);
    throw new Error(
      'Your MixShift session expired. Run `mixshift auth login` to ' +
        're-authenticate.',
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/auth/refresh returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await res.json()) as RefreshResponse;
  // Server returns new tokens + identity. The non-token fields on the
  // local creds (api_base, email, person_label, device_label,
  // client_id, refresh_expires_at when not rotated) carry forward.
  const updated: DatahubCreds = {
    ...current,
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at,
    refresh_expires_at: json.refresh_expires_at,
    user_id: json.user_id,
  };
  await saveDatahub(updated, dataDirOverride);
  return updated;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
