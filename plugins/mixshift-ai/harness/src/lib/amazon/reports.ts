/**
 * Client for the Amazon SP-API on-demand report surface on mx-legacy-auth
 * (https://mcp.mixshift.io). Same Bearer token as the warehouse query path
 * (see data/query-runner.ts) — this module is the report-pull analogue.
 *
 * What this surface is FOR: pulling reports MixShift doesn't already hold in
 * the warehouse, or pulling a known report for a specific ad-hoc window, so
 * the user can analyze / build with / combine / store the result. This module
 * is pure transport: it never gates a pull. The skill layer may reason "does
 * the warehouse already have this?" and ask the user first, but that is a
 * skill-level optimization, not a constraint enforced here.
 *
 * Division of responsibility (server wins on disagreement):
 *   - PLUGIN side (here): calling conventions, the token plumbing, typed
 *     envelope handling, the report catalog + parse hints.
 *   - SERVICE side: which merchants are authorized, which reports are
 *     restricted, secret handling, talking to Amazon. We never see SP-API
 *     credentials; we send a Bearer token and a report request, and get
 *     document bytes back.
 *
 * Lifecycle (keyed by `runId`, a service-minted UUID):
 *   startReport  → POST   /api/amazon/reports                 → { runId }
 *   pollReport   → GET    /api/amazon/reports/:runId          → { ready, status }
 *   getReport... → GET    /api/amazon/reports/:runId/document → { ready, tsv? }
 *
 * `ready` (boolean) is the signal — do NOT parse Amazon's status string to
 * decide done-ness. `getReportDocument` is safe to call early: before the
 * report is ready it returns { ok:true, ready:false, status } (NOT an error),
 * which is what lets the chat skill poll across separate tool calls without a
 * blocking loop (Cowork caps Bash at ~45s — same constraint that forced the
 * two-phase device-code auth flow).
 *
 * Document bytes: flat-file reports are TSV (sometimes with a UTF-8 BOM);
 * vendor reports and Brand Analytics are JSON. The wire field is named `tsv`
 * regardless of the actual format; the service returns bytes as-is and we do
 * not transcode. The catalog's `document_format` tells callers which it is.
 *
 * Failure envelope (any call): { ok:false, kind, friendly, message?, ...extra }.
 * Callers branch on `kind`, never on HTTP status — the service normalizes
 * Amazon's many failure modes into a small set of kinds. The HTTP status is
 * carried through as `httpStatus` for diagnostics only.
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A merchant the signed-in tenant can pull reports for. Mirrors the service
 *  MerchantView. Keys on `amazonSellerId`; the warehouse keys on an internal
 *  SellerID / AmazonSellerID, so mapping a brand → merchant needs a join
 *  (handled by the brand registry / CLI, not here). */
export interface MerchantView {
  amazonSellerId: string;
  name: string;
  merchantType: 'Seller' | 'Vendor';
  merchantRegion: string;
  /** Primary marketplace for this merchant, or null when the service can't
   *  determine one. */
  marketplaceId: string | null;
  /** True when the SP-API authorization is live. False == the user revoked
   *  access or the grant lapsed; reports will fail with reauth_required until
   *  re-connected. */
  authorized: boolean;
}

/** Kinds the service emits, plus two local-only kinds for client-side states
 *  the service never sees (no creds on disk; refresh failed). Branch on this. */
export type ReportFailureKind =
  // --- service-emitted ---
  | 'spapi_not_configured' // 503 — SP-API not enabled for this tenant
  | 'reauth_required' // 409 — merchant grant lapsed; +amazonSellerId
  | 'restricted_report' // 403 — Amazon needs an RDT/PII role we lack; +reportType
  | 'merchant_not_found' // 404 — no merchant matched the selector
  | 'throttled' // 429 — Amazon rate limit; +retryAfterMs
  | 'report_fatal' // 502 — Amazon returned FATAL/CANCELLED; +reportId,status
  | 'host_unreachable' // 502 — service couldn't reach Amazon
  // --- local-only (this module) ---
  | 'not_authenticated' // no datahub creds on disk; run `mixshift auth login`
  | 'session_expired' // 401 even after a forced refresh
  | 'unknown'; // anything else (500, unparseable body, ...)

export interface ReportFailure {
  ok: false;
  kind: ReportFailureKind;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  /** Raw server/exception message — for logs and `--json`, not the headline. */
  message?: string;
  // kind-specific extras (present when the service includes them):
  amazonSellerId?: string;
  reportType?: string;
  retryAfterMs?: number;
  reportId?: string;
  status?: string;
  /** HTTP status of the failing call — diagnostics only; do not branch on it. */
  httpStatus?: number;
}

export interface ListMerchantsResult {
  ok: true;
  merchants: MerchantView[];
}

export interface StartReportInput {
  /** Which merchant to pull for. The plugin keys merchants on amazonSellerId
   *  (from `listMerchants`); on the wire it goes as `sellerId`. Optional when
   *  the tenant has exactly one merchant (the service infers it); required and
   *  exact-match when there's more than one. */
  amazonSellerId?: string;
  /** Amazon report type enum, e.g. GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL. */
  reportType: string;
  /** Report window. YYYY-MM-DD or ISO 8601. Required by some report types,
   *  rejected by snapshot types (see the catalog's window field). The service
   *  maps these to Amazon's dataStartTime / dataEndTime. */
  start?: string;
  end?: string;
  /** Single marketplace: a country code (US / UK / DE / JP) or a raw
   *  marketplaceId. Omit to default server-side to the merchant's marketplace. */
  marketplace?: string;
  /** Report-type-specific knobs (e.g. { reportPeriod: 'WEEK' } for Brand
   *  Analytics). Passed through to Amazon untouched. */
  reportOptions?: Record<string, string>;
}

export interface StartReportResult {
  ok: true;
  /** Service-minted handle for the lifecycle. Poll + fetch with this. */
  runId: string;
  /** Initial Amazon processing status, when the service returns it. */
  status?: string;
}

export interface PollReportResult {
  ok: true;
  /** THE done-ness signal. When true, the document is fetchable. */
  ready: boolean;
  /** Amazon processing status (IN_QUEUE | IN_PROGRESS | DONE | FATAL |
   *  CANCELLED). Surface it for UX, but gate on `ready`. */
  status: string;
  /** Amazon's reportId once assigned — for cross-referencing in support. */
  reportId?: string;
}

export interface GetReportDocumentResult {
  ok: true;
  /** False when the report isn't done yet (this is NOT an error; keep
   *  polling). True when `document` is populated. */
  ready: boolean;
  status?: string;
  /** Document bytes as a string (TSV or JSON per the catalog). Undefined
   *  while `ready` is false. May carry a leading UTF-8 BOM for flat files;
   *  strip before parsing if your parser doesn't. */
  document?: string;
  /** Service's row-count estimate for the document, when provided. Useful for
   *  a quick size sanity-check before parsing. Absent for JSON reports. */
  rowCountEstimate?: number;
}

export interface ReportClientOptions {
  /** Forwarded to credential resolution (the --data-dir override). */
  dataDirOverride?: string;
  /** Skip credential lookup for the base URL (tests / local mx-legacy-auth). */
  apiBaseOverride?: string;
  /** Injectable for tests. Defaults to getValidAccessToken bound to dataDir.
   *  Takes the same forceRefresh flag so the 401-retry path works. */
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call network timeout. Defaults: 30s for start/poll/merchants,
   *  120s for document fetch (documents can be large). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isReportFailure(
  x: { ok: boolean } | ReportFailure,
): x is ReportFailure {
  return x.ok === false;
}

/** List merchants the signed-in tenant can pull reports for. */
export async function listMerchants(
  opts: ReportClientOptions = {},
): Promise<ListMerchantsResult | ReportFailure> {
  const r = await amazonRequest(
    { method: 'GET', path: '/api/amazon/merchants' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  // Tolerate both { merchants: [...] } and a bare [...] in case the surface
  // shape shifts; normalize to MerchantView[].
  const raw = Array.isArray(r.json)
    ? r.json
    : ((r.json as { merchants?: unknown }).merchants ?? []);
  const merchants = Array.isArray(raw) ? (raw as MerchantView[]) : [];
  return { ok: true, merchants };
}

/** Kick off a report run. Returns immediately with a `runId` to poll. */
export async function startReport(
  input: StartReportInput,
  opts: ReportClientOptions = {},
): Promise<StartReportResult | ReportFailure> {
  // Wire shape per the service handoff doc (POST /api/amazon/reports):
  //   { reportType, sellerId?, marketplace?, start?, end?, reportOptions? }
  // The plugin's internal field is amazonSellerId; it goes on the wire as
  // `sellerId`. Omit any field that's absent so the service applies its
  // defaults (e.g. single-merchant sellerId inference, default marketplace).
  const body: Record<string, unknown> = {
    reportType: input.reportType,
  };
  if (input.amazonSellerId) body.sellerId = input.amazonSellerId;
  if (input.start) body.start = input.start;
  if (input.end) body.end = input.end;
  if (input.marketplace) body.marketplace = input.marketplace;
  if (input.reportOptions) body.reportOptions = input.reportOptions;

  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/reports', body },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const json = r.json as { runId?: unknown; status?: unknown };
  const runId = typeof json.runId === 'string' ? json.runId : undefined;
  if (!runId) {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The service accepted the report request but did not return a run ' +
        'handle. Try again, or contact MixShift ops if it persists.',
      message: `start response missing runId: ${safeJsonPreview(r.json)}`,
    };
  }
  return {
    ok: true,
    runId,
    status: typeof json.status === 'string' ? json.status : undefined,
  };
}

/** Check whether a run is done. Gate on `ready`, not `status`. */
export async function pollReport(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<PollReportResult | ReportFailure> {
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/reports/${encodeURIComponent(runId)}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const json = r.json as { ready?: unknown; status?: unknown; reportId?: unknown };
  return {
    ok: true,
    ready: json.ready === true,
    status: typeof json.status === 'string' ? json.status : 'UNKNOWN',
    reportId: typeof json.reportId === 'string' ? json.reportId : undefined,
  };
}

/**
 * Fetch the document. Safe to call before the report is ready — returns
 * { ok:true, ready:false } in that case (poll-across-calls pattern). When
 * ready, `document` holds the bytes as a string.
 */
export async function getReportDocument(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<GetReportDocumentResult | ReportFailure> {
  const r = await amazonRequest(
    {
      method: 'GET',
      path: `/api/amazon/reports/${encodeURIComponent(runId)}/document`,
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  if (!r.ok) return r;
  const json = r.json as {
    ready?: unknown;
    status?: unknown;
    tsv?: unknown;
    rowCountEstimate?: unknown;
  };
  const ready = json.ready === true;
  return {
    ok: true,
    ready,
    status: typeof json.status === 'string' ? json.status : undefined,
    // Wire field is `tsv` regardless of TSV-vs-JSON content (see file header).
    document: typeof json.tsv === 'string' ? json.tsv : undefined,
    rowCountEstimate: numOrUndef(json.rowCountEstimate),
  };
}

// ---------------------------------------------------------------------------
// Internal request plumbing (mirrors query-runner's datahub branch)
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

type RequestSuccess = { ok: true; json: unknown };

/**
 * One authenticated round-trip to the report surface, with the same token
 * lifecycle as the query path: send the Bearer; on a mid-session 401,
 * force-refresh once and retry; map network/DNS/TLS failures to
 * host_unreachable; map a server failure envelope to a typed ReportFailure.
 */
async function amazonRequest(
  spec: RequestSpec,
  opts: ReportClientOptions,
): Promise<RequestSuccess | ReportFailure> {
  const resolved = await resolveBaseAndToken(opts);
  // Only ReportFailure carries an `ok` key; ResolvedConn does not — so this
  // is a clean discriminant and the else-branch narrows to ResolvedConn.
  if ('ok' in resolved) return resolved;
  const { apiBase, tokenProvider } = resolved;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const doFetch = async (
    bearer: string,
  ): Promise<{ res: Response } | { networkError: string }> => {
    try {
      const res = await fetchImpl(`${apiBase}${spec.path}`, {
        method: spec.method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(spec.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { res };
    } catch (err) {
      return { networkError: err instanceof Error ? err.message : String(err) };
    }
  };

  let token: string;
  try {
    token = await tokenProvider(false);
  } catch (err) {
    return sessionFailureFromError(err);
  }

  let attempt = await doFetch(token);
  if ('networkError' in attempt) return hostUnreachable(attempt.networkError);
  let res = attempt.res;

  // Mid-session 401: token looked fresh client-side but the server rejected
  // it. Force a refresh and retry exactly once (matches query-runner).
  if (res.status === 401) {
    try {
      token = await tokenProvider(true);
    } catch (err) {
      return sessionFailureFromError(err);
    }
    attempt = await doFetch(token);
    if ('networkError' in attempt) return hostUnreachable(attempt.networkError);
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

  // Parse the body. The surface always speaks JSON (success or the failure
  // envelope). A non-JSON body means an infra layer (proxy/gateway) answered
  // instead of the service — fall back to a status-derived kind.
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return statusOnlyFailure(res.status);
  }

  if (isServerFailureEnvelope(json)) {
    return toReportFailure(json, res.status);
  }

  // Some infra errors arrive as valid JSON without our envelope (e.g. a CDN
  // error object). If the HTTP status is non-2xx and the body isn't our
  // success/ failure shape, treat it as a status-derived failure.
  if (!res.ok) {
    return statusOnlyFailure(res.status, safeJsonPreview(json));
  }

  return { ok: true, json };
}

interface ResolvedConn {
  apiBase: string;
  tokenProvider: (forceRefresh?: boolean) => Promise<string>;
}

/** Resolve the base URL + a token provider, or a local failure envelope. */
async function resolveBaseAndToken(
  opts: ReportClientOptions,
): Promise<ResolvedConn | ReportFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    if (!credentials?.datahub) {
      return {
        ok: false,
        kind: 'not_authenticated',
        friendly:
          "You're not signed in to MixShift. Run `mixshift auth login` (or " +
          'say "sign in to MixShift" in chat) before pulling reports.',
      };
    }
    apiBase = credentials.datahub.api_base;
  }
  const tokenProvider =
    opts.tokenProvider ??
    ((forceRefresh?: boolean) =>
      getValidAccessToken(opts.dataDirOverride, forceRefresh));
  return { apiBase, tokenProvider };
}

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const KNOWN_KINDS: ReadonlySet<string> = new Set<ReportFailureKind>([
  'spapi_not_configured',
  'reauth_required',
  'restricted_report',
  'merchant_not_found',
  'throttled',
  'report_fatal',
  'host_unreachable',
  'not_authenticated',
  'session_expired',
  'unknown',
]);

function isServerFailureEnvelope(
  json: unknown,
): json is Record<string, unknown> & { ok: false } {
  return (
    typeof json === 'object' &&
    json !== null &&
    (json as { ok?: unknown }).ok === false
  );
}

/** Map a server `{ ok:false, kind, ... }` envelope to a typed ReportFailure,
 *  trusting the server's kind when recognized and filling a friendly default
 *  when the server omitted one. */
function toReportFailure(
  json: Record<string, unknown>,
  httpStatus: number,
): ReportFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const kind: ReportFailureKind = KNOWN_KINDS.has(rawKind)
    ? (rawKind as ReportFailureKind)
    : 'unknown';
  const serverFriendly =
    typeof json.friendly === 'string' ? json.friendly : undefined;
  const message = typeof json.message === 'string' ? json.message : undefined;
  return {
    ok: false,
    kind,
    friendly: serverFriendly ?? defaultFriendly(kind),
    message,
    amazonSellerId: strOrUndef(json.amazonSellerId),
    reportType: strOrUndef(json.reportType),
    retryAfterMs: numOrUndef(json.retryAfterMs),
    reportId: strOrUndef(json.reportId),
    status: strOrUndef(json.status),
    httpStatus,
  };
}

/** Fallback when an infra layer answered with a bare status (no envelope). */
function statusOnlyFailure(httpStatus: number, detail?: string): ReportFailure {
  const kind = statusToKind(httpStatus);
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind),
    message:
      `Service returned HTTP ${httpStatus} without a recognized error ` +
      `envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

function statusToKind(httpStatus: number): ReportFailureKind {
  switch (httpStatus) {
    case 403:
      return 'restricted_report';
    case 404:
      return 'merchant_not_found';
    case 409:
      return 'reauth_required';
    case 429:
      return 'throttled';
    case 503:
      return 'spapi_not_configured';
    case 502:
    case 504:
      return 'host_unreachable';
    default:
      return 'unknown';
  }
}

function hostUnreachable(message: string): ReportFailure {
  return {
    ok: false,
    kind: 'host_unreachable',
    friendly:
      'The MixShift service is unreachable. Check your network or try again ' +
      'in a minute.',
    message,
  };
}

function sessionFailureFromError(err: unknown): ReportFailure {
  const message = err instanceof Error ? err.message : String(err);
  // getValidAccessToken throws two shapes: "No datahub credentials found..."
  // (never signed in) and "Your MixShift session expired..." (refresh 401).
  const expired = /expired|refresh/i.test(message);
  return {
    ok: false,
    kind: expired ? 'session_expired' : 'not_authenticated',
    friendly: expired
      ? 'Your MixShift session expired. Run `mixshift auth login` to ' +
        're-authenticate.'
      : "You're not signed in to MixShift. Run `mixshift auth login` first.",
    message,
  };
}

function defaultFriendly(kind: ReportFailureKind): string {
  switch (kind) {
    case 'spapi_not_configured':
      return (
        "Amazon SP-API isn't enabled for this MixShift account yet. Contact " +
        'MixShift ops to turn on on-demand report pulls.'
      );
    case 'reauth_required':
      return (
        'This Amazon merchant needs to be re-authorized in MixShift before ' +
        'reports can be pulled. Re-connect the account in the MixShift app, ' +
        'then retry.'
      );
    case 'restricted_report':
      return (
        'Amazon rejected this report as restricted. It requires a Restricted ' +
        'Data Token / PII role that MixShift does not hold. Pull the report in ' +
        'its default (non-PII) form, or choose a different report.'
      );
    case 'merchant_not_found':
      return (
        'No Amazon merchant matched that selector. Run `mixshift amazon ' +
        'merchants` to see which merchants you can pull for.'
      );
    case 'throttled':
      return (
        'Amazon is rate-limiting report requests right now. Wait a moment and ' +
        'retry.'
      );
    case 'report_fatal':
      return (
        'Amazon could not generate this report (it returned a FATAL or ' +
        'CANCELLED status). This usually means the report type does not apply ' +
        'to this merchant, or the requested window is invalid.'
      );
    case 'host_unreachable':
      return (
        'The MixShift service is unreachable. Check your network or try again ' +
        'in a minute.'
      );
    case 'not_authenticated':
      return (
        "You're not signed in to MixShift. Run `mixshift auth login` first."
      );
    case 'session_expired':
      return (
        'Your MixShift session expired. Run `mixshift auth login` to ' +
        're-authenticate.'
      );
    case 'unknown':
    default:
      return 'The report request failed unexpectedly. Try again shortly.';
  }
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function safeJsonPreview(json: unknown): string {
  try {
    const s = JSON.stringify(json);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  } catch {
    return String(json);
  }
}
