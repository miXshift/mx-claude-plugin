/**
 * Client for the Walmart Connect (advertising API) call surface on
 * mx-legacy-auth (https://mcp.mixshift.io). The REST sibling of the
 * service's walmart_ads_* MCP tools, so a plugin-only user reaches Walmart
 * without adding a separate connector.
 *
 * Three calls:
 *   listWalmartAdvertisers → GET  /api/walmart/ads/advertisers
 *   listWalmartOperations  → GET  /api/walmart/ads/operations[?family=...]
 *   walmartAdsCall         → POST /api/walmart/ads/call
 *
 * Which advertisers a login may call is decided by the service (per MixShift
 * account, per Walmart environment), never here: the advertiser list is the
 * only source of advertiser ids, and an id the account is not linked to is
 * refused before anything reaches Walmart (advertiser_not_allowed).
 *
 * WRITE SAFETY (service-enforced, mirrored here): catalog operations marked
 * write run as a preview by default and return { dryRun: true, preview }
 * without touching Walmart. Only an explicit `dryRun: false` commits, and the
 * skill layer must put the preview in front of the user and get their yes
 * first. An advertiser linked with `read` access refuses commits.
 *
 * Same transport SHAPE as lib/amazon/reports.ts amazonRequest (Bearer,
 * 401-force-refresh-retry once, typed envelope discrimination, unknown
 * outcome for a lost answer on a call that may change state), but a parallel
 * implementation, like lib/intelligence/client.ts: amazonRequest's kind set
 * and fallback copy are closed over Amazon, so reusing it would collapse
 * advertiser_not_allowed / tenant_not_allowed / upstream_auth to `unknown`
 * and tell a Walmart caller that Amazon refused the request.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { cleanServerText, parseRouteIssues } from '../amazon/reports.js';

// ---------------------------------------------------------------------------
// Types (mirror the service's VisibleAdvertiser / describe(op) / call results)
// ---------------------------------------------------------------------------

export type WalmartEnvironment = 'sandbox' | 'production';

/** One Walmart advertiser this MixShift account is linked to. `owner` may
 *  commit changes; `read` may read and preview only. */
export interface WalmartAdvertiserView {
  label: string;
  advertiserId: string;
  api: 'sponsored_search' | 'display' | string;
  environment: WalmartEnvironment | string;
  access: 'owner' | 'read' | string;
}

/** One callable operation from the service catalog. `notes` is the contract:
 *  required params, body shapes, and Walmart's own quirks. */
export interface WalmartOperationView {
  id: string;
  family: string;
  api: string;
  method: string;
  path: string;
  write: boolean;
  /** Set on download operations: MixShift fetches and parses the file. */
  returns?: string;
  requiredQuery?: string[];
  body?: string;
  notes?: string;
  docs?: string;
}

export interface ListWalmartAdvertisersResult {
  ok: true;
  advertisers: WalmartAdvertiserView[];
}

export interface ListWalmartOperationsResult {
  ok: true;
  families: string[];
  operations: WalmartOperationView[];
}

export type WalmartQueryValue = string | number | boolean | Array<string | number>;

export interface WalmartAdsCallInput {
  /** Operation id from listWalmartOperations, e.g. 'ss.list_campaigns'. */
  operation: string;
  /** Advertiser id from listWalmartAdvertisers. */
  advertiserId: string;
  /** Query params per the operation notes (plus MixShift's own `limit` and
   *  `groupBy` on download operations). */
  query?: Record<string, WalmartQueryValue>;
  /** JSON body per the operation notes. */
  body?: unknown;
  /**
   * Write operations only. The service defaults to TRUE (preview, nothing
   * sent to Walmart). Pass false ONLY after the user confirmed the preview.
   */
  dryRun?: boolean;
}

/**
 * The service's call result, minus `ok`. Fields by case:
 *   read or commit:   status (Walmart's HTTP status), correlationId, payload
 *   write preview:    dryRun: true, preview, message
 *   download:         ready, jobStatus, snapshotId, file, rows / groups / ...
 * Kept open (index signature) so a field the service adds later reaches the
 * caller instead of being dropped here.
 */
export interface WalmartAdsCallSuccess {
  ok: true;
  operation: string;
  environment: string;
  advertiserId: string;
  dryRun?: boolean;
  ready?: boolean;
  [key: string]: unknown;
}

/** Kinds the service emits (WalmartErrorKind in mx-legacy-auth
 *  connect-client.ts), plus local-only kinds for client-side states. */
export type WalmartFailureKind =
  // --- service-emitted ---
  | 'walmart_not_configured' // 503: Walmart credentials not set on the service
  | 'tenant_not_allowed' // 403: Walmart not enabled for this MixShift account
  | 'advertiser_not_allowed' // 403: advertiser not linked, read-only, or op refused
  | 'insufficient_scope' // 403: the credential lacks ads:write
  | 'bad_request' // 400: WALMART rejected the request. Terminal
  | 'invalid_request' // 400: MIXSHIFT refused it before sending (unknown operation, bad shape); nothing reached Walmart. Terminal
  | 'not_found' // 404: Walmart has no such record
  | 'upstream_auth' // 502: Walmart refused MixShift's access
  | 'throttled' // 429: Walmart rate limit
  | 'upstream_unavailable' // 502: Walmart was down or timed out
  // --- local-only ---
  | 'not_authenticated' // no MixShift credentials on disk
  | 'session_expired' // 401 even after a forced refresh
  | 'host_unreachable' // could not reach MixShift
  | 'unknown';

export interface WalmartFailure {
  ok: false;
  kind: WalmartFailureKind;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  /** Diagnostic detail, when the service sent one. */
  message?: string;
  httpStatus?: number;
  /** Echoed by advertiser_not_allowed / bad_request. */
  advertiserId?: string;
  /** Echoed by insufficient_scope. */
  requiredScope?: string;
  /** 'unknown' when a call that may change something lost its answer. */
  requestOutcome?: 'unknown';
  /** Sent alongside requestOutcome: false = the service will not retry on its own. */
  automaticRetry?: boolean;
  /** MixShift change-log id of the write this failure is about (audit/rollback handle). */
  auditId?: string;
  /** The service sent a kind this build does not know (contract drift). */
  unrecognizedKind?: string;
  /** Gateway contract (D-117): who acts (`request`, `account`,
   *  `amazon_rejected` = Walmart said no, `amazon_unavailable`, `mixshift`). */
  source?: string;
  /** Whether the SAME call can succeed later; `false` = change something first. */
  retryable?: boolean;
  /** The concrete change to make, when the gateway names one. */
  fix?: string;
  /** Parameter names a route-level schema miss is about. */
  invalidParams?: string[];
  /** Walmart's own response body on a Walmart rejection (the envelope's
   *  `walmart`), passed through for `--json`; the caller's own data, so never
   *  sent to telemetry. */
  walmartResponse?: unknown;
}

export interface WalmartClientOptions {
  /** Forwarded to credential resolution (the --data-dir override). */
  dataDirOverride?: string;
  /** Skip credential lookup for the base URL (tests / local mx-legacy-auth). */
  apiBaseOverride?: string;
  /** Injectable for tests. Defaults to getValidAccessToken bound to dataDir. */
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call network timeout. Defaults: 30 s for lists, 90 s for calls. */
  timeoutMs?: number;
}

export function isWalmartFailure(x: { ok: boolean } | WalmartFailure): x is WalmartFailure {
  return x.ok === false;
}

/** Exit codes, aligned with the numbers the Amazon surfaces already use for
 *  the same situation (exitCodeForKind in lib/amazon/reports.ts). */
export function exitCodeForWalmartKind(kind: WalmartFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in again
    case 'walmart_not_configured':
    case 'tenant_not_allowed':
      return 6; // Walmart is not enabled (service-wide, or for this account)
    case 'advertiser_not_allowed':
    case 'not_found':
      return 7; // the selector matched nothing this account may use
    case 'throttled':
      return 8;
    case 'insufficient_scope':
      return 11;
    case 'bad_request':
      return 12; // terminal: fix the request, do not resend as-is
    case 'invalid_request':
      return 15; // MixShift refused it before sending: change the request (same code as the Amazon surfaces)
    case 'upstream_auth':
      return 14; // Walmart denies this advertiser to MixShift
    case 'upstream_unavailable':
    case 'host_unreachable':
    case 'unknown':
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List the Walmart advertisers the signed-in MixShift account is linked to. */
export async function listWalmartAdvertisers(
  opts: WalmartClientOptions = {},
): Promise<ListWalmartAdvertisersResult | WalmartFailure> {
  const r = await walmartRequest(
    { method: 'GET', path: '/api/walmart/ads/advertisers' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { advertisers?: unknown }).advertisers;
  return { ok: true, advertisers: Array.isArray(raw) ? (raw as WalmartAdvertiserView[]) : [] };
}

/** List the service's Walmart Connect operation catalog. */
export async function listWalmartOperations(
  family?: string,
  opts: WalmartClientOptions = {},
): Promise<ListWalmartOperationsResult | WalmartFailure> {
  const qs = family ? `?family=${encodeURIComponent(family)}` : '';
  const r = await walmartRequest(
    { method: 'GET', path: `/api/walmart/ads/operations${qs}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const body = r.json as { families?: unknown; operations?: unknown };
  return {
    ok: true,
    families: Array.isArray(body.families) ? body.families.map(String) : [],
    operations: Array.isArray(body.operations) ? (body.operations as WalmartOperationView[]) : [],
  };
}

/** Execute one cataloged Walmart Connect operation. */
export async function walmartAdsCall(
  input: WalmartAdsCallInput,
  opts: WalmartClientOptions = {},
): Promise<WalmartAdsCallSuccess | WalmartFailure> {
  const body: Record<string, unknown> = {
    operation: input.operation,
    advertiserId: input.advertiserId,
  };
  if (input.query && Object.keys(input.query).length > 0) body.query = input.query;
  if (input.body !== undefined) body.body = input.body;
  // Only send dryRun when the caller set it: the service's own default
  // (TRUE for writes) is the safety contract.
  if (input.dryRun !== undefined) body.dryRun = input.dryRun;

  // A lost answer on a commit or a report/snapshot create is an unknown
  // outcome, not an unreachable service: resending could apply a change twice.
  const mayChangeState = input.dryRun === false || /\.create_/.test(input.operation);
  const r = await walmartRequest(
    { method: 'POST', path: '/api/walmart/ads/call', body, mayChangeState },
    { ...opts, timeoutMs: opts.timeoutMs ?? 90_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Record<string, unknown>;
  if (typeof json.operation !== 'string') {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'MixShift accepted the Walmart call but returned an unrecognized shape. ' +
        'Try again, or contact MixShift if it persists.',
      message: 'walmart call response missing operation echo',
      httpStatus: r.httpStatus,
    };
  }
  return {
    ...json,
    ok: true,
    operation: json.operation,
    environment: String(json.environment ?? ''),
    advertiserId: String(json.advertiserId ?? input.advertiserId),
  };
}

// ---------------------------------------------------------------------------
// Internal request plumbing
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /** The call can create or change something at Walmart (see walmartAdsCall). */
  mayChangeState?: boolean;
}

type RequestSuccess = { ok: true; json: unknown; httpStatus: number };

async function walmartRequest(
  spec: RequestSpec,
  opts: WalmartClientOptions,
): Promise<RequestSuccess | WalmartFailure> {
  const resolved = await resolveBaseAndToken(opts);
  if ('ok' in resolved) return resolved;
  const { apiBase, tokenProvider } = resolved;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const doFetch = async (
    bearer: string,
  ): Promise<{ res: Response } | { networkError: string; mayHaveArrived: boolean }> => {
    try {
      const res = await fetchImpl(`${apiBase}${spec.path}`, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
          ...intentHeader(),
        },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { res };
    } catch (err) {
      return {
        networkError: err instanceof Error ? err.message : String(err),
        mayHaveArrived: mayHaveArrived(err),
      };
    }
  };
  const networkFailure = (a: { networkError: string; mayHaveArrived: boolean }): WalmartFailure =>
    a.mayHaveArrived && spec.mayChangeState
      ? uncertainOutcome(
          'host_unreachable',
          `No answer came back from MixShift (it can take up to ${Math.ceil(timeoutMs / 1000)} ` +
            'seconds), so this call may still have gone through.',
          a.networkError,
        )
      : {
          ok: false,
          kind: 'host_unreachable',
          friendly: 'The MixShift service is unreachable. Check your network or try again in a minute.',
          message: a.networkError,
        };

  let token: string;
  try {
    token = await tokenProvider(false);
  } catch (err) {
    return sessionFailureFromError(err);
  }

  let attempt = await doFetch(token);
  if ('networkError' in attempt) return networkFailure(attempt);
  let res = attempt.res;

  // Mid-session 401: force a refresh and retry exactly once.
  if (res.status === 401) {
    try {
      token = await tokenProvider(true);
    } catch (err) {
      return sessionFailureFromError(err);
    }
    attempt = await doFetch(token);
    if ('networkError' in attempt) return networkFailure(attempt);
    res = attempt.res;
    if (res.status === 401) {
      return {
        ok: false,
        kind: 'session_expired',
        friendly:
          'Your MixShift session expired and could not be refreshed. Run ' +
          '`mixshift auth login` to re-authenticate.',
        httpStatus: 401,
      };
    }
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (spec.mayChangeState && (res.ok || res.status >= 500)) {
      return uncertainOutcome(
        res.ok ? 'unknown' : 'host_unreachable',
        `An answer came back (HTTP ${res.status}) but it was not MixShift's reply, so this call ` +
          'may still have gone through.',
        detail,
        res.status,
      );
    }
    return statusOnlyFailure(res.status);
  }

  if (isServerFailureEnvelope(json)) return toWalmartFailure(json, res.status);
  if (!res.ok) return statusOnlyFailure(res.status, safeJsonPreview(json));
  return { ok: true, json, httpStatus: res.status };
}

interface ResolvedConn {
  apiBase: string;
  tokenProvider: (forceRefresh?: boolean) => Promise<string>;
}

async function resolveBaseAndToken(opts: WalmartClientOptions): Promise<ResolvedConn | WalmartFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    // datahub (user session) wins; service (machine credential) is the
    // unattended fallback, same precedence getValidAccessToken applies.
    const base = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!base) {
      return {
        ok: false,
        kind: 'not_authenticated',
        friendly:
          "You're not signed in to MixShift. Run `mixshift auth login` (or say " +
          '"sign in to MixShift" in chat) first.',
      };
    }
    apiBase = base;
  }
  const tokenProvider =
    opts.tokenProvider ??
    ((forceRefresh?: boolean) => getValidAccessToken(opts.dataDirOverride, forceRefresh));
  return { apiBase, tokenProvider };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set<WalmartFailureKind>([
  // Keep in step with WalmartErrorKind in mx-legacy-auth connect-client.ts.
  'walmart_not_configured',
  'tenant_not_allowed',
  'advertiser_not_allowed',
  'insufficient_scope',
  'bad_request',
  'invalid_request',
  'not_found',
  'upstream_auth',
  'throttled',
  'upstream_unavailable',
  'unknown',
]);

function isServerFailureEnvelope(json: unknown): json is Record<string, unknown> & { ok: false } {
  return typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === false;
}

function toWalmartFailure(json: Record<string, unknown>, httpStatus: number): WalmartFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const recognized = KNOWN_KINDS.has(rawKind);
  const source = cleanServerText(json.source);
  const kind: WalmartFailureKind = recognized ? (rawKind as WalmartFailureKind) : kindForStatus(httpStatus, source);
  const friendly = typeof json.friendly === 'string' && json.friendly ? json.friendly : defaultFriendly(kind);
  const issues = parseRouteIssues(json.issues);
  const message = typeof json.message === 'string' ? json.message : issues?.detail;
  const advertiserId =
    typeof json.advertiserId === 'string' || typeof json.advertiserId === 'number'
      ? String(json.advertiserId)
      : undefined;
  const fix = cleanServerText(json.fix);
  return {
    ok: false,
    kind,
    friendly,
    httpStatus,
    ...(message !== undefined ? { message } : {}),
    ...(advertiserId !== undefined ? { advertiserId } : {}),
    ...(typeof json.required === 'string' ? { requiredScope: json.required } : {}),
    // An UNCERTAIN write failure (the service could not confirm the outcome)
    // carries requestOutcome:'unknown', automaticRetry:false and the change-log
    // id of the write; a fail-closed refusal carries none of them.
    ...(json.requestOutcome === 'unknown' ? { requestOutcome: 'unknown' as const } : {}),
    ...(typeof json.automaticRetry === 'boolean' ? { automaticRetry: json.automaticRetry } : {}),
    ...(typeof json.auditId === 'string' && json.auditId ? { auditId: json.auditId } : {}),
    ...(recognized ? {} : { unrecognizedKind: rawKind || '(absent)' }),
    ...(source !== undefined ? { source } : {}),
    ...(typeof json.retryable === 'boolean' ? { retryable: json.retryable } : {}),
    ...(fix !== undefined ? { fix } : {}),
    ...(issues && issues.paths.length > 0 ? { invalidParams: issues.paths } : {}),
    ...(json.walmart !== undefined ? { walmartResponse: json.walmart } : {}),
  };
}

/** Reverse-map a status only where the service's kind→status map is
 *  unambiguous for this surface; anything else stays `unknown`. A 400 is two
 *  kinds since P2 (`bad_request` = Walmart said no, `invalid_request` = we
 *  refused first), so the contract's `source` decides between them; without
 *  it the old reading (bad_request) stands. */
function kindForStatus(httpStatus: number, source?: string): WalmartFailureKind {
  if (httpStatus === 429) return 'throttled';
  if (httpStatus === 400) return source === 'request' ? 'invalid_request' : 'bad_request';
  return 'unknown';
}

function statusOnlyFailure(httpStatus: number, detail?: string): WalmartFailure {
  const kind = kindForStatus(httpStatus);
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message: `Service returned HTTP ${httpStatus} without a recognized error envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

function defaultFriendly(kind: WalmartFailureKind): string {
  switch (kind) {
    case 'walmart_not_configured':
      return 'Walmart Connect is not set up on the MixShift service yet. Contact MixShift.';
    case 'tenant_not_allowed':
      return 'Walmart Connect is not enabled for this MixShift account yet. Contact MixShift to join the beta.';
    case 'advertiser_not_allowed':
      return 'That Walmart advertiser is not connected to this MixShift account.';
    case 'insufficient_scope':
      return 'This Walmart operation changes campaigns and needs the ads:write scope.';
    case 'bad_request':
      return 'Walmart rejected the request. Check the operation notes for the required parameters.';
    case 'invalid_request':
      return (
        'MixShift refused this request before sending anything to Walmart: something in the ' +
        'request has to change. Run `mixshift walmart ads operations` for the operation list and its parameters.'
      );
    case 'not_found':
      return 'Walmart has no record matching that request.';
    case 'upstream_auth':
      return "Walmart refused MixShift's access for this advertiser. Contact MixShift.";
    case 'throttled':
      return 'Walmart is rate-limiting requests right now. Wait a minute, then try again.';
    case 'upstream_unavailable':
      return 'Walmart did not answer in time. Try again in a minute.';
    default:
      return 'The Walmart Connect request failed unexpectedly. Try again shortly.';
  }
}

/** A call that can change something ended without an answer we can trust. */
function uncertainOutcome(
  kind: 'host_unreachable' | 'unknown',
  lead: string,
  message: string,
  httpStatus?: number,
): WalmartFailure {
  return {
    ok: false,
    kind,
    friendly:
      `${lead} Check whether it did before sending it again: resending can create a ` +
      'duplicate report or apply a change twice.',
    message,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    requestOutcome: 'unknown',
  };
}

/** Our own deadline fired, or the socket closed after the request went out. */
function mayHaveArrived(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; cause?: { code?: unknown } };
  return e.name === 'TimeoutError' || e.cause?.code === 'UND_ERR_SOCKET';
}

function sessionFailureFromError(err: unknown): WalmartFailure {
  const message = err instanceof Error ? err.message : String(err);
  const expired = /expired|refresh/i.test(message);
  return {
    ok: false,
    kind: expired ? 'session_expired' : 'not_authenticated',
    friendly: expired
      ? 'Your MixShift session expired. Run `mixshift auth login` to re-authenticate.'
      : "You're not signed in to MixShift. Run `mixshift auth login` first.",
    message,
  };
}

function safeJsonPreview(json: unknown): string {
  try {
    const s = JSON.stringify(json);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  } catch {
    return String(json);
  }
}
