/**
 * Client for the Walmart Marketplace (seller API) READ surface on the MixShift
 * service (https://mcp.mixshift.io). Sibling of ads-call.ts for the seller
 * side of Walmart.
 *
 * Three calls:
 *   listMarketplaceSellers    -> GET  /api/walmart/marketplace/sellers
 *   listMarketplaceOperations -> GET  /api/walmart/marketplace/operations[?family=...]
 *   marketplaceCall           -> POST /api/walmart/marketplace/call
 *
 * READS ONLY. The plugin never sends a write operation (price, inventory,
 * order acknowledge/ship/cancel): marketplaceCall reads the operation catalog
 * first and refuses, client-side, any operation the catalog marks as a write.
 * Changes are made in the MixShift app. (The service refuses writes for plugin
 * tokens as well; this is the first fence, not the only one.)
 *
 * Which sellers a login may read is decided by the service. The seller list is
 * the only source of seller ids.
 *
 * Transport shape matches ads-call.ts (Bearer, one forced-refresh retry on a
 * 401 from MixShift, typed envelope discrimination), as a parallel
 * implementation because the Marketplace kind set differs from the ads one.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { cleanServerText, parseRouteIssues } from '../amazon/reports.js';
import type { WalmartEnvironment, WalmartFailure, WalmartOperationView } from './ads-call.js';

export type MarketplaceFailureKind =
  // --- service-emitted ---
  | 'seller_not_allowed' // seller not connected to this MixShift account
  | 'tenant_not_allowed' // Marketplace not enabled for this account
  | 'walmart_not_configured'
  | 'insufficient_scope'
  | 'invalid_request' // MixShift refused it before sending; nothing reached Walmart
  | 'bad_request' // Walmart rejected the request
  | 'not_found'
  | 'upstream_auth' // Walmart refused (a 401/403 on one read: a permission not granted)
  | 'throttled'
  | 'upstream_unavailable'
  // --- local-only ---
  | 'write_refused' // the operation is a change; the plugin only reads
  | 'not_authenticated'
  | 'session_expired'
  | 'host_unreachable'
  | 'unknown';

export interface MarketplaceFailure extends Omit<WalmartFailure, 'kind' | 'advertiserId'> {
  kind: MarketplaceFailureKind;
  sellerId?: string;
  /** Walmart's own HTTP status, when Walmart answered and the service says so. */
  walmartStatus?: number;
  /** Gateway reason code. 'reauth_required' = Walmart no longer accepts the seller's connection. */
  reason?: string;
  /** True when the operation id was found in the catalog (safe to put in telemetry). */
  operationKnown?: boolean;
}

export interface MarketplaceSellerView {
  sellerId: string;
  environment: WalmartEnvironment | string;
  label: string;
  scopes?: string[];
  /** Walmart no longer accepts this connection; the seller must reconnect. */
  reconnectRequired?: boolean;
  connectionExpiresAt?: string;
  [key: string]: unknown;
}

export interface MarketplaceOperationView extends Omit<WalmartOperationView, 'api'> {
  api?: string;
}

export interface MarketplaceCallInput {
  operation: string;
  sellerId: string;
  environment?: string;
  query?: Record<string, unknown>;
  path?: Record<string, unknown>;
}

export interface MarketplaceCallSuccess {
  ok: true;
  operation: string;
  sellerId: string;
  environment: string;
  [key: string]: unknown;
}

export interface MarketplaceClientOptions {
  dataDirOverride?: string;
  apiBaseOverride?: string;
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Per-call timeout. Defaults: 30 s for lists, 150 s for calls (mp.sku_snapshot can take ~90 s). */
  timeoutMs?: number;
}

export const MARKETPLACE_CALL_TIMEOUT_MS = 150_000;

export function isMarketplaceFailure<T extends { ok: boolean }>(x: T | MarketplaceFailure): x is MarketplaceFailure {
  return x.ok === false;
}

export function exitCodeForMarketplaceKind(kind: MarketplaceFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2;
    case 'walmart_not_configured':
    case 'tenant_not_allowed':
      return 6;
    case 'seller_not_allowed':
    case 'not_found':
      return 7;
    case 'throttled':
      return 8;
    case 'insufficient_scope':
    case 'write_refused':
      return 11;
    case 'bad_request':
      return 12;
    case 'upstream_auth':
      return 14;
    case 'invalid_request':
      return 15;
    default:
      return 1;
  }
}

export async function listMarketplaceSellers(
  opts: MarketplaceClientOptions = {},
): Promise<{ ok: true; sellers: MarketplaceSellerView[] } | MarketplaceFailure> {
  const r = await request(
    { method: 'GET', path: '/api/walmart/marketplace/sellers' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { sellers?: unknown }).sellers;
  return { ok: true, sellers: Array.isArray(raw) ? (raw as MarketplaceSellerView[]) : [] };
}

export async function listMarketplaceOperations(
  family?: string,
  opts: MarketplaceClientOptions = {},
): Promise<{ ok: true; families: string[]; operations: MarketplaceOperationView[] } | MarketplaceFailure> {
  const qs = family ? `?family=${encodeURIComponent(family)}` : '';
  const r = await request(
    { method: 'GET', path: `/api/walmart/marketplace/operations${qs}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const body = r.json as { families?: unknown; operations?: unknown };
  return {
    ok: true,
    families: Array.isArray(body.families) ? body.families.map(String) : [],
    operations: Array.isArray(body.operations) ? (body.operations as MarketplaceOperationView[]) : [],
  };
}

/**
 * Execute one cataloged READ operation for one seller. Reads the catalog first
 * and refuses a write operation before anything is sent.
 */
export async function marketplaceCall(
  input: MarketplaceCallInput,
  opts: MarketplaceClientOptions = {},
): Promise<MarketplaceCallSuccess | MarketplaceFailure> {
  const catalog = await listMarketplaceOperations(undefined, { ...opts, timeoutMs: undefined });
  if (!catalog.ok) return { ...catalog, operationKnown: false };
  const known = catalog.operations.find((o) => o.id === input.operation);
  if (known?.write === true) {
    return {
      ok: false,
      kind: 'write_refused',
      friendly:
        `${input.operation} changes the seller account, and the plugin only reads Walmart Marketplace data. ` +
        'Make this change in the MixShift app. Nothing was sent to Walmart.',
      sellerId: input.sellerId,
      operationKnown: true,
    };
  }

  const body: Record<string, unknown> = { operation: input.operation, sellerId: input.sellerId };
  if (input.environment) body.environment = input.environment;
  if (input.query && Object.keys(input.query).length > 0) body.query = input.query;
  if (input.path && Object.keys(input.path).length > 0) body.path = input.path;

  const r = await request(
    { method: 'POST', path: '/api/walmart/marketplace/call', body },
    { ...opts, timeoutMs: opts.timeoutMs ?? MARKETPLACE_CALL_TIMEOUT_MS },
  );
  if (!r.ok) return { ...r, operationKnown: known !== undefined };
  const json = (r.json ?? {}) as Record<string, unknown>;
  return {
    ...json,
    ok: true,
    operation: typeof json.operation === 'string' ? json.operation : input.operation,
    sellerId: String(json.sellerId ?? input.sellerId),
    environment: String(json.environment ?? input.environment ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

type RequestSuccess = { ok: true; json: unknown; httpStatus: number };

async function request(spec: RequestSpec, opts: MarketplaceClientOptions): Promise<RequestSuccess | MarketplaceFailure> {
  const resolved = await resolveBaseAndToken(opts);
  if ('ok' in resolved) return resolved;
  const { apiBase, tokenProvider } = resolved;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const doFetch = async (bearer: string): Promise<{ res: Response } | { networkError: string; timedOut: boolean }> => {
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
      const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
      return { networkError: err instanceof Error ? err.message : String(err), timedOut: name === 'TimeoutError' };
    }
  };
  const networkFailure = (a: { networkError: string; timedOut: boolean }): MarketplaceFailure => ({
    ok: false,
    kind: 'host_unreachable',
    friendly: a.timedOut
      ? `MixShift did not answer within ${Math.ceil(timeoutMs / 1000)} seconds. This read changes nothing, so it is safe to try again.`
      : 'The MixShift service is unreachable. Check your network or try again in a minute.',
    message: a.networkError,
  });

  let token: string;
  try {
    token = await tokenProvider(false);
  } catch (err) {
    return sessionFailureFromError(err);
  }
  let attempt = await doFetch(token);
  if ('networkError' in attempt) return networkFailure(attempt);
  let res = attempt.res;

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
        friendly: 'Your MixShift session expired and could not be refreshed. Run `mixshift auth login` to re-authenticate.',
        httpStatus: 401,
      };
    }
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return statusOnlyFailure(res.status);
  }
  if (typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === false) {
    return toFailure(json as Record<string, unknown>, res.status);
  }
  if (!res.ok) return statusOnlyFailure(res.status, safeJsonPreview(json));
  return { ok: true, json, httpStatus: res.status };
}

async function resolveBaseAndToken(
  opts: MarketplaceClientOptions,
): Promise<{ apiBase: string; tokenProvider: (forceRefresh?: boolean) => Promise<string> } | MarketplaceFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    const base = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!base) {
      return {
        ok: false,
        kind: 'not_authenticated',
        friendly: "You're not signed in to MixShift. Run `mixshift auth login` (or say \"sign in to MixShift\" in chat) first.",
      };
    }
    apiBase = base;
  }
  const tokenProvider =
    opts.tokenProvider ?? ((forceRefresh?: boolean) => getValidAccessToken(opts.dataDirOverride, forceRefresh));
  return { apiBase, tokenProvider };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set<MarketplaceFailureKind>([
  'seller_not_allowed',
  'tenant_not_allowed',
  'walmart_not_configured',
  'insufficient_scope',
  'invalid_request',
  'bad_request',
  'not_found',
  'upstream_auth',
  'throttled',
  'upstream_unavailable',
  'unknown',
]);

/** Walmart's own HTTP status, from whichever extra field the service uses. */
function walmartStatusOf(json: Record<string, unknown>): number | undefined {
  for (const key of ['walmartStatus', 'walmart_status', 'upstreamStatus', 'status']) {
    const v = json[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return undefined;
}

function toFailure(json: Record<string, unknown>, httpStatus: number): MarketplaceFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const recognized = KNOWN_KINDS.has(rawKind);
  const source = cleanServerText(json.source);
  const kind: MarketplaceFailureKind = recognized
    ? (rawKind as MarketplaceFailureKind)
    : httpStatus === 429
      ? 'throttled'
      : httpStatus === 400
        ? source === 'request'
          ? 'invalid_request'
          : 'bad_request'
        : 'unknown';
  const walmartStatus = walmartStatusOf(json);
  const reason = cleanServerText(json.reason);
  const issues = parseRouteIssues(json.issues);
  const message = typeof json.message === 'string' ? json.message : issues?.detail;
  const sellerId =
    typeof json.sellerId === 'string' || typeof json.sellerId === 'number' ? String(json.sellerId) : undefined;
  const fix = cleanServerText(json.fix);
  const gatewayFriendly = typeof json.friendly === 'string' && json.friendly ? json.friendly : undefined;
  // upstream_auth has two meanings the gateway words the same way, so the text is
  // composed here from reason / status / Walmart's body; the gateway's own text
  // is kept as the secondary detail.
  const composed =
    kind === 'upstream_auth'
      ? upstreamAuthFriendly(reason, walmartStatus, json.walmart !== undefined)
      : undefined;
  const friendly =
    composed ??
    gatewayFriendly ??
    defaultFriendly(kind, walmartStatus, { reason, hasWalmartBody: json.walmart !== undefined });
  const detailMessage =
    message ?? (composed && gatewayFriendly && gatewayFriendly !== composed ? gatewayFriendly : undefined);
  return {
    ok: false,
    kind,
    friendly,
    httpStatus,
    ...(walmartStatus !== undefined ? { walmartStatus } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(detailMessage !== undefined ? { message: detailMessage } : {}),
    ...(sellerId !== undefined ? { sellerId } : {}),
    ...(typeof json.required === 'string' ? { requiredScope: json.required } : {}),
    ...(recognized ? {} : { unrecognizedKind: rawKind || '(absent)' }),
    ...(source !== undefined ? { source } : {}),
    ...(typeof json.retryable === 'boolean' ? { retryable: json.retryable } : {}),
    ...(fix !== undefined ? { fix } : {}),
    ...(issues && issues.paths.length > 0 ? { invalidParams: issues.paths } : {}),
    ...(json.walmart !== undefined ? { walmartResponse: json.walmart } : {}),
  };
}

function statusOnlyFailure(httpStatus: number, detail?: string): MarketplaceFailure {
  const kind: MarketplaceFailureKind = httpStatus === 429 ? 'throttled' : httpStatus === 400 ? 'bad_request' : 'unknown';
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message: `Service returned HTTP ${httpStatus} without a recognized error envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

/**
 * upstream_auth has two meanings. reason 'reauth_required' = the token mint was
 * refused: the connection is dead whatever the status. A refused READ (no
 * reason, Walmart's body present, 401/403) is one permission the seller did
 * not grant. Anything else: undefined (use the generic text).
 */
export function upstreamAuthFriendly(
  reason: string | undefined,
  walmartStatus: number | undefined,
  hasWalmartBody: boolean | undefined,
): string | undefined {
  if (reason === 'reauth_required') {
    return "Walmart no longer accepts this seller's connection to MixShift. A Seller Center admin needs to reconnect it by opening https://mcp.mixshift.io/walmart/marketplace/connect.";
  }
  if (!reason && hasWalmartBody && (walmartStatus === 401 || walmartStatus === 403)) {
    return `Walmart refused this one read (${walmartStatus}): the seller has not granted MixShift that permission. The connection still works, and other reads may succeed.`;
  }
  return undefined;
}

export function defaultFriendly(
  kind: MarketplaceFailureKind,
  walmartStatus?: number,
  detail: { reason?: string; hasWalmartBody?: boolean } = {},
): string {
  switch (kind) {
    case 'seller_not_allowed':
      return (
        'That Walmart seller is not connected to this MixShift account. Run `mixshift walmart marketplace sellers` ' +
        'for the ones that are, or have a Seller Center admin connect it at https://mcp.mixshift.io/walmart/marketplace/connect.'
      );
    case 'tenant_not_allowed':
      return (
        'Walmart Marketplace is not enabled for this MixShift account yet. Ask MixShift (support@mixshift.io) to turn it on, ' +
        'then connect the seller at https://mcp.mixshift.io/walmart/marketplace/connect.'
      );
    case 'walmart_not_configured':
      return (
        'No Walmart seller is connected to this MixShift account yet. A Seller Center admin connects one by opening ' +
        'https://mcp.mixshift.io/walmart/marketplace/connect.'
      );
    case 'insufficient_scope':
      return 'This sign-in is not allowed to read that Marketplace data. Ask your MixShift account admin to grant it.';
    case 'invalid_request':
      return (
        'MixShift refused this request before sending anything to Walmart: something in it has to change. ' +
        'Run `mixshift walmart marketplace operations` for the operation list and its parameters.'
      );
    case 'bad_request':
      return 'Walmart rejected the request. Check the operation notes for the required parameters.';
    case 'not_found':
      return 'Walmart has no record matching that request.';
    case 'upstream_auth':
      return upstreamAuthFriendly(detail.reason, walmartStatus, detail.hasWalmartBody) ?? "Walmart refused MixShift's access for this seller. Contact MixShift.";
    case 'throttled':
      return 'Walmart is rate-limiting requests right now. Wait a minute, then try again.';
    case 'upstream_unavailable':
      return "Walmart did not answer in time. This is on Walmart's side and the seller does not need to reconnect. Try again in a minute.";
    default:
      return 'The Walmart Marketplace request failed unexpectedly. Try again shortly.';
  }
}

function sessionFailureFromError(err: unknown): MarketplaceFailure {
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
