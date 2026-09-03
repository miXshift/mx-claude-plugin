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

import { mkdir, readFile, rename, writeFile, chmod, unlink, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { credentialsPath } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import {
  credentialsSchema,
  newCredentials,
  type Credentials,
  type DatahubCreds,
  type ServiceCreds,
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

/**
 * Persist a `service` block (admin-issued machine credential). Merges into
 * any existing credentials file, preserving the other blocks. Also drops any
 * stale cached service token so the next call mints fresh against the new
 * credential.
 */
export async function saveService(
  service: ServiceCreds,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const existing = await loadOrInit(dataDirOverride);
  const saved = await saveCredentials(
    { ...existing, schema_version: 2, service },
    dataDirOverride,
  );
  await unlink(serviceTokenCachePath(dataDirOverride)).catch(() => {});
  return saved;
}

// ---------------------------------------------------------------------------
// getValidAccessToken — returns a non-expired access_token, refreshing if
// needed. Two layers guard the refresh:
//
//   1. An in-process in-flight singleton (`_refreshState`) so concurrent
//      callers within ONE process don't both POST /auth/refresh.
//   2. A cross-process lockfile (`refresh.lock`; see
//      refreshWithCrossProcessLock below) for what the singleton can't
//      cover: every `mixshift` CLI invocation is its own OS process, so
//      two invocations racing a refresh don't share `_refreshState` at
//      all. The lock is best-effort — lock-plumbing failure or a full
//      wait timeout degrades to proceeding without it rather than
//      failing the command, and `doRefresh`'s stale-compare guard (see
//      below) covers whatever race the lock doesn't catch.
// ---------------------------------------------------------------------------

const REFRESH_SAFETY_MARGIN_MS = 60_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;

/** Cross-process refresh lock: poll interval while waiting for another
 *  process's lock to free up. */
const REFRESH_LOCK_POLL_INTERVAL_MS = 150;
/** Cross-process refresh lock: total time to wait for a contested lock
 *  before degrading to "proceed without the lock". */
const REFRESH_LOCK_WAIT_TIMEOUT_MS = 15_000;
/** Cross-process refresh lock: a lock file older than this (by mtime) is
 *  assumed to belong to a dead/crashed holder and is taken over. */
const REFRESH_LOCK_STALE_MS = 20_000;

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
 * Throws (with a clear "Run `mixshift auth login`" message, prefixed
 * `AUTH REQUIRED:` when the server names a specific non-retryable cause —
 * see buildAuthRequiredError) when:
 *   - no datahub block is present
 *   - refresh fails with 401 AND the on-disk refresh_token still matches
 *     the one that was refused (a genuine expiry/revocation, not a
 *     losing race against a sibling process's refresh) — the datahub
 *     block is cleared as a side effect in that case only
 *
 * Concurrent calls during a refresh window all await the same refresh
 * promise — including concurrent force-refresh calls. That covers
 * concurrent callers within one process; see refreshWithCrossProcessLock
 * for the cross-process case (separate `mixshift` invocations).
 */
export async function getValidAccessToken(
  dataDirOverride?: string,
  forceRefresh: boolean = false,
): Promise<string> {
  const { credentials } = await loadCredentials(dataDirOverride);

  // Machine path: no user session on disk, but an admin-issued service
  // credential is configured. Mint (or reuse a cached) short-lived access
  // token via the OAuth client_credentials grant. The datahub block wins
  // when both exist: a human session is the more specific intent.
  if (!credentials?.datahub) {
    if (credentials?.service) {
      return getServiceAccessToken(credentials.service, dataDirOverride, forceRefresh);
    }
    throw new Error(
      'No credentials found. Run `mixshift auth login` to sign in, or ' +
        '`mixshift auth service-setup` to configure a service credential ' +
        'for unattended runs.',
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

  _refreshState.inFlight = refreshWithCrossProcessLock(
    credentials.datahub,
    dataDirOverride,
  ).finally(() => {
    _refreshState.inFlight = null;
  });

  const refreshed = await _refreshState.inFlight;
  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// Cross-process refresh lock.
//
// `_refreshState` only single-flights refreshes WITHIN one process. Every
// `mixshift` CLI invocation is its own process, so two concurrent
// invocations can each pass the in-process check above and both call
// doRefresh with the same refresh_token — the loser then 401s against the
// winner's already-rotated token. `refreshLockPath` names a sibling file
// next to credentials.json (`refresh.lock`) that serializes the refresh
// critical section across processes on this machine.
//
// This is deliberately best-effort, not a hard mutex: a stuck/unkillable
// lock must never brick the CLI. Failure to acquire (plumbing error, or a
// live contested lock that doesn't free up within the wait window)
// degrades to proceeding WITHOUT the lock — the server's rotation grace
// window and doRefresh's own stale-compare guard (below) absorb the
// residual race.
// ---------------------------------------------------------------------------

export function refreshLockPath(dataDirOverride?: string): string {
  return join(dirname(credentialsPath(dataDirOverride)), 'refresh.lock');
}

/**
 * Acquire the cross-process refresh lock.
 *
 * Returns a release function to invoke (in a `finally`) once the critical
 * section is done, or `null` when the lock could not be acquired within
 * REFRESH_LOCK_WAIT_TIMEOUT_MS (or acquisition failed outright) — callers
 * must treat `null` as "proceed without the lock", never as an error.
 */
async function acquireRefreshLock(
  dataDirOverride: string | undefined,
): Promise<(() => Promise<void>) | null> {
  const lockPath = refreshLockPath(dataDirOverride);
  const deadline = Date.now() + REFRESH_LOCK_WAIT_TIMEOUT_MS;

  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return null; // can't even ensure the auth dir exists -- degrade
  }

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
        );
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (!isFileExistsError(err)) {
        // Unexpected error (permissions, read-only fs, ...) — degrade
        // rather than fail the caller over lock plumbing.
        return null;
      }
      if (await isLockStale(lockPath)) {
        // Presumed-dead holder (crashed before releasing). Take over:
        // unlink and retry acquisition immediately.
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        return null; // waited long enough -- degrade: proceed lock-less
      }
      await new Promise((r) => setTimeout(r, REFRESH_LOCK_POLL_INTERVAL_MS));
    }
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs > REFRESH_LOCK_STALE_MS;
  } catch {
    // Disappeared between our failed open() and this check (the holder
    // released it) — not stale, just gone; the next loop iteration's
    // open() will succeed.
    return false;
  }
}

/**
 * Cross-process-safe wrapper around doRefresh. Steps:
 *
 *   1. Acquire `refresh.lock` (best-effort — see acquireRefreshLock).
 *   2. Re-read credentials from disk. If the on-disk refresh_token
 *      differs from `current.refresh_token` (the one this process loaded
 *      BEFORE waiting for the lock), a sibling process already rotated
 *      while we waited: reuse its access_token if it's still fresh,
 *      otherwise refresh using ITS refresh_token (ours is stale and
 *      would just 401).
 *   3. Otherwise refresh with our own token, same as before this lock
 *      existed.
 *
 * Always releases the lock (when held) in a `finally`.
 */
async function refreshWithCrossProcessLock(
  current: DatahubCreds,
  dataDirOverride: string | undefined,
): Promise<DatahubCreds> {
  const release = await acquireRefreshLock(dataDirOverride);
  try {
    const { credentials: onDisk } = await loadCredentials(dataDirOverride);
    const onDiskDatahub = onDisk?.datahub;
    if (onDiskDatahub && onDiskDatahub.refresh_token !== current.refresh_token) {
      const expiresAtMs = Date.parse(onDiskDatahub.expires_at);
      const fresh = expiresAtMs - Date.now() > REFRESH_SAFETY_MARGIN_MS;
      if (fresh) {
        return onDiskDatahub;
      }
      // `await` (not a bare `return`) is required here: this is inside a
      // `finally`-bearing try block, and `finally` runs on the RETURN
      // completion before the returned promise is awaited by anything.
      // Returning the bare promise leaves a window where doRefresh can
      // reject before `finally`'s own `await release()` finishes, which
      // Node reports as a rejection "handled asynchronously" (a real,
      // if usually harmless, unhandled-rejection warning) instead of
      // cleanly propagating through this function's own rejection.
      return await doRefresh(onDiskDatahub, dataDirOverride);
    }
    return await doRefresh(current, dataDirOverride);
  } finally {
    if (release) await release();
  }
}

interface RefreshResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string;
  user_id: string;
}

/** Shape of a /auth/refresh 401 body. New server: `session_expired` |
 *  `session_revoked`, with an optional `reason` and human `message`. Old
 *  server (pre-upgrade): `invalid_refresh_token`, no `message`. Loosely
 *  typed since this is an unvalidated cast of network JSON, same as
 *  RefreshResponse above. */
interface Refresh401Body {
  ok?: boolean;
  error?: string;
  reason?: string;
  message?: string;
}

async function doRefresh(
  current: DatahubCreds,
  dataDirOverride: string | undefined,
  isRetry: boolean = false,
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
    const body = await parseRefresh401Body(res);

    // Stale-compare: was the token we just sent still the one on disk at
    // the moment of refusal? A concurrent sibling process's refresh can
    // rotate the token AFTER we read it but BEFORE our own POST lands —
    // this lockfile (see refreshWithCrossProcessLock) narrows that
    // window but cannot close it entirely (rotation can still happen
    // during our own in-flight fetch). If the on-disk token has already
    // moved on, this 401 says nothing about whether the SESSION is dead
    // — only that OUR copy of the token was stale. Clearing here would
    // delete the sibling's freshly-rotated, still-valid credentials —
    // that was the bug.
    const { credentials: onDisk } = await loadCredentials(dataDirOverride);
    const onDiskDatahub = onDisk?.datahub;
    if (onDiskDatahub && onDiskDatahub.refresh_token !== current.refresh_token) {
      if (!isRetry) {
        // Retry once with the token that's actually on disk. Bounded by
        // `isRetry` so a token that keeps moving can't recurse forever.
        return doRefresh(onDiskDatahub, dataDirOverride, true);
      }
      // Already retried once and STILL raced (the on-disk token moved
      // again in between). Genuinely ambiguous — surface the auth error
      // without touching disk rather than risk deleting yet another
      // sibling's valid credentials.
      throw buildAuthRequiredError(body);
    }

    // The token we just sent is (still) the one on disk: a real
    // refusal, not a race. Safe to clear so the next command surfaces
    // the clean "run auth login" message instead of looping on a dead
    // refresh_token.
    await clearDatahub(dataDirOverride);
    throw buildAuthRequiredError(body);
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

/**
 * Best-effort parse of a /auth/refresh 401 body. Returns `null` for
 * anything that isn't a JSON object (network error page, empty body, or
 * any other unexpected shape) — callers fall back to the generic
 * pre-upgrade message in that case, same as if the server had returned
 * the old `invalid_refresh_token` shape.
 */
async function parseRefresh401Body(res: Response): Promise<Refresh401Body | null> {
  try {
    const raw = await res.text();
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Refresh401Body) : null;
  } catch {
    return null;
  }
}

/**
 * Fallback text used both for the plain pre-upgrade message and as the
 * `AUTH REQUIRED:` suffix when the server doesn't supply its own
 * `message`. Deliberately a single shared string, not one per
 * error/reason: several existing callers upstream (e.g.
 * commands/task.ts's classifyMintError, lib/amazon/reports.ts and
 * lib/intelligence/client.ts's sessionFailureFromError) still classify
 * this function's thrown message by matching "session expired" / "refresh"
 * in the text. A distinct "session was revoked" fallback would read
 * better but would silently fall through those pattern-matches — keep the
 * wording that already satisfies every existing consumer.
 */
const SESSION_EXPIRED_FALLBACK_MESSAGE =
  'Your MixShift session expired. Run `mixshift auth login` to re-authenticate.';

/**
 * Map a /auth/refresh 401 body to the error thrown up to the caller.
 *
 * New server shape (`session_expired` | `session_revoked`): loud and
 * non-retryable. The message is prefixed `AUTH REQUIRED:` so any caller —
 * or a future CLI exit-code mapping, if one is ever added — can match on
 * that prefix rather than parsing prose. The server's own `message` is
 * used verbatim when present, since it names the specific cause (replay
 * vs. revoked vs. plain expiry); otherwise the shared fallback above.
 *
 * Old server shape (`invalid_refresh_token`, no `message`) and the
 * unparsable/absent-body case: keep the original pre-upgrade message
 * verbatim, unprefixed, so a server that hasn't deployed the new refusal
 * shape yet sees no behavior change.
 */
function buildAuthRequiredError(body: Refresh401Body | null): Error {
  if (body?.error === 'session_expired' || body?.error === 'session_revoked') {
    return new Error(`AUTH REQUIRED: ${body.message ?? SESSION_EXPIRED_FALLBACK_MESSAGE}`);
  }
  return new Error(SESSION_EXPIRED_FALLBACK_MESSAGE);
}

// ---------------------------------------------------------------------------
// Replaced-session revocation.
//
// Each sign-in mints a NEW session server-side; the server deliberately does
// NOT revoke other sessions on login (the tenant login is shared, so that
// would log out coworkers). But when THIS machine re-logs in, it is about to
// overwrite its own datahub block — the one session we can revoke precisely,
// because we still hold its refresh token. Best-effort: a failure just leaves
// the old row to age out via the 30d idle expiry.
// ---------------------------------------------------------------------------

const REPLACED_SESSION_LOGOUT_TIMEOUT_MS = 5_000;

/**
 * Revoke the session this machine is about to replace. Called by the login
 * flows immediately before persisting a NEW datahub block. Never throws.
 * Returns true when the old session was revoked, false when there was
 * nothing to revoke or the call failed (both fine).
 */
export async function revokeReplacedSession(
  dataDirOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    const old = credentials?.datahub;
    if (!old?.refresh_token || !old?.api_base) return false;
    const res = await fetchImpl(`${old.api_base}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: old.refresh_token }),
      signal: AbortSignal.timeout(REPLACED_SESSION_LOGOUT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Service (machine) tokens — OAuth client_credentials grant.
//
// The service credential is STATIC (nothing rotates on use), so the only
// state to manage is a cached access token: minted tokens live ~1h and CLI
// invocations are short-lived processes, so the cache lives on disk next to
// credentials.json (mode 0600). A fresh sandbox with only the credentials
// file still works: it just mints on first use.
// ---------------------------------------------------------------------------

const SERVICE_TOKEN_SAFETY_MARGIN_MS = 60_000;
const SERVICE_MINT_TIMEOUT_MS = 30_000;

/** Exported for tests (mirror of _refreshState for the mint path). */
export const _serviceMintState: { inFlight: Promise<string> | null } = {
  inFlight: null,
};

export function serviceTokenCachePath(dataDirOverride?: string): string {
  return join(dirname(credentialsPath(dataDirOverride)), 'service-token-cache.json');
}

interface ServiceTokenCache {
  access_token: string;
  expires_at: string; // ISO-8601
  client_id: string;
  /** Attribution echoed by /oauth/token (feedback #10), persisted next to the
   *  cached token so telemetry can stamp the owning tenant + minted-by +
   *  purpose + egress IP onto service-credential events at emit time — even
   *  offline on later invocations, and even if the registry row is later
   *  deleted. Optional: absent when talking to a pre-#10 auth server. */
  attribution?: {
    owner_user_id?: string;
    minted_by?: string | null;
    purpose?: string;
    scopes?: string[];
    client_ip?: string;
  };
}

async function getServiceAccessToken(
  service: ServiceCreds,
  dataDirOverride: string | undefined,
  forceRefresh: boolean,
): Promise<string> {
  if (!forceRefresh) {
    const cached = await readServiceTokenCache(dataDirOverride);
    // client_id check: a re-pointed credential must not reuse the old token.
    if (cached && cached.client_id === service.client_id) {
      const fresh =
        Date.parse(cached.expires_at) - Date.now() > SERVICE_TOKEN_SAFETY_MARGIN_MS;
      if (fresh) return cached.access_token;
    }
  }

  if (_serviceMintState.inFlight) {
    return _serviceMintState.inFlight;
  }
  _serviceMintState.inFlight = doMintServiceToken(service, dataDirOverride).finally(() => {
    _serviceMintState.inFlight = null;
  });
  return _serviceMintState.inFlight;
}

async function doMintServiceToken(
  service: ServiceCreds,
  dataDirOverride: string | undefined,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${service.api_base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: service.client_id,
        client_secret: service.client_secret,
      }),
      signal: AbortSignal.timeout(SERVICE_MINT_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach ${service.api_base}/oauth/token: ${message}. ` +
        `Check your network or try again in a minute.`,
    );
  }

  if (res.status === 401) {
    // Static credential rejected: revoked, or rotated past the overlap
    // window. NOT cleared locally — only a tenant admin can fix this.
    throw new Error(
      'Service credential rejected (revoked, or rotated without updating ' +
        'this machine). Ask your tenant admin to check the credential at ' +
        `${service.api_base}/admin, then re-run \`mixshift auth service-setup\` ` +
        'with the current secret.',
    );
  }
  if (res.status === 429) {
    throw new Error(
      'Token endpoint rate limit hit. Wait a minute and retry.',
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/oauth/token returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const rawJson: unknown = await res.json();
  // A non-object body (null / primitive) must not TypeError on property
  // access; fall through to the clean "no access_token" error below.
  const json = (rawJson && typeof rawJson === 'object' ? rawJson : {}) as {
    access_token?: string;
    expires_in?: number;
    attribution?: ServiceTokenCache['attribution'];
  };
  if (!json.access_token) {
    throw new Error('/oauth/token returned no access_token.');
  }
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  await writeServiceTokenCache(
    {
      access_token: json.access_token,
      expires_at: new Date(Date.now() + expiresInSec * 1000).toISOString(),
      client_id: service.client_id,
      // Persist the attribution echo (feedback #10) when present so telemetry
      // can self-attribute this automation without a network call.
      ...(json.attribution ? { attribution: json.attribution } : {}),
    },
    dataDirOverride,
  );
  return json.access_token;
}

async function readServiceTokenCache(
  dataDirOverride?: string,
): Promise<ServiceTokenCache | null> {
  try {
    const raw = await readFile(serviceTokenCachePath(dataDirOverride), 'utf-8');
    const parsed = JSON.parse(raw) as ServiceTokenCache;
    if (
      typeof parsed.access_token === 'string' &&
      typeof parsed.expires_at === 'string' &&
      typeof parsed.client_id === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null; // missing or corrupt cache = just mint fresh
  }
}

async function writeServiceTokenCache(
  cache: ServiceTokenCache,
  dataDirOverride?: string,
): Promise<void> {
  const path = serviceTokenCachePath(dataDirOverride);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(cache, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, path);
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function isFileExistsError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EEXIST'
  );
}
