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

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';

import { loadCredentials, getValidAccessToken } from '../auth/credentials.js';

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
  /** True when the SP-API authorization is live. False == Amazon access was
   *  lost (`iLostAccess`) and the merchant must be re-authorized in the
   *  MixShift platform before reports can be pulled (otherwise reports fail
   *  with reauth_required). This is the signal to warn on before a pull. */
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
  /** On `merchant_not_found` when the seller is multi-marketplace: the rows to
   *  choose from. Re-run report-start with one row's `legacySellerId` (or the
   *  matching `marketplace`). */
  candidates?: MerchantCandidate[];
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
 * documented contract in the mx-report-pull skill, so the surfaces must not
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
      return 6; // SP-API not enabled for this tenant
    case 'merchant_not_found':
      return 7; // selector matched no merchant
    case 'throttled':
      return 8; // Amazon rate limit — retry later
    case 'report_fatal':
      return 9; // Amazon returned FATAL / CANCELLED
    case 'host_unreachable':
    case 'unknown':
    default:
      return 1;
  }
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

/**
 * Stream a presigned report document straight to a file, in chunks, never
 * materializing it as a string. THIS is the large-report-safe path behind
 * --out on `report get` / `report run`: it pipes Amazon's presigned response
 * body through a gunzip transform (when GZIP) into the destination file, so a
 * report of any size lands on disk without the V8 string-length crash.
 *
 * Sends NO Authorization header (presigned link; a Bearer makes S3 reject it).
 * A non-2xx (e.g. an expired link) surfaces as a friendly re-fetch failure.
 * The parent directory is created if missing.
 */
export async function streamReportDocumentToFile(
  document: DocumentMeta,
  outPath: string,
  opts: ReportClientOptions = {},
): Promise<StreamReportDocumentResult | ReportFailure> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let res: Response;
  try {
    res = await fetchImpl(document.url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return hostUnreachable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) return presignedFetchFailure(res.status);
  if (!res.body) {
    return hostUnreachable('the report download returned an empty response body');
  }

  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);
  const source = Readable.fromWeb(
    res.body as Parameters<typeof Readable.fromWeb>[0],
  );

  try {
    if (document.compressionAlgorithm === 'GZIP') {
      await pipeline(source, createGunzip(), out);
    } else {
      await pipeline(source, out);
    }
  } catch (err) {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The report download failed while streaming to disk. Try fetching it ' +
        'again; if it persists, contact MixShift ops.',
      message: `stream-to-file failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    bytes: out.bytesWritten,
    compressionAlgorithm: document.compressionAlgorithm,
    reportDocumentId: document.reportDocumentId,
  };
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
    candidates: parseCandidates(json.candidates),
    httpStatus,
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
