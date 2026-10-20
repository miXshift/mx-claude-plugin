/**
 * Client for the shelf-data surface on the MixShift service (mcp.mixshift.io,
 * `/api/shelf/*`): what a shopper at a zip sees on Amazon for an ASIN or a
 * keyword, from a licensed third-party shelf-data provider on MixShift's own
 * key. The REST sibling of the service's shelf_* MCP tools.
 *
 *   shelfBuybox   -> POST /api/shelf/buybox   { asin, country?, zip?, fresh? }
 *   shelfOffers   -> POST /api/shelf/offers   { asin, country?, zip?, fresh? }
 *   shelfSearch   -> POST /api/shelf/search   { query, surface?, page?, country?, zip?, fresh? }
 *   shelfProduct  -> POST /api/shelf/product  { asin, country?, zip?, fresh? }
 *   shelfSeller   -> POST /api/shelf/seller   { seller_id, country?, fresh? }
 *   shelfZips     -> GET  /api/shelf/zips?country=
 *   shelfUsage    -> GET  /api/shelf/usage
 *
 * What the service promises (and this client relies on):
 *   - A public shelf observation is joined to nothing of the account's and
 *     never uses the account's Amazon credentials.
 *   - Every data answer counts one against the organization's monthly shelf
 *     allowance, whether the service observed the shelf for it or already had
 *     a recent observation; the zip list and the usage read are free.
 *   - Every data answer carries `observed_at`, the date the shelf looked like
 *     this. `fresh: true` asks for the shelf as of now (same cost).
 *   - Nothing in an answer names the provider; neither does anything here.
 *
 * Reads only: nothing here can change anything, so a lost answer is simply a
 * failed read and safe to retry.
 *
 * Same transport SHAPE as lib/walmart/ads-call.ts (Bearer, one forced-refresh
 * retry on 401, typed envelope discrimination), as its own implementation: the
 * Walmart and Amazon clients' kind sets are closed over their own surfaces and
 * would collapse `shelf_not_enabled` or `shelf_allowance_exhausted` to
 * `unknown` with the wrong friendly line.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';
import { cleanServerText, parseRouteIssues } from '../amazon/reports.js';

// ---------------------------------------------------------------------------
// Types (mirror the service's shelf envelopes)
// ---------------------------------------------------------------------------

export const SHELF_COUNTRIES = ['us', 'ca', 'uk', 'de', 'fr', 'it', 'es', 'in'] as const;
export type ShelfCountry = (typeof SHELF_COUNTRIES)[number];

export const SHELF_SURFACES = ['desktop', 'mobile'] as const;
export type ShelfSurface = (typeof SHELF_SURFACES)[number];

export type ShelfKind = 'buybox' | 'offers' | 'search_desktop' | 'search_mobile' | 'product' | 'seller';

/** Which workflow is asking (attribution only). */
export type ShelfOrigin = 'on_demand' | 'featured_offer_check' | 'demo' | 'subscription';

/** The success envelope of every data call. Nothing in it says how the answer
 *  was served; `observed_at` says when the shelf looked like this. */
export interface ShelfAnswer<T = Record<string, unknown>> {
  ok: true;
  kind: ShelfKind;
  retailer: string;
  country: string;
  zip: string;
  subject: string;
  observed_at: string;
  source: 'shelf';
  /** Present on product answers while that endpoint is beta. */
  beta?: true;
  data: T;
}

export interface ShelfBuybox {
  price: number | null;
  currency: string | null;
  in_stock: boolean;
  stock: number | null;
  sold_by: string | null;
  ships_from: string | null;
  prime: boolean | null;
  free_shipping: boolean | null;
  free_delivery: string | null;
  fastest_delivery: string | null;
  order_within: string | null;
  seller_id: string | null;
  delivery_to: string | null;
  promise_days_free: number | null;
  promise_days_fastest: number | null;
}

export interface ShelfOffer {
  price: string | null;
  price_num: number | null;
  fba: boolean | null;
  sold_by: string | null;
  ships_from: string | null;
  free_shipping: boolean | null;
  free_delivery: string | null;
  fastest_delivery: string | null;
  order_within: string | null;
  conditions: string | null;
  seller_id: string | null;
  promise_days_free: number | null;
  promise_days_fastest: number | null;
}

export interface ShelfOffers {
  product: (ShelfOffer & { title: string | null; rating: number | null; reviews: number | null }) | null;
  offers: ShelfOffer[];
  offer_count: number;
}

export interface ShelfSearchProduct {
  asin: string;
  title: string | null;
  price: string | null;
  price_num: number | null;
  rank: number;
  absolute_rank: number;
  rating: number | null;
  reviews: number | null;
  monthly_sales: number | null;
  is_sponsored: boolean;
  is_prime: boolean | null;
  is_amazon_choice: boolean | null;
  is_best_seller: boolean | null;
  is_overall_pick: boolean | null;
  badge_text: string | null;
  coupon: string | null;
  stock_level: string | null;
  fastest_delivery: string | null;
  promise_days_fastest: number | null;
  [key: string]: unknown;
}

export interface ShelfSearch {
  surface: ShelfSurface;
  page: number;
  page_size: number;
  asin_count: number;
  sponsored_count: number;
  total_results: number | null;
  delivery_to: string | null;
  banners: Array<{ position: number | null; brand: string | null; headline: string | null; [key: string]: unknown }>;
  products: ShelfSearchProduct[];
  categories: Array<{ id: string | null; name: string | null }>;
  brands: string[];
  related_keywords: string[];
  has_more: boolean | null;
}

export interface ShelfProduct {
  landing_asin: string | null;
  title: string | null;
  rating: number | null;
  reviews: number | null;
  monthly_sales: number | null;
  badge_text: string | null;
  buybox: ShelfBuybox | null;
  media: { primary_image: string | null; images: string[]; videos: string[] };
  bullet_points: string[];
  details: Record<string, string>;
  bsr: Array<{ rank: number; category: string }>;
  customer_say: string | null;
  [key: string]: unknown;
}

export interface ShelfSeller {
  name: string | null;
  rating: number | null;
  rating_count: number | null;
  description: string | null;
  details: string[];
  logo_url: string | null;
}

export interface ShelfZips {
  ok: true;
  retailer: string;
  country: string;
  count: number;
  zips: string[];
}

export interface ShelfUsage {
  ok: true;
  period: string;
  allowance: number;
  used: number;
  remaining: number;
  resets_at: string;
  source: 'discovery_first_month' | 'discovery' | 'entitlement' | string;
}

/** Kinds the service emits (ShelfErrorKind in mx-gateway src/shelf/errors.ts,
 *  plus the route-level ones), and local-only kinds for client-side states. */
export type ShelfFailureKind =
  // --- service-emitted ---
  | 'shelf_not_configured' // 503: shelf data is not set up on the service
  | 'shelf_not_enabled' // 403: the organization is not on the shelf beta
  | 'shelf_not_enrolled' // 403: this MixShift account has no organization row yet
  | 'shelf_allowance_exhausted' // 402: the month's included shelf requests are used
  | 'zip_unavailable' // 400: that zip is not one shelf data can observe from
  | 'bad_request' // 400: the provider refused it (e.g. no such ASIN or seller)
  | 'invalid_request' // 400: MixShift refused it before sending; change the request
  | 'throttled' // 429: busy; retry shortly
  | 'upstream_unavailable' // 502: shelf data is temporarily unavailable
  | 'insufficient_scope' // 403: the credential lacks shelf:read
  | 'not_found' // 404: no such shelf endpoint (contract drift)
  // --- local-only ---
  | 'not_authenticated'
  | 'session_expired'
  | 'host_unreachable'
  | 'unknown';

export interface ShelfFailure {
  ok: false;
  kind: ShelfFailureKind;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  /** Diagnostic detail, when the service sent one. */
  message?: string;
  httpStatus?: number;
  /** shelf_allowance_exhausted: the counter, and how to ask for more (the service's own words). */
  period?: string;
  allowance?: number;
  used?: number;
  resetsAt?: string;
  requestMore?: string;
  /** zip_unavailable: how many zips the country has (shelf zips lists them). */
  availableCount?: number;
  /** insufficient_scope. */
  requiredScope?: string;
  /** throttled. */
  retryAfterMs?: number;
  /** Gateway contract (D-117): who acts (`request`, `account`, `mixshift`). */
  source?: string;
  /** Whether the SAME call can succeed later; `false` = change something first. */
  retryable?: boolean;
  /** Parameter names a route-level schema miss is about. */
  invalidParams?: string[];
  /** The service sent a kind this build does not know (contract drift). */
  unrecognizedKind?: string;
}

export interface ShelfClientOptions {
  /** Forwarded to credential resolution (the --data-dir override). */
  dataDirOverride?: string;
  /** Skip credential lookup for the base URL (tests / local service). */
  apiBaseOverride?: string;
  /** Injectable for tests. Defaults to getValidAccessToken bound to dataDir. */
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call network timeout. Default 120 s: a provider observation can take
   *  tens of seconds (measured up to 31 s, one 16 s outlier in production),
   *  and the service retries once inside its own 45 s budget. */
  timeoutMs?: number;
}

export interface ShelfCommonInput {
  country?: ShelfCountry;
  /** Observe the shelf now instead of serving a recent observation (same cost). */
  fresh?: boolean;
  origin?: ShelfOrigin;
}

export function isShelfFailure(x: { ok: boolean }): x is ShelfFailure {
  return x.ok === false;
}

/** Exit codes, aligned with the numbers the Amazon and Walmart surfaces use
 *  for the same situation (exitCodeForKind in lib/amazon/reports.ts). */
export function exitCodeForShelfKind(kind: ShelfFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in again
    case 'shelf_not_configured':
    case 'shelf_not_enabled':
    case 'shelf_not_enrolled':
      return 6; // shelf data is not enabled (service-wide, or for this organization)
    case 'not_found':
      return 7;
    case 'throttled':
      return 8;
    case 'shelf_allowance_exhausted':
      return 10; // the month's included requests are used; resets next month
    case 'insufficient_scope':
      return 11;
    case 'bad_request':
    case 'zip_unavailable':
      return 12; // terminal as sent: fix the request
    case 'invalid_request':
      return 15; // MixShift refused it before sending: change the request
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

const DATA_TIMEOUT_MS = 120_000;
const FREE_TIMEOUT_MS = 30_000;

export async function shelfBuybox(
  input: ShelfCommonInput & { asin: string; zip?: string },
  opts: ShelfClientOptions = {},
): Promise<ShelfAnswer<ShelfBuybox> | ShelfFailure> {
  return dataCall<ShelfBuybox>('/api/shelf/buybox', { asin: input.asin.trim().toUpperCase(), zip: input.zip, ...commonBody(input) }, opts);
}

export async function shelfOffers(
  input: ShelfCommonInput & { asin: string; zip?: string },
  opts: ShelfClientOptions = {},
): Promise<ShelfAnswer<ShelfOffers> | ShelfFailure> {
  return dataCall<ShelfOffers>('/api/shelf/offers', { asin: input.asin.trim().toUpperCase(), zip: input.zip, ...commonBody(input) }, opts);
}

export async function shelfSearch(
  input: ShelfCommonInput & { query: string; surface?: ShelfSurface; page?: number; zip?: string },
  opts: ShelfClientOptions = {},
): Promise<ShelfAnswer<ShelfSearch> | ShelfFailure> {
  return dataCall<ShelfSearch>(
    '/api/shelf/search',
    { query: input.query.trim(), surface: input.surface, page: input.page, zip: input.zip, ...commonBody(input) },
    opts,
  );
}

export async function shelfProduct(
  input: ShelfCommonInput & { asin: string; zip?: string },
  opts: ShelfClientOptions = {},
): Promise<ShelfAnswer<ShelfProduct> | ShelfFailure> {
  return dataCall<ShelfProduct>('/api/shelf/product', { asin: input.asin.trim().toUpperCase(), zip: input.zip, ...commonBody(input) }, opts);
}

export async function shelfSeller(
  input: ShelfCommonInput & { sellerId: string },
  opts: ShelfClientOptions = {},
): Promise<ShelfAnswer<ShelfSeller> | ShelfFailure> {
  return dataCall<ShelfSeller>('/api/shelf/seller', { seller_id: input.sellerId.trim().toUpperCase(), ...commonBody(input) }, opts);
}

/** The shopper locations shelf data can be observed from, per country. Free. */
export async function shelfZips(country: ShelfCountry = 'us', opts: ShelfClientOptions = {}): Promise<ShelfZips | ShelfFailure> {
  const r = await shelfRequest({ method: 'GET', path: `/api/shelf/zips?country=${encodeURIComponent(country)}` }, { ...opts, timeoutMs: opts.timeoutMs ?? FREE_TIMEOUT_MS });
  if (!r.ok) return r;
  const j = r.json as Partial<ShelfZips>;
  return { ok: true, retailer: String(j.retailer ?? 'amazon'), country: String(j.country ?? country), count: Number(j.count ?? 0), zips: Array.isArray(j.zips) ? j.zips.map(String) : [] };
}

/** The organization's shelf allowance for the current month. Free. */
export async function shelfUsage(opts: ShelfClientOptions = {}): Promise<ShelfUsage | ShelfFailure> {
  const r = await shelfRequest({ method: 'GET', path: '/api/shelf/usage' }, { ...opts, timeoutMs: opts.timeoutMs ?? FREE_TIMEOUT_MS });
  if (!r.ok) return r;
  const j = r.json as Partial<ShelfUsage>;
  if (typeof j.period !== 'string' || typeof j.allowance !== 'number') return unrecognizedShape(r.httpStatus, 'usage');
  return {
    ok: true,
    period: j.period,
    allowance: j.allowance,
    used: Number(j.used ?? 0),
    remaining: Number(j.remaining ?? Math.max(0, j.allowance - Number(j.used ?? 0))),
    resets_at: String(j.resets_at ?? ''),
    source: String(j.source ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Internal request plumbing
// ---------------------------------------------------------------------------

function commonBody(input: ShelfCommonInput): Record<string, unknown> {
  return {
    ...(input.country ? { country: input.country } : {}),
    ...(input.fresh ? { fresh: true } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
  };
}

async function dataCall<T>(path: string, body: Record<string, unknown>, opts: ShelfClientOptions): Promise<ShelfAnswer<T> | ShelfFailure> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null && v !== '') clean[k] = v;
  const r = await shelfRequest({ method: 'POST', path, body: clean }, { ...opts, timeoutMs: opts.timeoutMs ?? DATA_TIMEOUT_MS });
  if (!r.ok) return r;
  const j = r.json as Partial<ShelfAnswer<T>>;
  if (j.ok !== true || typeof j.kind !== 'string' || typeof j.observed_at !== 'string' || j.data === undefined) {
    return unrecognizedShape(r.httpStatus, 'answer');
  }
  return j as ShelfAnswer<T>;
}

function unrecognizedShape(httpStatus: number, what: string): ShelfFailure {
  return {
    ok: false,
    kind: 'unknown',
    friendly: 'MixShift answered the shelf request but returned an unrecognized shape. Try again, or contact MixShift if it persists.',
    message: `shelf ${what} response missing its envelope fields`,
    httpStatus,
  };
}

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

type RequestSuccess = { ok: true; json: unknown; httpStatus: number };

async function shelfRequest(spec: RequestSpec, opts: ShelfClientOptions): Promise<RequestSuccess | ShelfFailure> {
  const resolved = await resolveBaseAndToken(opts);
  if ('ok' in resolved) return resolved;
  const { apiBase, tokenProvider } = resolved;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FREE_TIMEOUT_MS;

  const doFetch = async (bearer: string): Promise<{ res: Response } | { networkError: string }> => {
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
      return { networkError: err instanceof Error ? err.message : String(err) };
    }
  };
  const networkFailure = (a: { networkError: string }): ShelfFailure => ({
    ok: false,
    kind: 'host_unreachable',
    friendly: 'The MixShift service did not answer in time. Check your network or try again in a minute.',
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
  if (isServerFailureEnvelope(json)) return toShelfFailure(json, res.status);
  if (!res.ok) return statusOnlyFailure(res.status, safeJsonPreview(json));
  return { ok: true, json, httpStatus: res.status };
}

interface ResolvedConn {
  apiBase: string;
  tokenProvider: (forceRefresh?: boolean) => Promise<string>;
}

async function resolveBaseAndToken(opts: ShelfClientOptions): Promise<ResolvedConn | ShelfFailure> {
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
        friendly: "You're not signed in to MixShift. Run `mixshift auth login` (or say \"sign in to MixShift\" in chat) first.",
      };
    }
    apiBase = base;
  }
  const tokenProvider = opts.tokenProvider ?? ((forceRefresh?: boolean) => getValidAccessToken(opts.dataDirOverride, forceRefresh));
  return { apiBase, tokenProvider };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set<ShelfFailureKind>([
  // Keep in step with ShelfErrorKind in mx-gateway src/shelf/errors.ts (+ route kinds).
  'shelf_not_configured',
  'shelf_not_enabled',
  'shelf_not_enrolled',
  'shelf_allowance_exhausted',
  'zip_unavailable',
  'bad_request',
  'invalid_request',
  'throttled',
  'upstream_unavailable',
  'insufficient_scope',
  'not_found',
  'unknown',
]);

function isServerFailureEnvelope(json: unknown): json is Record<string, unknown> & { ok: false } {
  return typeof json === 'object' && json !== null && (json as { ok?: unknown }).ok === false;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function toShelfFailure(json: Record<string, unknown>, httpStatus: number): ShelfFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const recognized = KNOWN_KINDS.has(rawKind);
  const source = cleanServerText(json.source);
  const kind: ShelfFailureKind = recognized ? (rawKind as ShelfFailureKind) : kindForStatus(httpStatus, source);
  const friendly = typeof json.friendly === 'string' && json.friendly ? json.friendly : defaultFriendly(kind);
  const issues = parseRouteIssues(json.issues);
  const message = typeof json.message === 'string' ? json.message : issues?.detail;
  return {
    ok: false,
    kind,
    friendly,
    httpStatus,
    ...(message !== undefined ? { message } : {}),
    ...(str(json.period) !== undefined ? { period: str(json.period) } : {}),
    ...(num(json.allowance) !== undefined ? { allowance: num(json.allowance) } : {}),
    ...(num(json.used) !== undefined ? { used: num(json.used) } : {}),
    ...(str(json.resets_at) !== undefined ? { resetsAt: str(json.resets_at) } : {}),
    ...(str(json.request_more) !== undefined ? { requestMore: str(json.request_more) } : {}),
    ...(num(json.available_count) !== undefined ? { availableCount: num(json.available_count) } : {}),
    ...(num(json.retryAfterMs) !== undefined ? { retryAfterMs: num(json.retryAfterMs) } : {}),
    ...(typeof json.required === 'string' ? { requiredScope: json.required } : {}),
    ...(recognized ? {} : { unrecognizedKind: rawKind || '(absent)' }),
    ...(source !== undefined ? { source } : {}),
    ...(typeof json.retryable === 'boolean' ? { retryable: json.retryable } : {}),
    ...(issues && issues.paths.length > 0 ? { invalidParams: issues.paths } : {}),
  };
}

/** Reverse-map a status only where the service's kind -> status map is
 *  unambiguous for this surface; anything else stays `unknown`. */
function kindForStatus(httpStatus: number, source?: string): ShelfFailureKind {
  if (httpStatus === 429) return 'throttled';
  if (httpStatus === 402) return 'shelf_allowance_exhausted';
  if (httpStatus === 400) return source === 'request' ? 'invalid_request' : 'bad_request';
  return 'unknown';
}

function statusOnlyFailure(httpStatus: number, detail?: string): ShelfFailure {
  const kind = kindForStatus(httpStatus);
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message: `Service returned HTTP ${httpStatus} without a recognized error envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

export function defaultFriendly(kind: ShelfFailureKind): string {
  switch (kind) {
    case 'shelf_not_configured':
      return 'Shelf data is not set up on the MixShift service yet. Contact MixShift.';
    case 'shelf_not_enabled':
      return 'Shelf data is switched off for your organization. Ask MixShift to turn it back on.';
    case 'shelf_not_enrolled':
      return 'Your MixShift account is not set up for shelf data yet. Ask MixShift to enroll your organization.';
    case 'shelf_allowance_exhausted':
      return "Your organization's included shelf requests for this month are used. They reset next month, or say \"request more shelf requests\" to ask MixShift for more now.";
    case 'zip_unavailable':
      return 'That zip is not one shelf data can observe from. Run `mixshift shelf zips` for the list.';
    case 'bad_request':
      return 'The shelf request was refused as sent (for example no such ASIN or seller on this marketplace). Check the inputs.';
    case 'invalid_request':
      return 'MixShift refused this request before sending anything: something in the request has to change. Run `mixshift shelf catalog` for the inputs each call takes.';
    case 'throttled':
      return 'Shelf data is busy right now. Wait a moment, then try again.';
    case 'upstream_unavailable':
      return 'Shelf data is temporarily unavailable. Try again in a minute.';
    case 'insufficient_scope':
      return 'This credential lacks the shelf:read scope. Sign in again, or mint a service credential that includes it.';
    case 'not_found':
      return 'MixShift has no such shelf endpoint. Update the plugin.';
    case 'host_unreachable':
      return 'The MixShift service is unreachable. Check your network or try again in a minute.';
    case 'not_authenticated':
      return "You're not signed in to MixShift. Run `mixshift auth login` first.";
    case 'session_expired':
      return 'Your MixShift session expired. Run `mixshift auth login` to re-authenticate.';
    default:
      return 'The shelf request failed unexpectedly. Try again shortly.';
  }
}

function sessionFailureFromError(err: unknown): ShelfFailure {
  const message = err instanceof Error ? err.message : String(err);
  const expired = /expired|refresh/i.test(message);
  return {
    ok: false,
    kind: expired ? 'session_expired' : 'not_authenticated',
    friendly: defaultFriendly(expired ? 'session_expired' : 'not_authenticated'),
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
