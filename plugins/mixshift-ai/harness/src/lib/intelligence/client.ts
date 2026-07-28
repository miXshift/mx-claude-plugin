/**
 * Client for the MixShift Intelligence service surface on mx-legacy-auth
 * (https://mcp.mixshift.io). Same Bearer token plumbing as the warehouse
 * query path (lib/data/query-runner.ts) and the Amazon report / pricing /
 * SP-API surfaces (lib/amazon/reports.ts, pricing.ts, spapi-call.ts) — this
 * module mirrors that transport SHAPE (auth, 401-force-refresh-retry, typed
 * envelope discrimination) but is deliberately NOT built on top of
 * amazonRequest: Intelligence's failure kinds (not_enrolled, unknown_insight,
 * busy, ...) are not SP-API concepts, and reports.ts's KNOWN_KINDS set is
 * closed over the SP-API vocabulary — reusing it would silently collapse
 * every real Intelligence kind down to 'unknown'. So this module owns its
 * own small, parallel transport, typed over IntelligenceFailureKind.
 *
 * What this surface is: MixShift Intelligence runs a catalog of server-side
 * insight computations ("insights" — e.g. Ops Bridge) against a merchant's
 * data and hands back a structured JSON envelope: narrative-ready numbers,
 * deltas, and named limitations, for the agent to reason over and present.
 * This module never computes anything itself; it is pure transport, plus the
 * local resumable-run ledger for the async path lives alongside it in
 * ./ledger.ts.
 *
 * Endpoints (mx-legacy-auth, LIVE):
 *   GET  /api/intelligence/ids                 → the insight catalog
 *   POST /api/intelligence/run   {id, params}  → a completed insight result,
 *                                                 OR (when params.async is
 *                                                 true) a 202 accepted+runId
 *   GET  /api/intelligence/runs/:runId         → the run's current state:
 *                                                 a `not_ready` failure kind
 *                                                 while still computing,
 *                                                 { ok:true, status:'DONE',
 *                                                 result } once done
 *
 * Failure envelope (any call): { ok:false, kind, friendly, ... }. Callers
 * branch on `kind`, never on HTTP status (carried through as `httpStatus` for
 * diagnostics only). The server's kind vocabulary: not_enrolled,
 * unknown_insight, bad_params, merchant_not_resolved, no_data_for_period,
 * account_too_large_use_async, busy, engine_error, not_ready, run_not_found.
 * Plus local-only kinds for client-side states the service never sees (no
 * creds on disk, refresh failed, network unreachable).
 */

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/** One entry from the insight catalog (GET /api/intelligence/ids). */
export interface InsightEntry {
  id: string;
  version: string;
  revision: string;
  purpose: string;
  status: string;
}

export interface CatalogResult {
  ok: true;
  entries: InsightEntry[];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Params bag for POST /api/intelligence/run. Server-validated (zod); the
 * plugin passes it through verbatim rather than re-implementing the
 * validation client-side. Known top-level fields (all optional; each insight
 * accepts a subset):
 *   - merchant     { sellerId, marketplaceId } | { brand }
 *   - period       { preset: 'last_complete_month' | 'mtd' | 'last_week' } |
 *                  { current: {start,end}, comparison: {start,end} } |
 *                  { month: 'YYYY-MM', compare: 'prior_month' | 'same_month_last_year' }
 *   - grouping / filters / metrics / scope / attachments / evidence
 *   - async        when true, the call returns a runId instead of computing
 *                  inline (the server may also require it past a size
 *                  cutoff — see the account_too_large_use_async kind)
 *   - maxStaleness
 *   - adsGrain     INS-ADS-BRIDGE-01 only
 *   - month / includeYoY   INS-MONTHLY-01 only — its whole params shape is
 *                  { merchant, month?, grouping?, includeYoY? }
 */
export type IntelligenceRunParams = Record<string, unknown>;

/** Metadata stamped on every completed insight envelope. */
export interface InsightMeta {
  insightId: string;
  revision: string;
  engineSha: string;
  methodologyVersion: string;
  computedAt: string;
  /** Shape is not fixed service-side; render defensively (see headline.ts). */
  cache?: unknown;
  [key: string]: unknown;
}

/**
 * A completed insight result: the sync `run` success shape, and the shape
 * `getRunResult` normalizes an async run's `result` into. The insight's own
 * fields are spread at the TOP level alongside `limitations` and `meta` (the
 * server does not nest them under a `payload` key) — field names beyond that
 * are insight-specific and not modeled here; see headline.ts for tolerant,
 * best-effort extraction of the ones the CLI headline surfaces.
 */
export interface InsightResult {
  ok: true;
  limitations: unknown[];
  meta: InsightMeta;
  [key: string]: unknown;
}

/** POST /run with params.async:true returns this immediately (202); the
 *  actual result is fetched later via pollRun / getRunResult. */
export interface RunAcceptedResult {
  ok: true;
  accepted: true;
  runId: string;
  status: string;
}

export type RunResult = InsightResult | RunAcceptedResult;

/** True for the async-accepted shape (has a runId to poll); false for a
 *  completed sync result. Narrows RunResult the way isIntelligenceFailure
 *  narrows the ok:false side. */
export function isAccepted(r: RunResult): r is RunAcceptedResult {
  return (r as RunAcceptedResult).accepted === true;
}

export interface RunInput {
  /** Insight catalog id, e.g. 'INS-OPS-BRIDGE-01'. */
  id: string;
  params: IntelligenceRunParams;
}

// ---------------------------------------------------------------------------
// Run lifecycle (poll / get) — both hit GET /api/intelligence/runs/:runId;
// poll is the lightweight status probe, get is the full-fetch.
// ---------------------------------------------------------------------------

/** Lightweight status probe. Deliberately does NOT carry `result` even once
 *  done, so a poll loop never holds a large payload just to check progress —
 *  call getRunResult once `ready` is true. */
export interface PollRunResult {
  ok: true;
  ready: boolean;
  /** Server status string ('DONE', 'IN_PROGRESS', ...) when the call
   *  succeeded. A run that isn't finished yet comes back as an
   *  IntelligenceFailure with kind 'not_ready', not as part of this shape —
   *  see the not_ready case in the module doc. */
  status: string;
}

// ---------------------------------------------------------------------------
// Failure model
// ---------------------------------------------------------------------------

export type IntelligenceFailureKind =
  // --- service-emitted ---
  | 'not_enrolled' // account isn't enrolled in the Intelligence closed beta
  | 'unknown_insight' // `id` is not in the catalog
  | 'bad_params' // params failed the server's zod validation
  | 'merchant_not_resolved' // params.merchant matched no merchant
  | 'no_data_for_period' // legitimate empty result, not a bug
  | 'account_too_large_use_async' // sync would exceed the size/time budget; retry --async
  | 'busy' // engine at capacity; retry later
  | 'engine_error' // the insight computation itself failed
  | 'not_ready' // async run has not finished yet (GET .../runs/:runId)
  | 'run_not_found' // runId unknown / expired
  // --- local-only (this module) ---
  | 'not_authenticated' // no datahub/service creds on disk
  | 'session_expired' // 401 even after a forced refresh
  | 'host_unreachable' // network/DNS/TLS failure reaching the service
  | 'unknown'; // anything else (unrecognized body, 500, ...)

export interface IntelligenceFailure {
  ok: false;
  kind: IntelligenceFailureKind;
  /** User-facing, safe to print verbatim. */
  friendly: string;
  /** Raw server/exception message — for logs and `--json`, not the headline. */
  message?: string;
  /** HTTP status of the failing call — diagnostics only; never branch on it. */
  httpStatus?: number;
  /** Echoed by the server on some kinds (not_ready mid-run, run_not_found). */
  runId?: string;
  /** Echoed by the server on unknown_insight / bad_params. */
  insightId?: string;
}

export function isIntelligenceFailure(
  x: { ok: boolean } | IntelligenceFailure,
): x is IntelligenceFailure {
  return x.ok === false;
}

/**
 * Map a failure kind to an exit code so terminal scripts can branch and
 * `--json` output is stable. This is a NEW, Intelligence-local exit-code
 * space — it does NOT share numbers with reports.ts / pricing.ts / the SP-API
 * surfaces (their table is a documented contract because they all share
 * ReportFailureKind; Intelligence's kind vocabulary is disjoint from that, so
 * it gets its own table rather than overloading someone else's meanings).
 */
export function exitCodeForKind(kind: IntelligenceFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in — `mixshift auth login`
    case 'not_enrolled':
      return 3; // account not enrolled in the closed beta
    case 'bad_params':
      return 4; // caller-side: fix --params / --params-file and retry
    case 'merchant_not_resolved':
      return 5; // params.merchant matched no merchant
    case 'unknown_insight':
      return 6; // `id` not in the catalog
    case 'account_too_large_use_async':
      return 7; // retry the same command with --async
    case 'busy':
      return 8; // engine at capacity — retry later
    case 'no_data_for_period':
      return 9; // legitimate empty result, not a bug
    case 'not_ready':
      return 10; // async run hasn't finished — poll again
    case 'run_not_found':
      return 11; // runId unknown / expired
    case 'engine_error':
    case 'host_unreachable':
    case 'unknown':
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface IntelligenceClientOptions {
  /** Forwarded to credential resolution (the --data-dir override). */
  dataDirOverride?: string;
  /** Skip credential lookup for the base URL (tests / local mx-legacy-auth). */
  apiBaseOverride?: string;
  /** Injectable for tests. Defaults to getValidAccessToken bound to dataDir.
   *  Takes the same forceRefresh flag so the 401-retry path works. */
  tokenProvider?: (forceRefresh?: boolean) => Promise<string>;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call network timeout. Defaults: 30s for catalog/poll/get, 60s for run. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List the insight catalog. */
export async function catalog(
  opts: IntelligenceClientOptions = {},
): Promise<CatalogResult | IntelligenceFailure> {
  const r = await intelligenceRequest(
    { method: 'GET', path: '/api/intelligence/ids' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { entries?: unknown }).entries;
  const entries = Array.isArray(raw) ? (raw as InsightEntry[]) : [];
  return { ok: true, entries };
}

/**
 * Run one insight. Sync by default (the full result comes back inline);
 * pass `params.async: true` (the CLI's --async sets this) to get a runId
 * back immediately instead — poll it with pollRun / fetch it with
 * getRunResult.
 */
export async function run(
  input: RunInput,
  opts: IntelligenceClientOptions = {},
): Promise<RunResult | IntelligenceFailure> {
  const r = await intelligenceRequest(
    { method: 'POST', path: '/api/intelligence/run', body: { id: input.id, params: input.params } },
    { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Record<string, unknown>;
  if (json.accepted === true && typeof json.runId === 'string') {
    return {
      ok: true,
      accepted: true,
      runId: json.runId,
      status: typeof json.status === 'string' ? json.status : 'PENDING',
    };
  }
  // Sync success: the service's own envelope IS the InsightResult (ok:true +
  // insight fields + limitations + meta) — pass it through as-is.
  return r.json as InsightResult;
}

/** Poll a run's status. Cheap: never carries the (potentially large)
 *  result. A still-running run comes back as an IntelligenceFailure with
 *  kind 'not_ready' — that is the server's own signal, not a client-side
 *  invention, so it flows through the same failure path as every other
 *  kind (callers branch on `kind`, same as elsewhere in this module). */
export async function pollRun(
  runId: string,
  opts: IntelligenceClientOptions = {},
): Promise<PollRunResult | IntelligenceFailure> {
  const r = await intelligenceRequest(
    { method: 'GET', path: `/api/intelligence/runs/${encodeURIComponent(runId)}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Record<string, unknown>;
  const status = typeof json.status === 'string' ? json.status : 'DONE';
  return { ok: true, ready: status === 'DONE', status };
}

/** Fetch a finished async run's full result. Call after pollRun reports
 *  ready:true (or just call this directly — a not-yet-done run answers with
 *  the same 'not_ready' failure kind poll would have surfaced). */
export async function getRunResult(
  runId: string,
  opts: IntelligenceClientOptions = {},
): Promise<InsightResult | IntelligenceFailure> {
  const r = await intelligenceRequest(
    { method: 'GET', path: `/api/intelligence/runs/${encodeURIComponent(runId)}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Record<string, unknown>;
  const status = typeof json.status === 'string' ? json.status : 'UNKNOWN';
  if (status !== 'DONE') {
    // Defensive: the server is contracted to signal "still running" via the
    // not_ready failure kind (caught by `if (!r.ok)` above). If it ever
    // instead answers ok:true with a non-DONE status, treat that the same
    // way rather than handing the caller a half-formed "success".
    return {
      ok: false,
      kind: 'not_ready',
      friendly: defaultFriendly('not_ready'),
      runId,
    };
  }
  const rawResult = json.result;
  const resultObj =
    rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
      ? (rawResult as Record<string, unknown>)
      : {};
  if (resultObj.ok === false) {
    // The run finished (status DONE), but the insight computation itself
    // failed mid-run (bad_params, engine_error, ...). The server nests the
    // exact same `{ ok:false, kind, friendly, ... }` shape the sync path
    // gets at the TOP level one level down, inside `result` — route it
    // through the same mapping (toIntelligenceFailure) rather than
    // coercing a real failure into a fake success.
    return toIntelligenceFailure(resultObj, r.httpStatus);
  }
  // Force ok:true only when the field is genuinely absent — server success
  // payloads don't echo `ok` themselves (see InsightResult's module doc).
  // resultObj.ok, if present here, can only be `true` (an explicit `false`
  // was already handled above), so this never overwrites a real value.
  return {
    ...resultObj,
    ok: resultObj.ok === undefined ? true : resultObj.ok,
  } as unknown as InsightResult;
}

// ---------------------------------------------------------------------------
// Internal request plumbing (mirrors reports.ts's amazonRequest SHAPE; see
// the module doc for why this is a parallel implementation, not a reuse)
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

type RequestSuccess = { ok: true; json: unknown; httpStatus: number };

async function intelligenceRequest(
  spec: RequestSpec,
  opts: IntelligenceClientOptions,
): Promise<RequestSuccess | IntelligenceFailure> {
  const resolved = await resolveBaseAndToken(opts);
  // Only IntelligenceFailure carries an `ok` key; ResolvedConn does not — so
  // this is a clean discriminant and the else-branch narrows to ResolvedConn
  // (mirrors amazonRequest's own discrimination in reports.ts).
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
  // it. Force a refresh and retry exactly once (matches query-runner /
  // amazonRequest).
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

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return statusOnlyFailure(res.status);
  }

  if (isServerFailureEnvelope(json)) {
    return toIntelligenceFailure(json, res.status);
  }

  if (!res.ok) {
    return statusOnlyFailure(res.status, safeJsonPreview(json));
  }

  return { ok: true, json, httpStatus: res.status };
}

interface ResolvedConn {
  apiBase: string;
  tokenProvider: (forceRefresh?: boolean) => Promise<string>;
}

/** Resolve the base URL + a token provider, or a local failure envelope. */
async function resolveBaseAndToken(
  opts: IntelligenceClientOptions,
): Promise<ResolvedConn | IntelligenceFailure> {
  let apiBase = opts.apiBaseOverride;
  if (!apiBase) {
    const { credentials } = await loadCredentials(opts.dataDirOverride);
    // datahub (user session) wins; service (machine credential) is the
    // unattended fallback — same precedence getValidAccessToken applies for
    // the Bearer itself.
    const base = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!base) {
      return {
        ok: false,
        kind: 'not_authenticated',
        friendly:
          "You're not signed in to MixShift. Run `mixshift auth login` (or " +
          'say "sign in to MixShift" in chat) before using MixShift ' +
          'Intelligence. For unattended runs, configure ' +
          '`mixshift auth service-setup`.',
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

const KNOWN_KINDS: ReadonlySet<string> = new Set<IntelligenceFailureKind>([
  'not_enrolled',
  'unknown_insight',
  'bad_params',
  'merchant_not_resolved',
  'no_data_for_period',
  'account_too_large_use_async',
  'busy',
  'engine_error',
  'not_ready',
  'run_not_found',
  'not_authenticated',
  'session_expired',
  'host_unreachable',
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

/** Map a server `{ ok:false, kind, ... }` envelope to a typed
 *  IntelligenceFailure, trusting the server's kind when recognized and
 *  filling a friendly default when the server omitted one. */
function toIntelligenceFailure(
  json: Record<string, unknown>,
  httpStatus: number,
): IntelligenceFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const kind: IntelligenceFailureKind = KNOWN_KINDS.has(rawKind)
    ? (rawKind as IntelligenceFailureKind)
    : 'unknown';
  const serverFriendly = typeof json.friendly === 'string' ? json.friendly : undefined;
  const message = typeof json.message === 'string' ? json.message : undefined;
  return {
    ok: false,
    kind,
    friendly: serverFriendly ?? defaultFriendly(kind),
    message,
    httpStatus,
    runId: strOrUndef(json.runId),
    insightId: strOrUndef(json.insightId),
  };
}

/** Fallback when an infra layer answered with a bare status (no envelope).
 *  Best-effort ONLY: the server's own `kind` field (toIntelligenceFailure)
 *  is always trusted first — this fires only on a degenerate response. */
function statusOnlyFailure(httpStatus: number, detail?: string): IntelligenceFailure {
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

function statusToKind(httpStatus: number): IntelligenceFailureKind {
  switch (httpStatus) {
    case 202:
      return 'not_ready';
    case 400:
    case 422:
      return 'bad_params';
    case 403:
      return 'not_enrolled';
    case 404:
      return 'run_not_found';
    case 409:
    case 429:
      return 'busy';
    case 502:
    case 504:
      return 'host_unreachable';
    case 503:
      return 'engine_error';
    default:
      return 'unknown';
  }
}

function hostUnreachable(message: string): IntelligenceFailure {
  return {
    ok: false,
    kind: 'host_unreachable',
    friendly:
      'The MixShift service is unreachable. Check your network or try again ' +
      'in a minute.',
    message,
  };
}

function sessionFailureFromError(err: unknown): IntelligenceFailure {
  const message = err instanceof Error ? err.message : String(err);
  // getValidAccessToken throws two shapes: "No credentials found..." (never
  // signed in) and "Your MixShift session expired..." (refresh 401).
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

function defaultFriendly(kind: IntelligenceFailureKind): string {
  switch (kind) {
    case 'not_enrolled':
      return (
        "This MixShift account isn't enrolled in MixShift Intelligence yet " +
        '(closed beta). Contact MixShift ops to get enrolled.'
      );
    case 'unknown_insight':
      return (
        'That insight id is not in the current catalog. Run `mixshift ' +
        'intelligence catalog` to see the available ids.'
      );
    case 'bad_params':
      return (
        'The params for this insight did not pass validation. Check the ' +
        'catalog entry for the expected shape and retry.'
      );
    case 'merchant_not_resolved':
      return (
        'No merchant matched params.merchant. Double-check the sellerId / ' +
        'marketplaceId or brand.'
      );
    case 'no_data_for_period':
      return (
        'There is no data for the requested period. This is not an error, ' +
        'just try a different period.'
      );
    case 'account_too_large_use_async':
      return (
        'This account is too large to compute synchronously. Retry the ' +
        'same command with --async, then poll the returned runId.'
      );
    case 'busy':
      return 'MixShift Intelligence is busy right now. Wait a moment and retry.';
    case 'engine_error':
      return (
        'The insight engine failed to compute this run. Try again shortly; ' +
        'contact MixShift ops if it persists.'
      );
    case 'not_ready':
      return 'This run has not finished yet. Poll again in a few seconds.';
    case 'run_not_found':
      return (
        'No run matches that runId (it may have expired, or never ' +
        'existed). Check `mixshift intelligence runs` for recent handles.'
      );
    case 'not_authenticated':
      return "You're not signed in to MixShift. Run `mixshift auth login` first.";
    case 'session_expired':
      return (
        'Your MixShift session expired. Run `mixshift auth login` to ' +
        're-authenticate.'
      );
    case 'host_unreachable':
      return (
        'The MixShift service is unreachable. Check your network or try ' +
        'again in a minute.'
      );
    case 'unknown':
    default:
      return 'The Intelligence request failed unexpectedly. Try again shortly.';
  }
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function safeJsonPreview(json: unknown): string {
  try {
    const s = JSON.stringify(json);
    return s.length > 300 ? s.slice(0, 300) + '...' : s;
  } catch {
    return String(json);
  }
}
