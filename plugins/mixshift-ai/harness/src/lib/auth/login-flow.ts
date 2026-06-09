/**
 * Token-based login against the mx-legacy-auth MCP service.
 *
 * Two flows, plus auto-detect:
 *
 *   PKCE (Desktop / Cowork / Claude Code)
 *     Generates verifier+challenge+state. Spins up a localhost HTTP
 *     server on an ephemeral port. Opens the browser to the service's
 *     /login page. The user signs in; the page redirects to
 *     http://127.0.0.1:<port>/callback?code=&state=. We verify state,
 *     POST /auth/exchange with {auth_code, code_verifier}, persist the
 *     returned tokens.
 *
 *   Device-code (headless / claude.ai / WSL without DISPLAY)
 *     POST /auth/device/init to get a deviceCode + loginUrl. Print the
 *     URL for the user to open on any machine. Poll /auth/device/poll
 *     every 3s until state='approved' or timeout. On approved, the
 *     response carries the same tokens as PKCE.
 *
 *   Auto (default)
 *     Try PKCE first. If `open()` throws (no browser available — common
 *     in headless WSL / containers / claude.ai), fall back to
 *     device-code with a one-line stderr notice. Pass --no-fallback to
 *     turn auto into hard PKCE for dev/debug.
 *
 * Successful login saves `datahub` creds via saveDatahub, fires a
 * best-effort post-login brand discovery (parity with the legacy
 * auth-setup chat flow), and emits AuthLoginCompleted telemetry.
 *
 * Notes for callers:
 *   - person_label is REQUIRED. There is no chat-driven prompt here;
 *     callers (CLI / chat skill) must supply it via flag or persisted
 *     value. Rationale: one tenant credential is shared across many
 *     employees; person_label lets admins see who did what.
 *   - device_label defaults to os.hostname().
 *   - client_id resolves via resolveClientId() (CLI flag > env > default).
 *   - api_base defaults to https://mcp.mixshift.io.
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';

import { saveDatahub } from './credentials.js';
import { resolveClientId } from './client-id.js';
import type { DatahubCreds } from './schema.js';
import { loadProfile } from '../profile/load.js';
import { saveProfile } from '../profile/save.js';
import { track, EventName } from '../telemetry/index.js';
import {
  runDiscoveryAndPersist,
  countByActivity,
} from '../clients/index.js';
import { DEFAULT_API_BASE } from '../net/api-base.js';

const PKCE_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const DEVICE_POLL_INTERVAL_MS = 3_000;
const DEVICE_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const HTTP_REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunAuthLoginOptions {
  apiBase?: string;
  personLabel: string;
  deviceLabel?: string;
  clientId?: string;
  mode?: 'pkce' | 'device' | 'auto';
  /** Auto-mode debug flag — when true, PKCE failure surfaces directly
   *  instead of falling back to device-code. */
  noFallback?: boolean;
  dataDirOverride?: string;
  /** Discovery fires after a successful login by default; pass false
   *  to skip (used by tests + future surface flags). */
  postLoginDiscovery?: boolean;
  /** Override the browser-opening function. Defaults to the `open`
   *  package. Tests use this to capture the login URL and simulate
   *  the browser→localhost callback without launching a real browser. */
  openBrowser?: (url: string) => Promise<void>;
}

export interface AuthLoginResult {
  ok: true;
  mode: 'pkce' | 'device';
  apiBase: string;
  personLabel: string;
  email: string;
  userId: string;
  clientId: string;
  durationMs: number;
}

interface ResolvedOptions {
  apiBase: string;
  personLabel: string;
  deviceLabel: string;
  clientId: string;
  mode: 'pkce' | 'device' | 'auto';
  noFallback: boolean;
  dataDirOverride?: string;
  postLoginDiscovery: boolean;
  openBrowser: (url: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Public two-phase device-code surface (for chat orchestration)
// ---------------------------------------------------------------------------
//
// Chat hosts like Cowork have a ~45s ceiling on Bash tool invocations.
// The blocking `runAuthLogin` flow doesn't fit — the user takes longer than
// that to switch tabs, sign in, come back. So we expose the device-code
// flow as two short-lived primitives the chat skill can orchestrate:
//
//   initDeviceFlow()  → returns {device_code, login_url, expires_at}, exits.
//                       The chat skill shows the URL to the user and waits
//                       for them to confirm in chat.
//   pollDeviceFlow()  → polls /auth/device/poll for up to maxWaitMs (default
//                       30s). Returns {state, result?}. On approved, saves
//                       datahub creds + fires post-login discovery + emits
//                       telemetry, same side effects as runAuthLogin.
//                       The chat skill re-calls with the same device_code if
//                       state was still 'pending'.

export interface InitDeviceFlowOptions {
  apiBase?: string;
  personLabel: string;
  deviceLabel?: string;
  clientId?: string;
}

export interface InitDeviceFlowResult {
  device_code: string;
  login_url: string;
  expires_at: string;
  /** Echoed back so the chat skill doesn't have to re-pass these to poll. */
  api_base: string;
  person_label: string;
  device_label: string;
  client_id: string;
}

export async function initDeviceFlow(
  opts: InitDeviceFlowOptions,
): Promise<InitDeviceFlowResult> {
  if (!opts.personLabel) {
    throw new Error(
      'Missing --person-label. Pass your work email so we can attribute ' +
        'your session (e.g. --person-label alice@marpartners.com).',
    );
  }
  if (!isLikelyEmail(opts.personLabel)) {
    throw new Error(
      `--person-label must be an email address (got "${opts.personLabel}").`,
    );
  }
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const deviceLabel = opts.deviceLabel ?? hostname();
  const clientId = resolveClientId(opts.clientId);

  const init = await deviceInitFetch(
    apiBase,
    deviceLabel,
    opts.personLabel,
    clientId,
  );

  return {
    device_code: init.deviceCode,
    login_url: init.loginUrl,
    expires_at: init.expiresAt,
    api_base: apiBase,
    person_label: opts.personLabel,
    device_label: deviceLabel,
    client_id: clientId,
  };
}

export interface PollDeviceFlowOptions {
  apiBase?: string;
  deviceCode: string;
  personLabel: string;
  deviceLabel?: string;
  clientId?: string;
  dataDirOverride?: string;
  /** Maximum wall-clock time to keep polling before returning 'pending'.
   *  Default 30s — fits comfortably under Cowork's Bash tool timeout. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  postLoginDiscovery?: boolean;
}

export interface PollDeviceFlowResult {
  state: 'pending' | 'approved' | 'expired';
  /** Set when state === 'approved'. Carries the same shape as
   *  runAuthLogin's result; tokens are already persisted to disk. */
  result?: AuthLoginResult;
  /** Set when state === 'expired' or on poll-error envelope; the chat
   *  skill should restart the flow from initDeviceFlow. */
  error?: string;
}

export async function pollDeviceFlow(
  opts: PollDeviceFlowOptions,
): Promise<PollDeviceFlowResult> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const deviceLabel = opts.deviceLabel ?? hostname();
  const clientId = resolveClientId(opts.clientId);
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? DEVICE_POLL_INTERVAL_MS;
  const postLoginDiscovery = opts.postLoginDiscovery ?? true;

  const startedAt = Date.now();
  // First poll fires immediately (no initial wait) so a fast user gets
  // the answer right away.
  let firstAttempt = true;
  while (Date.now() - startedAt < maxWaitMs) {
    if (!firstAttempt) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    firstAttempt = false;

    const poll = await devicePoll(apiBase, opts.deviceCode);
    if (!poll.ok) {
      return {
        state: 'expired',
        error: poll.error,
      };
    }
    if (poll.state === 'approved') {
      // Build a ResolvedOptions-shaped view so we can reuse the
      // existing helpers (toDatahubCreds, post-login discovery).
      const resolved: ResolvedOptions = {
        apiBase,
        personLabel: opts.personLabel,
        deviceLabel,
        clientId,
        mode: 'device',
        noFallback: false,
        dataDirOverride: opts.dataDirOverride,
        postLoginDiscovery,
        openBrowser: defaultOpenBrowser,
      };
      const datahub = toDatahubCreds(resolved, poll);
      await saveDatahub(datahub, opts.dataDirOverride);

      const result: AuthLoginResult = {
        ok: true,
        mode: 'device',
        apiBase,
        personLabel: opts.personLabel,
        email: poll.email,
        userId: poll.user_id,
        clientId: poll.client_id ?? clientId,
        durationMs: Date.now() - startedAt,
      };

      await track(
        {
          event_name: EventName.AuthLoginCompleted,
          outcome: 'ok',
          duration_ms: result.durationMs,
          email: result.email,
          person_label: result.personLabel,
          payload: {
            mode: 'device',
            api_base: apiBase,
            client_id: clientId,
            orchestration: 'two_phase_chat',
          },
        },
        opts.dataDirOverride,
      );

      // Link install_id ↔ email server-side. Fires alongside
      // AuthLoginCompleted so the install→email linkage is visible in
      // both Discord and analytics for every successful auth, including
      // the chat-driven device-code path (which previously skipped this
      // emission and left install_ids stuck as "anonymous" in fan-out).
      await track(
        {
          event_name: EventName.UserIdentified,
          email: result.email,
          person_label: result.personLabel,
        },
        opts.dataDirOverride,
      );

      // Mirror person_label into profile.user.email — see
      // syncProfileEmailBestEffort docstring for the why.
      await syncProfileEmailBestEffort(
        result.personLabel,
        opts.dataDirOverride,
      );

      if (postLoginDiscovery) {
        await postLoginDiscoverBestEffort(
          opts.dataDirOverride,
          result.email,
          result.personLabel,
        );
      }

      return { state: 'approved', result };
    }
    // state === 'pending'; loop until maxWaitMs.
  }

  return { state: 'pending' };
}

async function deviceInitFetch(
  apiBase: string,
  deviceLabel: string,
  personLabel: string,
  clientId: string,
): Promise<DeviceInitResponse> {
  const res = await fetch(`${apiBase}/auth/device/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_label: deviceLabel,
      actor_hint: personLabel,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/auth/device/init returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as DeviceInitResponse;
}

/**
 * Open a URL in the user's default browser via the OS-native command.
 * Inlined here instead of pulling in the `open` npm package, which
 * declares its own top-level `var __dirname` that collides with our
 * esbuild bundle banner.
 *
 * Shell quoting: URLs we generate are URL-encoded via URLSearchParams,
 * so there's no injection vector even with shell:true. The quoted form
 * (`"<url>"`) protects against ampersands and spaces.
 */
const defaultOpenBrowser = async (url: string): Promise<void> => {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"` // Windows: cmd.exe builtin; "" is required as title
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  const child = spawn(cmd, {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  // Don't fail the call if the spawn errors asynchronously; the caller's
  // callback timeout handles "browser never opened" anyway. But surface
  // immediate failures (command not found, EACCES, etc.) so auto-mode
  // can fall back to device-code.
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    // Spawn succeeds the moment the OS hands us a pid. Resolve on the
    // next tick so an immediate-error handler has had a chance to fire.
    setImmediate(() => resolve());
  });
  child.unref();
};

/**
 * Run the login flow. Saves credentials + fires post-login discovery
 * + emits telemetry on success. Throws (with a user-facing message)
 * on failure.
 */
export async function runAuthLogin(
  opts: RunAuthLoginOptions,
): Promise<AuthLoginResult> {
  const startedAt = Date.now();

  if (!opts.personLabel) {
    throw new Error(
      'Missing --person-label. Pass your work email so we can attribute ' +
        'your session (e.g. --person-label alice@marpartners.com). ' +
        'Required because one MixShift tenant credential is shared across ' +
        'many employees; person_label lets admins see who did what.',
    );
  }
  if (!isLikelyEmail(opts.personLabel)) {
    throw new Error(
      `--person-label must be an email address (got "${opts.personLabel}").`,
    );
  }

  const resolved: ResolvedOptions = {
    apiBase: opts.apiBase ?? DEFAULT_API_BASE,
    personLabel: opts.personLabel,
    deviceLabel: opts.deviceLabel ?? hostname(),
    clientId: resolveClientId(opts.clientId),
    mode: opts.mode ?? 'auto',
    noFallback: opts.noFallback ?? false,
    dataDirOverride: opts.dataDirOverride,
    postLoginDiscovery: opts.postLoginDiscovery ?? true,
    openBrowser: opts.openBrowser ?? defaultOpenBrowser,
  };

  let result: AuthLoginResult;
  let chosenMode: 'pkce' | 'device';

  if (resolved.mode === 'pkce') {
    chosenMode = 'pkce';
    result = await runPkceLogin(resolved);
  } else if (resolved.mode === 'device') {
    chosenMode = 'device';
    result = await runDeviceLogin(resolved);
  } else {
    // auto: PKCE first, device-code fallback on browser-open failure
    try {
      chosenMode = 'pkce';
      result = await runPkceLogin(resolved);
    } catch (err) {
      if (resolved.noFallback || !isPkceBrowserOpenError(err)) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `\nBrowser didn't respond (${msg}). ` +
          `Switching to device-code flow. ` +
          `Open the URL below on any machine to complete login.\n\n`,
      );
      chosenMode = 'device';
      result = await runDeviceLogin(resolved);
    }
  }

  result.durationMs = Date.now() - startedAt;

  await track(
    {
      event_name: EventName.AuthLoginCompleted,
      outcome: 'ok',
      duration_ms: result.durationMs,
      email: result.email,
      person_label: result.personLabel,
      payload: {
        mode: chosenMode,
        api_base: resolved.apiBase,
        client_id: resolved.clientId,
      },
    },
    resolved.dataDirOverride,
  );

  // Link install_id ↔ email server-side. Fires alongside
  // AuthLoginCompleted so the install→email linkage is visible in both
  // Discord and analytics for every successful auth. Moved here from
  // commands/auth.ts so the chat-driven device-code path (auth
  // device-init + device-poll, via pollDeviceFlow above) also emits it.
  await track(
    {
      event_name: EventName.UserIdentified,
      email: result.email,
      person_label: result.personLabel,
    },
    resolved.dataDirOverride,
  );

  // Mirror person_label into profile.user.email so downstream commands
  // (telemetry, `mixshift feedback`, etc.) find a populated email.
  await syncProfileEmailBestEffort(
    result.personLabel,
    resolved.dataDirOverride,
  );

  if (resolved.postLoginDiscovery) {
    await postLoginDiscoverBestEffort(
      resolved.dataDirOverride,
      result.email,
      result.personLabel,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// PKCE flow
// ---------------------------------------------------------------------------

interface PkceBundle {
  verifier: string;
  challenge: string;
  state: string;
}

async function runPkceLogin(opts: ResolvedOptions): Promise<AuthLoginResult> {
  const pkce = generatePkce();
  const { server, port, callbackPromise } = await startCallbackServer(
    pkce.state,
  );

  try {
    const callbackUrl = `http://127.0.0.1:${port}/callback`;
    const loginUrl = buildLoginUrl(opts, pkce, callbackUrl);

    try {
      await opts.openBrowser(loginUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PkceBrowserOpenError(`Failed to open browser: ${msg}`);
    }

    process.stdout.write(
      `\nOpening MixShift sign-in in your browser. ` +
        `If it doesn't open automatically, visit:\n  ${loginUrl}\n\n`,
    );

    const { code } = await callbackPromise;
    const exchanged = await exchangeAuthCode(
      opts.apiBase,
      code,
      pkce.verifier,
    );

    const datahub = toDatahubCreds(opts, exchanged);
    await saveDatahub(datahub, opts.dataDirOverride);

    return {
      ok: true,
      mode: 'pkce',
      apiBase: opts.apiBase,
      personLabel: opts.personLabel,
      email: exchanged.email,
      userId: exchanged.user_id,
      clientId: exchanged.client_id ?? opts.clientId,
      durationMs: 0,
    };
  } finally {
    await closeServer(server);
  }
}

function generatePkce(): PkceBundle {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(
    createHash('sha256').update(verifier).digest(),
  );
  const state = base64url(randomBytes(32));
  return { verifier, challenge, state };
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildLoginUrl(
  opts: ResolvedOptions,
  pkce: PkceBundle,
  redirectUri: string,
): string {
  // Both URL params (pre-fill the login form) AND body fields (sent on
  // POST /auth/login by the page) carry these — server validates body
  // is authoritative; URL is for the user-visible confirmation chrome.
  const params = new URLSearchParams({
    challenge: pkce.challenge,
    state: pkce.state,
    device_label: opts.deviceLabel,
    actor: opts.personLabel,
    client_id: opts.clientId,
    redirect_uri: redirectUri,
  });
  return `${opts.apiBase}/login?${params.toString()}`;
}

interface CallbackResult {
  code: string;
}

interface CallbackServerHandle {
  server: Server;
  port: number;
  callbackPromise: Promise<CallbackResult>;
}

function startCallbackServer(
  expectedState: string,
): Promise<CallbackServerHandle> {
  return new Promise((resolve, reject) => {
    let resolveCallback: (r: CallbackResult) => void = () => {};
    let rejectCallback: (e: Error) => void = () => {};

    const callbackPromise = new Promise<CallbackResult>((res, rej) => {
      resolveCallback = res;
      rejectCallback = rej;
    });

    const timeoutId = setTimeout(() => {
      rejectCallback(
        new Error(
          `Login timed out after ${PKCE_CALLBACK_TIMEOUT_MS / 60000} minutes. ` +
            `The browser callback never reached the local server.`,
        ),
      );
    }, PKCE_CALLBACK_TIMEOUT_MS);
    timeoutId.unref();

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        respondHtml(
          res,
          400,
          `<h1>Login failed</h1><p>${escapeHtml(error)}</p>`,
        );
        clearTimeout(timeoutId);
        rejectCallback(new Error(`Login flow returned error: ${error}`));
        return;
      }

      if (!code || !state) {
        respondHtml(
          res,
          400,
          `<h1>Bad request</h1><p>Missing code or state.</p>`,
        );
        clearTimeout(timeoutId);
        rejectCallback(new Error('Callback missing code or state'));
        return;
      }

      if (state !== expectedState) {
        respondHtml(
          res,
          400,
          `<h1>State mismatch</h1>` +
            `<p>This callback does not match the login flow that started here. ` +
            `Possible CSRF; ignoring.</p>`,
        );
        clearTimeout(timeoutId);
        rejectCallback(
          new Error('State mismatch on callback (CSRF defense triggered)'),
        );
        return;
      }

      respondHtml(
        res,
        200,
        `<h1>Login complete</h1>` +
          `<p>You can close this window and return to your terminal.</p>`,
      );
      clearTimeout(timeoutId);
      resolveCallback({ code });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not determine local callback port'));
        return;
      }
      resolve({ server, port: addr.port, callbackPromise });
    });

    server.on('error', (err) => reject(err));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function respondHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>MixShift</title>${body}`);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

interface ExchangeResponse {
  ok: true;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string;
  user_id: string;
  email: string;
  client_id: string;
}

async function exchangeAuthCode(
  apiBase: string,
  authCode: string,
  codeVerifier: string,
): Promise<ExchangeResponse> {
  const res = await fetch(`${apiBase}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_code: authCode,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/auth/exchange returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as ExchangeResponse;
}

// ---------------------------------------------------------------------------
// Device-code flow
// ---------------------------------------------------------------------------

interface DeviceInitResponse {
  ok: true;
  deviceCode: string;
  loginUrl: string;
  expiresAt: string;
}

interface DevicePollApproved {
  ok: true;
  state: 'approved';
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string;
  user_id: string;
  email: string;
  client_id: string;
}

interface DevicePollPending {
  ok: true;
  state: 'pending';
}

interface DevicePollFailure {
  ok: false;
  error: string;
}

type DevicePollResponse =
  | DevicePollApproved
  | DevicePollPending
  | DevicePollFailure;

async function runDeviceLogin(
  opts: ResolvedOptions,
): Promise<AuthLoginResult> {
  const init = await deviceInit(opts);

  process.stdout.write(
    `\nMixShift device-code login\n` +
      `  1. Open this URL in any browser:\n     ${init.loginUrl}\n` +
      `  2. Sign in and confirm the device on the page.\n` +
      `  3. This terminal continues automatically once you're done.\n\n`,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < DEVICE_POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, DEVICE_POLL_INTERVAL_MS));
    const poll = await devicePoll(opts.apiBase, init.deviceCode);
    if (!poll.ok) {
      throw new Error(`Device-code poll failed: ${poll.error}`);
    }
    if (poll.state === 'approved') {
      const datahub = toDatahubCreds(opts, poll);
      await saveDatahub(datahub, opts.dataDirOverride);
      return {
        ok: true,
        mode: 'device',
        apiBase: opts.apiBase,
        personLabel: opts.personLabel,
        email: poll.email,
        userId: poll.user_id,
        clientId: poll.client_id ?? opts.clientId,
        durationMs: 0,
      };
    }
    // state === 'pending'; loop
  }
  throw new Error(
    `Device-code login timed out after ${DEVICE_POLL_TIMEOUT_MS / 60000} minutes. ` +
      `Run \`mixshift auth login\` to try again.`,
  );
}

async function deviceInit(opts: ResolvedOptions): Promise<DeviceInitResponse> {
  const res = await fetch(`${opts.apiBase}/auth/device/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_label: opts.deviceLabel,
      actor_hint: opts.personLabel,
      client_id: opts.clientId,
    }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/auth/device/init returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as DeviceInitResponse;
}

async function devicePoll(
  apiBase: string,
  deviceCode: string,
): Promise<DevicePollResponse> {
  const res = await fetch(`${apiBase}/auth/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
    signal: AbortSignal.timeout(15_000),
  });
  // The service returns JSON envelopes for all "expected" outcomes even
  // when the HTTP status is 4xx (e.g. 410 device_code_unknown_or_expired,
  // 401 unauthorized). Parse the body regardless; only throw on 5xx /
  // unparseable responses (network or service health issues we want
  // surfaced loudly).
  const contentType = res.headers.get('content-type') ?? '';
  const looksJson = contentType.includes('json');
  if (looksJson) {
    try {
      return (await res.json()) as DevicePollResponse;
    } catch {
      // Fall through to the throw below if JSON parse fails.
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(
      `/auth/device/poll returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  // 2xx but no parseable JSON body — shouldn't happen but treat as expired
  // so the chat skill restarts the flow.
  return { ok: false, error: 'unparseable_response' };
}

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

function toDatahubCreds(
  opts: ResolvedOptions,
  resp: ExchangeResponse | DevicePollApproved,
): DatahubCreds {
  return {
    api_base: opts.apiBase,
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: resp.expires_at,
    refresh_expires_at: resp.refresh_expires_at,
    user_id: resp.user_id,
    email: resp.email,
    person_label: opts.personLabel,
    device_label: opts.deviceLabel,
    client_id: opts.clientId,
  };
}

/**
 * Mirror the per-employee actor email (person_label) into
 * `~/.mixshift/profile.yaml::user.email` after a successful login.
 *
 * Downstream code (telemetry track(), `mixshift feedback`, anything
 * that reads `profile.user.email`) expects this field to be populated
 * once the user has authenticated. The legacy `mixshift auth setup`
 * flow set it as part of credential collection; the new token-based
 * auth login flow didn't, which left a gap where new users would sign
 * in via the browser but still have `feedback` complain about a
 * missing email. This closes that gap.
 *
 * Best-effort: profile-save failures don't break the login. The user
 * is signed in; profile.yaml is downstream metadata. We emit a
 * one-line stderr note so the operator can see + investigate.
 */
async function syncProfileEmailBestEffort(
  personLabel: string,
  dataDirOverride: string | undefined,
): Promise<void> {
  try {
    const { profile } = await loadProfile(dataDirOverride);
    if (profile.user?.email === personLabel) return; // already in sync
    const next = {
      ...profile,
      user: { ...profile.user, email: personLabel },
    };
    await saveProfile(next, dataDirOverride);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `(note: could not sync profile.yaml::user.email to "${personLabel}" ` +
        `— ${message.slice(0, 200)}; ` +
        'run `mixshift profile set --email <email>` if downstream commands ' +
        `like \`mixshift feedback\` complain about a missing email.)\n`,
    );
  }
}

async function postLoginDiscoverBestEffort(
  dataDirOverride: string | undefined,
  email: string,
  personLabel: string,
): Promise<void> {
  try {
    const { index } = await runDiscoveryAndPersist({ dataDirOverride });
    const counts = countByActivity(index);
    await track(
      {
        event_name: EventName.BrandDiscovered,
        outcome: 'ok',
        email,
        person_label: personLabel,
        payload: {
          trigger: 'post_login',
          total: counts.total,
          active: counts.active,
          dormant: counts.dormant,
          cold_started: counts.cold_started,
        },
      },
      dataDirOverride,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await track(
      {
        event_name: EventName.BrandDiscovered,
        outcome: 'failed',
        email,
        person_label: personLabel,
        error_class: 'post_login_discovery_threw',
        payload: { trigger: 'post_login', message: message.slice(0, 500) },
      },
      dataDirOverride,
    );
    // Discovery failure must not break the login.
  }
}

function isLikelyEmail(s: string): boolean {
  // Lightweight check; the schema parse downstream validates further.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

class PkceBrowserOpenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PkceBrowserOpenError';
  }
}

function isPkceBrowserOpenError(err: unknown): boolean {
  return err instanceof PkceBrowserOpenError;
}
