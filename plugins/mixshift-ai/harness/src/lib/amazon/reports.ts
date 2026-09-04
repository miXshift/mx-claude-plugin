/**
 * Client for the Amazon SP-API on-demand report surface on mx-legacy-auth
 * (https://mcp.mixshift.io). Same Bearer token as the warehouse query path
 * (see data/query-runner.ts) — this module is the amazon-report analogue.
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
 *     credentials; we send a Bearer token and a report request, and the service
 *     hands back Amazon's short-lived presigned download URL (never the bytes).
 *
 * Lifecycle (keyed by `runId`, a service-minted UUID):
 *   startReport  → POST   /api/amazon/reports                 → { runId }
 *   pollReport   → GET    /api/amazon/reports/:runId          → { ready, status }
 *   getReport... → GET    /api/amazon/reports/:runId/document → { ready, document?:{ url, ... } }
 *
 * `ready` (boolean) is the signal — do NOT parse Amazon's status string to
 * decide done-ness. `getReportDocument` is safe to call early: before the
 * report is ready it returns { ok:true, ready:false, status } (NOT an error),
 * which is what lets the chat skill poll across separate tool calls without a
 * blocking loop (Cowork caps Bash at ~45s — same constraint that forced the
 * two-phase device-code auth flow).
 *
 * Document fetch (a real gotcha): the service NEVER returns bytes inline. When
 * `ready`, `getReportDocument`'s response carries `document: { url,
 * compressionAlgorithm, reportDocumentId }`, where `url` is Amazon's presigned
 * S3 link (short-lived, minutes). THIS module fetches that URL directly — with
 * NO Authorization header (it is presigned; sending the Bearer makes S3 reject
 * it) — then gunzips when `compressionAlgorithm === 'GZIP'`, and returns the
 * decoded text in `document`. Flat-file reports decode to TSV (sometimes with a
 * UTF-8 BOM); vendor reports and Brand Analytics decode to JSON. We do not
 * transcode; the catalog's `document_format` tells callers which it is. If the
 * presigned URL has expired, re-call `getReportDocument` for a fresh one (the
 * underlying report stays DONE).
 *
 * Failure envelope (any call): { ok:false, kind, friendly, message?, ...extra }.
 * Callers branch on `kind`, never on HTTP status — the service normalizes
 * Amazon's many failure modes into a small set of kinds. The HTTP status is
 * carried through as `httpStatus` for diagnostics only.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';
import { intentHeader } from '../auth/intent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A merchant the signed-in tenant can pull reports for. Mirrors the service
 *  MerchantView. The service lists one row per (account, marketplace), gated
 *  on a stored SP-API authorization. SP-API tokens are REGION-scoped, so the
 *  list includes every marketplace row the seller's region token covers — not
 *  just the rows MixShift pulls on a cron (`cronActive`). A row with
 *  cronActive=false is still fully pullable on demand.
 *
 *  Disambiguation: one `amazonSellerId` (Amazon's merchant token) is SHARED
 *  across a seller's marketplaces, so a seller live in US / CA / MX / BR shows
 *  up as four rows that share an `amazonSellerId` but each have a distinct
 *  `legacySellerId` + `marketplaceId`. `amazonSellerId` alone is therefore NOT
 *  a unique selector: a report-start that sends only the shared token lets the
 *  service re-resolve and can attribute the run to the wrong marketplace.
 *  `legacySellerId` is the exact, per-marketplace record id and the
 *  deterministic disambiguator — carry it through report-start (it takes
 *  precedence over sellerId + marketplace). */
export interface MerchantView {
  amazonSellerId: string;
  name: string;
  merchantType: 'Seller' | 'Vendor';
  merchantRegion: string;
  /** Real Amazon marketplace id for THIS row, e.g. ATVPDKIKX0DER. The service
   *  now populates it on every row (COALESCE of the seller's own value with the
   *  marketplace lookup). */
  marketplaceId: string | null;
  /** Marketplace country code for this row, e.g. US / CA / MX / BR. */
  countryCode?: string | null;
  /** Marketplace display name (e.g. "Amazon.com"), when the service provides
   *  it. Display-only. */
  marketplaceName?: string | null;
  /** Exact per-marketplace warehouse seller record id (warehouse `seller.ID`).
   *  UNIQUE per (account, marketplace) even when `amazonSellerId` is shared.
   *  The authoritative disambiguator: carry it through report-start. */
  legacySellerId?: number | string | null;
  /** Service-derived flag: true when the SP-API authorization is believed live;
   *  false is the warn-before-pull signal (a pull may fail with reauth_required).
   *  Derived server-side (mx-legacy-auth) — NOT from a single `iLostAccess`
   *  column (the warehouse has none; lost-access is surface-specific:
   *  isAdLostAccess / isBrandAnalyticsLostAccess / isFinanceLostAccess). The
   *  derivation can false-negative (false on a fully-active seller), so treat
   *  false as "warn and verify", not "blocked". */
  authorized: boolean;
  /** True when this row is activated for MixShift's SCHEDULED cron pulls
   *  (legacy IsMwsUser). Display/filter signal only — NOT an auth gate; rows
   *  with cronActive=false are still pullable on demand. Optional because
   *  older service deploys do not send it. */
  cronActive?: boolean;
}

/** One candidate row returned in a `merchant_not_found` failure when a shared
 *  `amazonSellerId` trades in several marketplaces and no `marketplace` /
 *  `legacySellerId` was given to disambiguate. Re-run report-start with one of
 *  these `legacySellerId`s (or the matching `marketplace`). */
export interface MerchantCandidate {
  legacySellerId?: number | string;
  amazonSellerId?: string;
  marketplaceId?: string | null;
  countryCode?: string | null;
  marketplaceName?: string | null;
  name?: string;
}

/** Kinds the service emits, plus two local-only kinds for client-side states
 *  the service never sees (no creds on disk; refresh failed). Branch on this. */
export type ReportFailureKind =
  // --- service-emitted ---
  | 'spapi_not_configured' // 503 — SP-API not enabled for this tenant
  | 'ads_not_configured' // 503 — Amazon Ads API creds not set on the service
  | 'insufficient_scope' // 403 — credential lacks a required scope (ads:write)
  | 'reauth_required' // 409 — merchant grant lapsed; +amazonSellerId
  | 'bad_request' // 400 — AMAZON rejected the request; +amazonErrorCode. Terminal: do not retry
  | 'restricted_report' // 403 — Amazon needs an RDT/PII role we lack; +reportType
  | 'merchant_not_found' // 404 — no merchant matched the selector
  | 'throttled' // 429 — Amazon rate limit; +retryAfterMs
  | 'report_fatal' // 502 — Amazon returned FATAL/CANCELLED; +reportId,status
  | 'host_unreachable' // 502 — service couldn't reach Amazon
  // --- service-emitted, added 2026-09-04 (mx-ops#43) ---
  // All kinds the GATEWAY already emits (ALL_SPAPI_ERROR_KINDS in
  // mx-legacy-auth token-source.ts). Until now the plugin did not list them,
  // so every one arrived and was stamped `unknown` — undoing at the client
  // exactly the split the service made on purpose. User-facing copy is
  // unaffected: the envelope's own `friendly` is preferred over ours.
  | 'report_retired' // 400 — report type Amazon has retired. Terminal
  | 'upstream_unavailable' // 502 — service reached Amazon, Amazon was down
  | 'listings_write_disabled' // 503 — listings writes off service-wide
  | 'listings_media_write_disabled' // 503 — media writes off service-wide
  | 'listings_write_not_enabled' // 403 — not enabled for this tenant
  | 'patch_not_allowed' // 422 — the requested patch is not permitted
  | 'change_set_not_found' // 404 — no such change set
  | 'change_set_expired' // 409 — change set aged out before commit
  | 'change_set_already_committed' // 409 — already committed
  | 'approval_mismatch' // 409 — approval does not match the change set
  | 'stale_approval' // 409 — approval superseded
  | 'schema_drift' // 409 — listing schema moved under the change set
  // --- local-only (this module) ---
  | 'not_authenticated' // no datahub creds on disk; run `mixshift auth login`
  | 'session_expired' // 401 even after a forced refresh
  | 'download_failed' // presigned document download stalled/dropped after retries
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
  /** On `merchant_not_found` when the seller is multi-marketplace: the rows to
   *  choose from. Re-run report-start with one row's `legacySellerId` (or the
   *  matching `marketplace`). */
  candidates?: MerchantCandidate[];
  /** HTTP status of the failing call — diagnostics only; do not branch on it. */
  httpStatus?: number;
  /** Set ONLY when the service sent a `kind` this build does not recognize
   *  (or sent none at all, recorded as `(absent)`). Carries the raw wire
   *  value so gateway/client contract drift stays visible instead of being
   *  normalized away into `unknown`. Empty on every healthy response. */
  unrecognizedKind?: string;
  /** AMAZON's own error code on `bad_request` (`InvalidInput`,
   *  `InvalidParameterValue`, ...). Low-cardinality and identifier-free, which
   *  is why this is the field worth recording and quoting in a bug report. */
  amazonErrorCode?: string;
  /** AMAZON's own HTTP status, distinct from `httpStatus` (ours).
   *
   *  Previously lost: the service sends it as a NUMBER under `status`, but
   *  `status` is also used as a report-processing STRING by report_fatal, and
   *  the string-only coercion silently dropped the number. */
  amazonStatus?: number;
  /** Amazon's full response body, passed through verbatim when the service
   *  captured it. Dropped entirely until now, which meant a user reporting a
   *  failure had nothing complete to send us. */
  responsePayload?: unknown;
  /** Bounded raw text, when the body was not JSON. */
  responseText?: string;
}

export interface ListMerchantsResult {
  ok: true;
  merchants: MerchantView[];
}

export interface StartReportInput {
  /** Which merchant to pull for. The plugin keys merchants on amazonSellerId
   *  (from `listMerchants`); on the wire it goes as `sellerId`. Optional when
   *  the tenant has exactly one merchant (the service infers it); required when
   *  there's more than one. NOTE: a shared amazonSellerId is NOT unique across
   *  marketplaces — pair it with `legacySellerId` (and/or `marketplace`) so the
   *  service targets the intended record rather than re-resolving and guessing. */
  amazonSellerId?: string;
  /** Exact per-marketplace warehouse seller record id (`legacySellerId` from
   *  `listMerchants`). When present this is the AUTHORITATIVE disambiguator: it
   *  pins the run to one record so the service does not re-resolve a shared
   *  amazonSellerId to the wrong marketplace. Send it whenever the merchants
   *  row provides one; goes on the wire as `legacySellerId`. */
  legacySellerId?: number | string;
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

/** Amazon's own report timestamps, passed straight through by the service.
 *  All optional: Amazon omits a field until that phase completes. Use them to
 *  record the true data window / processing latency. */
export interface ReportTimings {
  createdTime?: string;
  processingStartTime?: string;
  processingEndTime?: string;
}

export interface GetReportDocumentResult {
  ok: true;
  /** False when the report isn't done yet (this is NOT an error; keep
   *  polling). True when `document` is populated. */
  ready: boolean;
  status?: string;
  /** Decoded document text (TSV or JSON per the catalog). This module fetched
   *  Amazon's presigned URL and gunzipped it for you. Undefined while `ready`
   *  is false. May carry a leading UTF-8 BOM for flat files; strip before
   *  parsing if your parser doesn't. */
  document?: string;
  /** Decoded byte length of `document` (post-gunzip). Present when `ready`. */
  bytes?: number;
  /** Amazon's reportDocumentId, for cross-referencing in support. */
  reportDocumentId?: string;
  /** The compression Amazon applied to the presigned object ("GZIP" | null).
   *  Informational once decoded. */
  compressionAlgorithm?: string | null;
  /** Amazon's create / processing timestamps, when present. */
  timings?: ReportTimings;
}

/** Metadata-only result of the document GET: readiness + Amazon's presigned
 *  URL, WITHOUT downloading the bytes. This is the large-report-safe entry
 *  point. Pass `document` to streamReportDocumentToFile to write the bytes to
 *  disk in chunks, never materializing them as a string (which would crash
 *  toString() at V8's ~2 GB string limit on multi-GB reports). */
export interface GetReportDocumentMetaResult {
  ok: true;
  /** False when the report isn't done yet (NOT an error; keep polling). */
  ready: boolean;
  status?: string;
  /** Present only when ready AND the service returned a usable presigned URL. */
  document?: DocumentMeta;
  timings?: ReportTimings;
}

/** Result of streaming a presigned document straight to a file. */
export interface StreamReportDocumentResult {
  ok: true;
  /** Bytes written to disk (decompressed, post-gunzip when GZIP). */
  bytes: number;
  /** The presigned object's compression. Informational once written. */
  compressionAlgorithm?: string | null;
  /** Amazon's reportDocumentId, for support cross-reference. */
  reportDocumentId?: string;
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

/**
 * Map a failure kind to an exit code so terminal scripts can branch. Chat
 * reads the typed kind from --json instead. The one mapping for every command
 * surface that emits ReportFailure (reports, pricing) — the codes are a
 * documented contract in the mx-amazon-report skill, so the surfaces must not
 * drift apart. Mirrors data.ts using 4 for the "Amazon won't let us" case
 * (restricted) like access_denied_table=4.
 */
export function exitCodeForKind(kind: ReportFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in / re-login (run `mixshift auth login`)
    case 'restricted_report':
      return 4; // Amazon needs an RDT/PII role MixShift lacks
    case 'reauth_required':
      return 5; // merchant grant lapsed — reconnect this merchant
    case 'spapi_not_configured':
    case 'ads_not_configured':
      return 6; // the relevant Amazon API is not enabled on the service
    case 'merchant_not_found':
      return 7; // selector matched no merchant
    case 'insufficient_scope':
      return 11; // credential lacks a required scope (e.g. ads:write)
    case 'throttled':
      return 8; // Amazon rate limit — retry later
    case 'report_fatal':
      return 9; // Amazon returned FATAL / CANCELLED
    case 'bad_request':
      return 12; // Amazon rejected the request itself — terminal, fix and resend
    case 'host_unreachable':
    case 'download_failed': // transient download failure — retry the fetch
    case 'unknown':
    default:
      return 1;
  }
}

/** Cap for the exponential backoff FALLBACK (used only when the service does
 *  not report a retry-after). A server-reported retryAfterMs is honored in full
 *  (bounded by the run deadline), since Amazon told us exactly how long to wait. */
export const THROTTLE_BACKOFF_CAP_MS = 30_000;

/** Floor for the effective poll interval used by the backoff. Guards a
 *  degenerate/zero/NaN `--interval-ms` (and a very small one) so a 429 still
 *  yields a real wait instead of a 0ms "give up" or a hammer-the-limit retry. */
export const THROTTLE_BACKOFF_FLOOR_MS = 1_000;

/**
 * How long (ms) to wait before the next poll after Amazon rate-limits us
 * (429 -> `throttled`). `report run` polls in a loop; a single 429 is transient
 * (the poll was rate-limited, not the pull), so instead of failing the whole run
 * we back off and re-poll. This computes the wait:
 *   - honor the service-reported `retryAfterMs` when present (Amazon told us);
 *     a missing/zero/negative/NaN retryAfterMs is treated as absent;
 *   - otherwise exponential backoff off the (floored) interval, capped, so a
 *     sustained rate-limit spaces polls out instead of hammering the limit;
 *   - floor the effective interval at THROTTLE_BACKOFF_FLOOR_MS, and never wait
 *     past the run deadline. Returns 0 ONLY once the deadline has passed, which
 *     the caller uses as the "stop now" sentinel — so a positive `remaining`
 *     always yields a positive wait.
 *
 * `streak` is the count of consecutive throttled polls (1 on the first). Pure
 * and deterministic (caller passes `now`) so it is unit-testable.
 */
export function throttleBackoffMs(
  retryAfterMs: number | undefined,
  intervalMs: number,
  streak: number,
  now: number,
  deadline: number,
): number {
  const remaining = deadline - now;
  if (remaining <= 0) return 0;
  // Sanitize the interval (0/NaN/negative -> floor) so the wait is always real.
  const eff = Math.max(intervalMs || 0, THROTTLE_BACKOFF_FLOOR_MS);
  const base =
    retryAfterMs && retryAfterMs > 0
      ? retryAfterMs
      : Math.min(
          eff * 2 ** Math.min(Math.max(streak, 1) - 1, 5),
          THROTTLE_BACKOFF_CAP_MS,
        );
  return Math.min(Math.max(base, eff), remaining);
}

// ---------------------------------------------------------------------------
// Search Query Performance (SQP) ASIN-option chunking + merge
//
// SQP (GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) is the one report
// type modeled here that REQUIRES a reportOptions.asin value: a
// space-separated ASIN list, capped by Amazon at SQP_ASIN_OPTION_CHAR_LIMIT
// characters per report (~18 ASINs). Omit it and Amazon accepts the
// createReport call, then fails the run with FATAL during processing -- a
// slow, confusing failure with no useful error (confirmed live against a
// beta user's account). The product requirement is that a caller can ask for
// ANY number of ASINs; `report run` (commands/amazon.ts) uses these two pure
// helpers to auto-batch a long ASIN list into multiple <=200-char pulls and
// merge the resulting JSON documents back into one.
// ---------------------------------------------------------------------------

/** Amazon's Search Query Performance report type enum. */
export const SQP_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';

/** Amazon's hard cap on the reportOptions.asin value for SQP: a
 *  space-separated ASIN list, at most this many characters (about 18 real
 *  10-character ASINs plus separators). Amazon rejects a longer value
 *  outright -- this is not a soft/throughput limit. */
export const SQP_ASIN_OPTION_CHAR_LIMIT = 200;

/**
 * Split a whitespace-separated ASIN list into chunks that each fit within
 * `charLimit`, so a caller can auto-batch an arbitrarily long list into
 * multiple SQP report pulls.
 *
 *   - Splits on any run of whitespace (not just single spaces); empty tokens
 *     are dropped.
 *   - Dedupes, preserving first-seen order -- a repeated ASIN would otherwise
 *     double-count in the merged report.
 *   - Greedily packs tokens into space-joined chunks, each <= charLimit.
 *   - A single token longer than charLimit cannot be a valid ASIN (real
 *     ASINs are 10 characters) and cannot fit in any chunk on its own, so it
 *     throws rather than silently emitting a chunk Amazon would reject.
 *   - Blank/empty input returns `{ asins: [], chunks: [] }`; the caller
 *     decides whether an empty ASIN list is an error (see the SQP preflight
 *     in commands/amazon.ts).
 */
export function chunkAsinList(
  raw: string,
  charLimit: number = SQP_ASIN_OPTION_CHAR_LIMIT,
): { asins: string[]; chunks: string[] } {
  const seen = new Set<string>();
  const asins: string[] = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    asins.push(tok);
  }
  if (asins.length === 0) return { asins: [], chunks: [] };

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const asin of asins) {
    if (asin.length > charLimit) {
      throw new Error(
        `"${asin}" is ${asin.length} characters, longer than the ${charLimit}-character ` +
          'reportOptions.asin cap by itself -- it cannot be a valid ASIN (Amazon ASINs are ' +
          '10 characters).',
      );
    }
    const candidateLen = current.length === 0 ? asin.length : currentLen + 1 + asin.length;
    if (candidateLen > charLimit) {
      chunks.push(current.join(' '));
      current = [asin];
      currentLen = asin.length;
    } else {
      current.push(asin);
      currentLen = candidateLen;
    }
  }
  if (current.length > 0) chunks.push(current.join(' '));

  return { asins, chunks };
}

/**
 * Merge N SQP report documents (one per chunked reportOptions.asin pull)
 * into a single document matching Amazon's official
 * sellingPartnerSearchQueryPerformanceReport.json shape: a top-level
 * `reportSpecification` object plus a `dataByAsin` array.
 *
 * Concatenates every chunk's `dataByAsin` array in order into the first
 * chunk's document (which supplies the base `reportSpecification` and any
 * other top-level fields). When that base's
 * `reportSpecification.reportOptions.asin` is a string, it is rewritten to
 * `fullAsinList` so the merged document's spec reflects the full request
 * rather than just the first chunk's slice.
 *
 * A single document is a valid (degenerate) input: it comes back
 * re-serialized with the same asin fix-up applied.
 */
export function mergeSqpDocuments(docs: string[], fullAsinList: string): string {
  if (docs.length === 0) {
    throw new Error('mergeSqpDocuments: no documents to merge');
  }

  let base: Record<string, unknown> | undefined;
  let dataByAsin: unknown[] = [];

  docs.forEach((doc, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc);
    } catch (err) {
      throw new Error(
        `SQP chunk ${i + 1} of ${docs.length} is not valid JSON: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).dataByAsin)
    ) {
      throw new Error(
        `SQP chunk ${i + 1} of ${docs.length} is missing a dataByAsin array -- not a ` +
          'recognizable SQP report document.',
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (i === 0) base = obj;
    dataByAsin = dataByAsin.concat(obj.dataByAsin as unknown[]);
  });

  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  merged.dataByAsin = dataByAsin;

  const spec = merged.reportSpecification;
  if (typeof spec === 'object' && spec !== null) {
    const specObj = spec as Record<string, unknown>;
    const options = specObj.reportOptions;
    if (
      typeof options === 'object' &&
      options !== null &&
      typeof (options as Record<string, unknown>).asin === 'string'
    ) {
      merged.reportSpecification = {
        ...specObj,
        reportOptions: { ...(options as Record<string, unknown>), asin: fullAsinList },
      };
    }
  }

  return JSON.stringify(merged);
}

/** List merchants the signed-in tenant can pull reports for. */
export async function listMerchants(
  opts: ReportClientOptions = {},
): Promise<ListMerchantsResult | ReportFailure> {
  // Deliberately NO surface: the merchant list is shared by reports, the
  // passthrough, Ads and pricing alike, so naming any one of them here would
  // be the very mislabelling this change removes. Falls back to
  // surface-free wording.
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
  //   { reportType, sellerId?, legacySellerId?, marketplace?, start?, end?, reportOptions? }
  // The plugin's internal field is amazonSellerId; it goes on the wire as
  // `sellerId`. `legacySellerId` (when present) is the exact per-marketplace
  // record id and the authoritative disambiguator — it stops the service
  // re-resolving a shared sellerId to the wrong marketplace. Omit any field
  // that's absent so the service applies its defaults (e.g. single-merchant
  // sellerId inference, default marketplace).
  const body: Record<string, unknown> = {
    reportType: input.reportType,
  };
  if (input.amazonSellerId) body.sellerId = input.amazonSellerId;
  if (
    input.legacySellerId !== undefined &&
    input.legacySellerId !== null &&
    input.legacySellerId !== ''
  ) {
    // The warehouse `seller.ID` is numeric; the CLI passes it as a string. Send
    // it as a number when it is purely numeric (the service's example payloads
    // use a JSON number), else pass through as-is.
    const n =
      typeof input.legacySellerId === 'string'
        ? Number(input.legacySellerId)
        : input.legacySellerId;
    body.legacySellerId =
      typeof n === 'number' && Number.isFinite(n) ? n : input.legacySellerId;
  }
  if (input.start) body.start = input.start;
  if (input.end) body.end = input.end;
  if (input.marketplace) body.marketplace = input.marketplace;
  if (input.reportOptions) body.reportOptions = input.reportOptions;

  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/reports', body, surface: 'report' },
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
    { method: 'GET', path: `/api/amazon/reports/${encodeURIComponent(runId)}`, surface: 'report' },
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
 * Metadata-only document fetch: the document GET, WITHOUT downloading the
 * bytes. Safe to call before the report is ready (returns ready:false, which
 * is NOT an error). When ready, `document` carries Amazon's short-lived
 * presigned URL. Pair this with streamReportDocumentToFile for the
 * large-report-safe path (the --out flow); getReportDocument is the
 * convenience that also downloads + decodes a size-capped inline copy.
 */
export async function getReportDocumentMeta(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<GetReportDocumentMetaResult | ReportFailure> {
  const r = await amazonRequest(
    {
      method: 'GET',
      path: `/api/amazon/reports/${encodeURIComponent(runId)}/document`,
      surface: 'report',
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const json = r.json as {
    ready?: unknown;
    status?: unknown;
    document?: unknown;
    timings?: unknown;
  };
  const ready = json.ready === true;
  const status = typeof json.status === 'string' ? json.status : undefined;
  const timings = parseTimings(json.timings);
  const document = parseDocumentMeta(json.document);
  // `document` is undefined until ready (and until the presigned URL exists),
  // which callers treat as "keep polling."
  return { ok: true, ready, status, document, timings };
}

/**
 * Fetch + decode an INLINE copy of the document. A convenience for small docs
 * and the stdout path. Safe to call before ready (returns ready:false).
 *
 * IMPORTANT: this materializes the decoded document as a single JS string, so
 * it enforces an inline size cap (MAX_INLINE_DOCUMENT_BYTES) and fails cleanly
 * on anything larger, pointing the caller at --out. It will NOT crash on a
 * multi-GB report the way an unbounded toString() would. For arbitrarily large
 * reports use getReportDocumentMeta + streamReportDocumentToFile instead.
 */
export async function getReportDocument(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<GetReportDocumentResult | ReportFailure> {
  const meta = await getReportDocumentMeta(runId, opts);
  if (!meta.ok) return meta;

  // Not ready (or no document yet): keep polling. NOT an error.
  if (!meta.ready || !meta.document) {
    return { ok: true, ready: meta.ready, status: meta.status, timings: meta.timings };
  }

  // Ready: fetch Amazon's presigned URL ourselves and decode a capped copy.
  const fetched = await fetchDocumentBytes(
    meta.document.url,
    meta.document.compressionAlgorithm,
    opts,
  );
  if (!fetched.ok) return fetched;

  return {
    ok: true,
    ready: true,
    status: meta.status,
    document: fetched.text,
    bytes: fetched.bytes,
    reportDocumentId: meta.document.reportDocumentId,
    compressionAlgorithm: meta.document.compressionAlgorithm,
    timings: meta.timings,
  };
}

/** How many times to (re)attempt the presigned download before giving up. A
 *  large report doc that stalls or drops mid-stream is transient; earlier this
 *  bucketed as a single-shot `unknown` failure that forced manual re-runs
 *  (Elevate, 0.8.5, re-ran 3x by hand). */
export const DEFAULT_DOWNLOAD_ATTEMPTS = 3;
/** Per-attempt STALL timeout: abort an attempt only after this long with NO
 *  progress (no headers, no bytes). A download that keeps making progress is
 *  never killed, however long the whole transfer takes — the fix for the old
 *  single 120s TOTAL timeout that failed large-but-healthy downloads. */
export const DEFAULT_DOWNLOAD_STALL_MS = 60_000;
/** Per-attempt overall backstop: abort even a steadily-progressing attempt past
 *  this, so a pathological trickle can't run unbounded. Generous — a legitimate
 *  multi-hundred-MB report at target scale finishes well within it. */
export const DEFAULT_DOWNLOAD_DEADLINE_MS = 10 * 60_000;
const DOWNLOAD_BACKOFF_BASE_MS = 500;
const DOWNLOAD_BACKOFF_CAP_MS = 8_000;

/** Tuning knobs for the streaming download, on top of the shared client opts.
 *  All optional; the defaults above apply. Injectable for tests. */
export interface StreamDocumentOptions extends ReportClientOptions {
  /** Max download attempts (default {@link DEFAULT_DOWNLOAD_ATTEMPTS}). */
  maxDownloadAttempts?: number;
  /** Per-attempt inactivity timeout (default {@link DEFAULT_DOWNLOAD_STALL_MS}). */
  downloadStallMs?: number;
  /** Per-attempt overall deadline (default {@link DEFAULT_DOWNLOAD_DEADLINE_MS}). */
  downloadDeadlineMs?: number;
  /** Backoff sleeper between retries. Defaults to a real timer; tests inject a
   *  no-op so the retry path runs instantly. */
  sleepImpl?: (ms: number) => Promise<void>;
}

/** One attempt's outcome. `retryable` says whether re-attempting could help;
 *  `expired` marks a presigned-link expiry (403/410) whose fix is a fresh link,
 *  not a retry of the same URL; `opened` is true once THIS attempt created the
 *  output file (so the loop only salvages a file we actually wrote, never a
 *  pre-existing file we failed before touching). */
type DownloadAttempt =
  | { ok: true; bytes: number }
  | { ok: false; retryable: boolean; expired: boolean; opened: boolean; failure: ReportFailure };

/**
 * Stream a presigned report document straight to a file, in chunks, never
 * materializing it as a string. THIS is the large-report-safe path behind
 * --out on `report get` / `report run`: it pipes Amazon's presigned response
 * body through a gunzip transform (when GZIP) into the destination file, so a
 * report of any size lands on disk without the V8 string-length crash.
 *
 * Reliability (v2): a large doc can take minutes and can stall or drop
 * mid-stream. Instead of one 120s TOTAL timeout with no retry (which bucketed
 * failures as `unknown` and forced manual re-runs), each attempt uses a STALL
 * timeout (reset on every chunk) plus a generous overall backstop, and a
 * transient failure (network drop, stall, 5xx, mid-stream error) is retried
 * with backoff. A link expiry (403/410) is NOT retried against the same URL —
 * it surfaces the clear "re-run get for a fresh link" message. When every
 * attempt fails transiently, the result is classed `download_failed` (a real
 * error_class, never `unknown`) so telemetry and the reliability sweep see a
 * clean, actionable signature.
 *
 * Sends NO Authorization header (presigned link; a Bearer makes S3 reject it).
 * The parent directory is created if missing; a partially-written file from the
 * final failed attempt is renamed to `<outPath>.partial` so no consumer reads a
 * truncated report as complete.
 */
export async function streamReportDocumentToFile(
  document: DocumentMeta,
  outPath: string,
  opts: StreamDocumentOptions = {},
): Promise<StreamReportDocumentResult | ReportFailure> {
  const maxAttempts = Math.max(1, opts.maxDownloadAttempts ?? DEFAULT_DOWNLOAD_ATTEMPTS);
  const stallMs = opts.downloadStallMs ?? DEFAULT_DOWNLOAD_STALL_MS;
  const deadlineMs = opts.downloadDeadlineMs ?? DEFAULT_DOWNLOAD_DEADLINE_MS;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let last: ReportFailure | null = null;
  let opened = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const a = await attemptDownloadOnce(document, outPath, opts, stallMs, deadlineMs);
    if (a.ok) {
      return {
        ok: true,
        bytes: a.bytes,
        compressionAlgorithm: document.compressionAlgorithm,
        reportDocumentId: document.reportDocumentId,
      };
    }
    last = a.failure;
    opened = opened || a.opened;
    // An expired presigned link won't heal by re-fetching the SAME url, and a
    // non-retryable status (a plain 4xx) won't heal at all — surface at once.
    if (a.expired || !a.retryable) {
      if (opened) await renamePartial(outPath);
      return a.failure;
    }
    if (attempt < maxAttempts) {
      await sleep(downloadBackoffMs(attempt));
    }
  }
  // Every attempt failed transiently. Rename any truncated file and return a
  // real, retryable error_class (never `unknown`).
  if (opened) await renamePartial(outPath);
  return {
    ok: false,
    kind: 'download_failed',
    friendly: defaultFriendly('download_failed'),
    message:
      `report document download failed after ${maxAttempts} attempt(s)` +
      (last?.message ? `: ${last.message}` : last?.friendly ? `: ${last.friendly}` : ''),
    httpStatus: last?.httpStatus,
  };
}

/** Exponential backoff between download retries, capped. */
function downloadBackoffMs(attempt: number): number {
  return Math.min(DOWNLOAD_BACKOFF_BASE_MS * 2 ** (attempt - 1), DOWNLOAD_BACKOFF_CAP_MS);
}

/** One fetch+stream attempt with a stall timeout (reset on progress) and an
 *  overall backstop, both wired to an AbortController that aborts the fetch (and
 *  thus the body stream) when it fires. */
async function attemptDownloadOnce(
  document: DocumentMeta,
  outPath: string,
  opts: StreamDocumentOptions,
  stallMs: number,
  deadlineMs: number,
): Promise<DownloadAttempt> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortedReason: 'stall' | 'deadline' | null = null;

  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortedReason = 'stall';
      controller.abort();
    }, stallMs);
    // Don't let a pending timer keep the event loop alive on its own.
    stallTimer.unref?.();
  };
  const clearTimers = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  };

  let res: Response;
  try {
    armStall();
    deadlineTimer = setTimeout(() => {
      abortedReason = 'deadline';
      controller.abort();
    }, deadlineMs);
    deadlineTimer.unref?.();
    res = await fetchImpl(document.url, { signal: controller.signal });
  } catch (err) {
    clearTimers();
    return {
      ok: false,
      retryable: true,
      expired: false,
      opened: false,
      failure: transientDownloadFailure(err, abortedReason),
    };
  }

  if (!res.ok) {
    clearTimers();
    const expired = res.status === 403 || res.status === 410;
    // A 5xx from S3/CDN is worth retrying; other non-2xx (plain 4xx) is not.
    const retryable = res.status >= 500 && res.status < 600;
    return { ok: false, retryable, expired, opened: false, failure: presignedFetchFailure(res.status) };
  }
  if (!res.body) {
    clearTimers();
    return {
      ok: false,
      retryable: true,
      expired: false,
      opened: false,
      failure: hostUnreachable('the report download returned an empty response body'),
    };
  }

  // mkdir + open + stream are INSIDE the try so a directory/open failure
  // (EACCES, ENOTDIR, a Windows AV/file-lock EBUSY, ENOSPC) is classified and
  // retried through the same path as a stream error, rather than throwing out
  // of the retry loop as a raw, unclassified error. `source` (which wraps the
  // presigned body) is created immediately before `pipeline` with no `await`
  // in between, so pipeline attaches its error handling before any stream error
  // can be delivered — an early await here would let an errored body emit an
  // UNHANDLED 'error' before a listener exists.
  let out: WriteStream | undefined;
  try {
    await mkdir(dirname(outPath), { recursive: true });
    out = createWriteStream(outPath);
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    // Reset the stall timer on every chunk that flows: a steadily-progressing
    // download never trips the inactivity timeout, only a truly stuck one does.
    const monitor = new Transform({
      transform(chunk, _enc, cb) {
        armStall();
        cb(null, chunk);
      },
    });
    if (document.compressionAlgorithm === 'GZIP') {
      await pipeline(source, monitor, createGunzip(), out);
    } else {
      await pipeline(source, monitor, out);
    }
  } catch (err) {
    clearTimers();
    if (out) {
      // pipeline() destroys the source + `out` on error, but the fd release is
      // async; on Windows a rename of a still-open handle throws EPERM/EBUSY, so
      // wait for the writable to actually close before the caller salvages it.
      await closeWritable(out);
    } else {
      // mkdir threw before we wrapped the body into a pipeline — cancel the
      // presigned stream directly so the connection is not leaked.
      try {
        await res.body?.cancel();
      } catch {
        /* already locked/consumed — nothing to release */
      }
    }
    return {
      ok: false,
      retryable: true,
      expired: false,
      // `opened` only when we actually created the file (mkdir succeeded and
      // createWriteStream ran) — otherwise there is nothing to salvage.
      opened: out !== undefined,
      failure: transientDownloadFailure(err, abortedReason),
    };
  }
  clearTimers();
  // Reached only when the try body completed, so `out` was assigned.
  return { ok: true, bytes: out!.bytesWritten };
}

/** Resolve once a write stream is fully closed (fd released). Idempotent:
 *  returns immediately if already closed, else destroys and awaits 'close'. */
function closeWritable(out: WriteStream): Promise<void> {
  if (out.closed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    out.once('close', () => resolve());
    if (!out.destroyed) out.destroy();
  });
}

/** Build the intermediate failure for a network/stall/stream error (retried;
 *  only surfaced verbatim if it is the terminal cause and non-retryable, which
 *  these are not — the loop reclassifies to `download_failed`). Keeps the raw
 *  cause in `message` for logs. */
function transientDownloadFailure(
  err: unknown,
  abortedReason: 'stall' | 'deadline' | null,
): ReportFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const message =
    abortedReason === 'stall'
      ? `download stalled (no progress): ${raw}`
      : abortedReason === 'deadline'
        ? `download exceeded the per-attempt deadline: ${raw}`
        : `download stream error: ${raw}`;
  return {
    ok: false,
    kind: 'download_failed',
    friendly: defaultFriendly('download_failed'),
    message,
  };
}

/** Best-effort: rename a partially-written download to `<outPath>.partial` so a
 *  truncated report is never mistaken for a complete one. Never throws. */
async function renamePartial(outPath: string): Promise<void> {
  try {
    await rename(outPath, `${outPath}.partial`);
  } catch {
    // No file to salvage (attempt failed before opening it), or rename raced —
    // either way there is nothing complete-looking left behind to worry about.
  }
}

/** Amazon's presigned-document descriptor, returned by getReportDocumentMeta
 *  when a run is ready. `url` is short-lived (minutes). Hand this to
 *  streamReportDocumentToFile to download the bytes without buffering them. */
export interface DocumentMeta {
  reportDocumentId?: string;
  url: string;
  compressionAlgorithm: string | null;
}

/** Parse the `document` sub-object the service returns when ready. Returns
 *  undefined when there is no usable URL (treated as not-ready upstream). */
function parseDocumentMeta(v: unknown): DocumentMeta | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : undefined;
  if (!url) return undefined;
  return {
    url,
    reportDocumentId: strOrUndef(o.reportDocumentId),
    compressionAlgorithm:
      typeof o.compressionAlgorithm === 'string' ? o.compressionAlgorithm : null,
  };
}

function parseTimings(v: unknown): ReportTimings | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const t: ReportTimings = {
    createdTime: strOrUndef(o.createdTime),
    processingStartTime: strOrUndef(o.processingStartTime),
    processingEndTime: strOrUndef(o.processingEndTime),
  };
  if (!t.createdTime && !t.processingStartTime && !t.processingEndTime) {
    return undefined;
  }
  return t;
}

type DocBytesResult = { ok: true; text: string; bytes: number } | ReportFailure;

/** Inline-decode cap for getReportDocument / fetchDocumentBytes. A document
 *  larger than this is NOT decoded to a string (that would risk crashing
 *  toString() at V8's ~2 GB string limit, kMaxInt); the caller is told to use
 *  --out, which streams to disk with no size limit. 25 MB comfortably covers
 *  the small status-and-peek case while staying far below the string ceiling. */
const MAX_INLINE_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Thrown by readCapped when the download exceeds the inline cap. Carries the
 *  byte count seen so far (>= the cap) for the log message. */
class DocumentTooLargeError extends Error {
  constructor(public readonly bytesSeen: number) {
    super(
      `document exceeds the ${MAX_INLINE_DOCUMENT_BYTES}-byte inline cap ` +
        `(saw >= ${bytesSeen} bytes)`,
    );
    this.name = 'DocumentTooLargeError';
  }
}

/** Fetch Amazon's presigned document URL directly and decode a SIZE-CAPPED
 *  inline copy. Sends NO Authorization header (it is a presigned S3 link; the
 *  Bearer would make S3 reject it). Gunzips when the service reported GZIP. A
 *  non-2xx (e.g. an expired link) surfaces as a friendly "re-fetch" failure; a
 *  document over the inline cap fails cleanly pointing at --out, rather than
 *  buffering multiple GB and crashing toString(). */
async function fetchDocumentBytes(
  url: string,
  compressionAlgorithm: string | null,
  opts: ReportClientOptions,
): Promise<DocBytesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return hostUnreachable(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) return presignedFetchFailure(res.status);

  // Read with a byte cap so an oversized document fails cleanly instead of
  // buffering multiple GB. The --out path (streamReportDocumentToFile) streams
  // to disk and has no such limit.
  let raw: Buffer;
  try {
    raw = await readCapped(res, MAX_INLINE_DOCUMENT_BYTES);
  } catch (err) {
    if (err instanceof DocumentTooLargeError) return documentTooLarge();
    return hostUnreachable(err instanceof Error ? err.message : String(err));
  }

  let buf: Buffer;
  try {
    buf = compressionAlgorithm === 'GZIP' ? gunzipSync(raw) : raw;
  } catch (err) {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The report downloaded but could not be decompressed. Try fetching it ' +
        'again; if it persists, contact MixShift ops.',
      message: `gunzip failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A small compressed payload can still inflate past the cap. Guard the
  // decoded length too so we never hand toString() a multi-GB buffer.
  if (buf.length > MAX_INLINE_DOCUMENT_BYTES) return documentTooLarge();

  return { ok: true, text: buf.toString('utf8'), bytes: buf.length };
}

/** Read a Response body into a Buffer, aborting once `cap` bytes is exceeded.
 *  Consumes the body chunk-by-chunk so an oversized document is cancelled
 *  mid-download rather than fully buffered. Falls back to a capped
 *  arrayBuffer() read when the body isn't async-iterable. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const body = res.body as
    | (ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>)
    | null;
  if (
    body &&
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  ) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > cap) {
        try {
          await body.cancel();
        } catch {
          /* best-effort cancel; we are throwing regardless */
        }
        throw new DocumentTooLargeError(total);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  const ab = await res.arrayBuffer();
  if (ab.byteLength > cap) throw new DocumentTooLargeError(ab.byteLength);
  return Buffer.from(ab);
}

/** A non-2xx from the presigned S3 fetch. 403/410 means the short-lived link
 *  expired (the report itself is still DONE; re-fetch for a fresh link). */
function presignedFetchFailure(status: number): ReportFailure {
  const expired = status === 403 || status === 410;
  return {
    ok: false,
    kind: 'unknown',
    friendly: expired
      ? 'The report download link expired before it could be fetched. The ' +
        'report itself is still ready; re-run `mixshift amazon report get ' +
        '<runId>` for a fresh link.'
      : `Could not download the report document (HTTP ${status}). Try ` +
        'fetching it again.',
    message: `presigned document fetch returned HTTP ${status}`,
    httpStatus: status,
  };
}

/** The document is too large to decode inline. Tell the caller to stream it to
 *  a file with --out, which has no size limit. */
function documentTooLarge(): ReportFailure {
  const mb = Math.round(MAX_INLINE_DOCUMENT_BYTES / (1024 * 1024));
  return {
    ok: false,
    kind: 'unknown',
    friendly:
      `This report is larger than the inline limit (${mb} MB), so it was not ` +
      'returned to the screen. Re-run with `--out <file>` to stream it straight ' +
      'to disk; the --out path handles reports of any size.',
    message: `document exceeds the ${MAX_INLINE_DOCUMENT_BYTES}-byte inline cap; use --out`,
  };
}

// ---------------------------------------------------------------------------
// Internal request plumbing (mirrors query-runner's datahub branch)
// ---------------------------------------------------------------------------

interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  /**
   * Which caller-facing surface this call belongs to. Used ONLY to pick the
   * fallback wording when the service did not send a `friendly` (see
   * `defaultFriendly`) -- the service's own text always wins.
   *
   * This transport is shared by reports, the live SP-API passthrough, Ads and
   * pricing, so it cannot infer the surface and the caller has to say. Omitted
   * yields wording that names no surface: vaguer, never wrong.
   */
  surface?: AmazonSurface;
}

export type AmazonRequestSpec = RequestSpec;
export type AmazonRequestSuccess = { ok: true; json: unknown };
type RequestSuccess = AmazonRequestSuccess;

/**
 * One authenticated round-trip to the report surface, with the same token
 * lifecycle as the query path: send the Bearer; on a mid-session 401,
 * force-refresh once and retry; map network/DNS/TLS failures to
 * host_unreachable; map a server failure envelope to a typed ReportFailure.
 *
 * Exported so sibling client modules (pricing, future catalog/orders/...) can
 * reuse the auth + retry + envelope-mapping plumbing without duplicating it.
 * Same staged-refactor principle as the service side: build new domain
 * clients against this transport; do not re-route reports through anything
 * different until we have a second user proving the shape is right.
 */
export async function amazonRequest(
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
    return statusOnlyFailure(res.status, undefined, spec.surface);
  }

  if (isServerFailureEnvelope(json)) {
    return toReportFailure(json, res.status, spec.surface);
  }

  // Some infra errors arrive as valid JSON without our envelope (e.g. a CDN
  // error object). If the HTTP status is non-2xx and the body isn't our
  // success/ failure shape, treat it as a status-derived failure.
  if (!res.ok) {
    return statusOnlyFailure(res.status, safeJsonPreview(json), spec.surface);
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
    // datahub (user session) wins; service (machine credential) is the
    // unattended fallback. getValidAccessToken applies the same precedence
    // for the Bearer itself.
    const base = credentials?.datahub?.api_base ?? credentials?.service?.api_base;
    if (!base) {
      return {
        ok: false,
        kind: 'not_authenticated',
        friendly:
          "You're not signed in to MixShift. Run `mixshift auth login` (or " +
          'say "sign in to MixShift" in chat) before pulling reports. For ' +
          'unattended runs, configure `mixshift auth service-setup`.',
      };
    }
    apiBase = base;
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

/**
 * Which Amazon-facing surface a failure came from.
 *
 * `defaultFriendly` below is reached from every client module in this
 * directory, not just reports, so any fallback message that names a surface
 * has to take the name from here. Hardcoding is how the `unknown` fallback
 * came to tell an Ads or passthrough caller that "the report request failed",
 * mirroring the same defect the gateway carried in SpApiError.
 */
export type AmazonSurface = 'report' | 'spapi' | 'ads' | 'pricing';

/** Sentence-initial request noun: `${label} failed ...`. */
const SURFACE_REQUEST_LABEL: Record<AmazonSurface, string> = {
  report: 'The report request',
  spapi: 'The SP-API request',
  ads: 'The Amazon Ads API request',
  pricing: 'The pricing request',
};

/** Mid-sentence plural: `Amazon is rate-limiting ${plural} right now`. */
const SURFACE_REQUEST_PLURAL: Record<AmazonSurface, string> = {
  report: 'report requests',
  spapi: 'SP-API requests',
  ads: 'Amazon Ads API requests',
  pricing: 'pricing requests',
};

/** Surface-free fallbacks. Vague on purpose; never name a surface here. */
const NEUTRAL_REQUEST_LABEL = 'The request';
const NEUTRAL_REQUEST_PLURAL = 'requests to this Amazon API';

function requestLabel(surface?: AmazonSurface): string {
  return surface ? SURFACE_REQUEST_LABEL[surface] : NEUTRAL_REQUEST_LABEL;
}

function requestPlural(surface?: AmazonSurface): string {
  return surface ? SURFACE_REQUEST_PLURAL[surface] : NEUTRAL_REQUEST_PLURAL;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<ReportFailureKind>([
  'spapi_not_configured',
  'ads_not_configured',
  'insufficient_scope',
  'reauth_required',
  'bad_request',
  'restricted_report',
  'merchant_not_found',
  'throttled',
  'report_fatal',
  'host_unreachable',
  'not_authenticated',
  'session_expired',
  // Gateway kinds added 2026-09-04 (mx-ops#43) — keep in step with
  // ALL_SPAPI_ERROR_KINDS in mx-legacy-auth.
  'report_retired',
  'upstream_unavailable',
  'listings_write_disabled',
  'listings_media_write_disabled',
  'listings_write_not_enabled',
  'patch_not_allowed',
  'change_set_not_found',
  'change_set_expired',
  'change_set_already_committed',
  'approval_mismatch',
  'stale_approval',
  'schema_drift',
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
  surface?: AmazonSurface,
): ReportFailure {
  const rawKind = typeof json.kind === 'string' ? json.kind : '';
  const recognized = KNOWN_KINDS.has(rawKind);
  const kind: ReportFailureKind = recognized
    ? (rawKind as ReportFailureKind)
    : safeKindForStatus(httpStatus);
  const serverFriendly =
    typeof json.friendly === 'string' ? json.friendly : undefined;
  const message = typeof json.message === 'string' ? json.message : undefined;
  return {
    ok: false,
    kind,
    friendly: serverFriendly ?? defaultFriendly(kind, surface),
    message,
    amazonSellerId: strOrUndef(json.amazonSellerId),
    reportType: strOrUndef(json.reportType),
    retryAfterMs: numOrUndef(json.retryAfterMs),
    reportId: strOrUndef(json.reportId),
    status: strOrUndef(json.status),
    candidates: parseCandidates(json.candidates),
    httpStatus,
    ...(recognized ? {} : { unrecognizedKind: rawKind || '(absent)' }),
    ...(strOrUndef(json.amazon_error_code) !== undefined
      ? { amazonErrorCode: strOrUndef(json.amazon_error_code) }
      : {}),
    ...(numOrUndef(json.status) !== undefined ? { amazonStatus: numOrUndef(json.status) } : {}),
    ...(json.responsePayload !== undefined ? { responsePayload: json.responsePayload } : {}),
    ...(strOrUndef(json.responseText) !== undefined
      ? { responseText: strOrUndef(json.responseText) }
      : {}),
  };
}

/** Pass through the `candidates` array the service attaches to a multi-
 *  marketplace `merchant_not_found`. Keeps only the fields we render/forward. */
function parseCandidates(v: unknown): MerchantCandidate[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MerchantCandidate[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const legacySellerId =
      typeof o.legacySellerId === 'number' || typeof o.legacySellerId === 'string'
        ? o.legacySellerId
        : undefined;
    out.push({
      legacySellerId,
      amazonSellerId: strOrUndef(o.amazonSellerId),
      marketplaceId: strOrUndef(o.marketplaceId) ?? null,
      countryCode: strOrUndef(o.countryCode) ?? null,
      marketplaceName: strOrUndef(o.marketplaceName) ?? null,
      name: strOrUndef(o.name),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Fallback when an infra layer answered with a bare status (no envelope). */
function statusOnlyFailure(
  httpStatus: number,
  detail?: string,
  surface?: AmazonSurface,
): ReportFailure {
  const kind = statusToKind(httpStatus);
  return {
    ok: false,
    kind,
    friendly: defaultFriendly(kind, surface),
    message:
      `Service returned HTTP ${httpStatus} without a recognized error ` +
      `envelope${detail ? `: ${detail}` : '.'}`,
    httpStatus,
  };
}

/** Reverse-map a status to a kind, but ONLY where doing so is sound.
 *
 * The service's own kind->status map is NOT injective, so a general reverse
 * mapping invents facts. Measured against mx-legacy-auth `STATUS_BY_KIND`:
 * 404 is BOTH `merchant_not_found` and `change_set_not_found`; 409 covers six
 * kinds (`reauth_required`, `change_set_expired`, `change_set_already_
 * committed`, `approval_mismatch`, `stale_approval`, `schema_drift`); 403,
 * 502 and 503 are each ambiguous too. Labelling a 404 `merchant_not_found`
 * would tell a user with an expired change set to go fix their merchant
 * selection — worse than saying nothing, because it points at the wrong fix.
 *
 * So this narrows to the cases where the answer cannot be wrong:
 *   400 -> bad_request  (both candidates, `bad_request` and `report_retired`,
 *                        are terminal client errors: do not retry either way)
 *   429 -> throttled    (sole occupant of that status)
 * Everything else stays `unknown`, which is honest rather than confident.
 *
 * Used only when the service sends a kind we do not recognize. See mx-ops#43.
 */
function safeKindForStatus(httpStatus: number): ReportFailureKind {
  if (httpStatus === 400) return 'bad_request';
  if (httpStatus === 429) return 'throttled';
  return 'unknown';
}

function statusToKind(httpStatus: number): ReportFailureKind {
  switch (httpStatus) {
    case 400:
      return 'bad_request';
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

function defaultFriendly(kind: ReportFailureKind, surface?: AmazonSurface): string {
  switch (kind) {
    case 'spapi_not_configured':
      return (
        "Amazon SP-API isn't enabled for this MixShift account yet. Contact " +
        'MixShift ops to turn it on.'
      );
    case 'ads_not_configured':
      return (
        "The Amazon Ads API isn't enabled on the MixShift service yet. " +
        'Contact MixShift ops.'
      );
    case 'insufficient_scope':
      return (
        'This credential lacks a scope this call requires (writes need ' +
        'ads:write). Signed-in user sessions hold it; machine credentials ' +
        'must be issued with it explicitly by a MixShift admin.'
      );
    case 'reauth_required':
      return (
        'This Amazon merchant needs to be re-authorized in MixShift before ' +
        'this call can run. Re-connect the account in the MixShift app, then ' +
        'retry.'
      );
    case 'bad_request':
      return (
        `${requestLabel(surface)} was rejected by Amazon because of the ` +
        'request itself, not a MixShift or Amazon outage. Retrying it ' +
        'unchanged will not help.'
      );
    case 'restricted_report':
      return (
        surface === 'report'
        ? 'Amazon rejected this report as restricted. It requires a Restricted ' +
          'Data Token / PII role that MixShift does not hold. Pull the report in ' +
          'its default (non-PII) form, or choose a different report.'
        : 'Amazon denied access to this operation. It may need a role or ' +
          'restricted-data access that MixShift does not hold, or this ' +
          "merchant's authorization may predate that role and need " +
          're-authorizing.'
      );
    case 'merchant_not_found':
      return (
        'No Amazon merchant matched that selector. Run `mixshift amazon ' +
        'merchants` to see which merchants you can pull for.'
      );
    case 'throttled':
      return (
        `Amazon is rate-limiting ${requestPlural(surface)} right now. Wait a ` +
        'moment and retry.'
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
    case 'download_failed':
      return (
        'The report download did not complete (it kept timing out or dropping ' +
        'the connection). The report itself is still ready; try fetching it ' +
        'again in a moment.'
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
      return `${requestLabel(surface)} failed unexpectedly. Try again shortly.`;
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
