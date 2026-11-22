/**
 * Client for the Amazon Ads API call surface on mx-legacy-auth
 * (https://mcp.mixshift.io). Sibling of spapi-call.ts on the same
 * amazonRequest transport (Bearer, 401-refresh-retry, envelope mapping).
 * Covers reads AND the audited write surface (catalog entries marked
 * write: true: bid updates, negatives, campaign creation, ...).
 *
 * Three calls:
 *   listAdsProfiles   → GET  /api/amazon/ads/profiles
 *   listAdsOperations → GET  /api/amazon/ads/operations[?family=...]
 *   adsCall           → POST /api/amazon/ads/call
 *   adsAssetUpload    → POST /api/amazon/ads/assets/upload (assets.upload_image;
 *                       not a catalog operation, so it has its own route)
 *
 * WRITE SAFETY (service-enforced, mirrored here): write operations default
 * to dryRun=true. A dry-run call validates, snapshots current state, logs an
 * audit row, and returns { dryRun: true, preview, beforeState?, auditId? }
 * WITHOUT touching Amazon. Only an explicit `dryRun: false` commits, and the
 * skill layer must put the preview in front of the user and get their
 * confirmation first. Commits return Amazon's multi-status response (partial
 * failure is normal: summarize per-item success/error counts) plus the
 * auditId of the mcp_ads_changes row holding the pre-write snapshot.
 *
 * Profile selection mirrors the SP-API surfaces: `legacySellerId` pins the
 * exact (advertiser, marketplace) row (same ids as `amazon merchants`), or
 * pass `profileId` directly; `sellerId` + `marketplace` also narrows.
 * Ambiguity returns merchant_not_found with candidates.
 *
 * Discovery-first usage: list operations and READ THE NOTES. The POST
 * .../list family takes an optional filter body (the service sends {} when
 * omitted); SD lists and sb.list_keywords use query params instead;
 * reporting.create_report wants a full configuration body. Report/export
 * download urls inside payloads are presigned: fetch them WITHOUT auth
 * headers and gunzip.
 *
 * Failure kinds are shared with reports.ts, plus `ads_not_configured` (the
 * service has no Ads app credentials set) and `insufficient_scope` (the
 * credential lacks ads:write; it may be off for a person in their organization,
 * and a service credential needs it granted when it is created).
 */

import {
  amazonRequest,
  type ReportClientOptions,
  type ReportFailure,
} from './reports.js';

// ---------------------------------------------------------------------------
// Types (mirror the service's AdsProfileView / AdsOperationView / AdsCallResult)
// ---------------------------------------------------------------------------

/** One advertising profile the tenant can call for: a (advertiser account,
 *  marketplace) row. `legacySellerId` matches the SP-API merchant ids. */
export interface AdsProfileView {
  profileId: string;
  legacySellerId: number;
  amazonSellerId: string | null;
  name: string;
  merchantType: string;
  merchantRegion: string;
  marketplaceId: string | null;
  countryCode?: string | null;
  marketplaceName?: string | null;
  /** Whether the merchant is ACTIVE for Ads in MixShift. Only ever false in a
   *  response the caller asked for with includeInactive (mx-ops#57). Optional
   *  so an older service build that omits it still parses. */
  isActive?: boolean;
}

/** One callable Ads operation from the service catalog. `notes` is the
 *  integration contract: body vs query conventions, media types, caps. */
export interface AdsOperationView {
  id: string;
  family: string;
  operation: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  pathTemplate: string;
  /** false = account-level (profiles.list); true = profile-scoped. */
  profileScope: boolean;
  /** vnd media type the service sends; override per call if Amazon revs it. */
  contentType?: string;
  body?: 'required' | 'optional';
  /** True = mutating: ads:write scope, dryRun default, audit-logged. */
  write?: boolean;
  summary: string;
  notes?: string;
  docsUrl: string;
}

export interface ListAdsProfilesResult {
  ok: true;
  profiles: AdsProfileView[];
  /** Merchants active for Ads. Optional: older service builds omit it. */
  activeCount?: number;
  /** Merchants present but inactive, whether or not they were returned. */
  inactiveCount?: number;
  /** True when inactive merchants exist and were withheld from `profiles`. */
  inactiveHidden?: boolean;
  /** Set only when something was withheld: what is missing and how to see it.
   *  Relay it, or a user hunting a brand that is merely inactive is told
   *  nothing at all. */
  note?: string;
}

export interface ListAdsOperationsResult {
  ok: true;
  operations: AdsOperationView[];
}

export type AdsQueryValue = string | number | boolean | Array<string | number>;

export interface AdsCallInput {
  /** Operation id from listAdsOperations, e.g. 'sp.list_campaigns'. */
  operation: string;
  /** Ads profileId from listAdsProfiles. */
  profileId?: string;
  /** Exact per-marketplace seller record id; the authoritative disambiguator. */
  legacySellerId?: number | string;
  /** AmazonSellerID; pair with marketplace when the advertiser spans several. */
  sellerId?: string;
  marketplace?: string;
  /** Path placeholders, e.g. { reportId: '...' }. */
  pathParams?: Record<string, string>;
  /** Query params (SD lists, sb.list_keywords). */
  query?: Record<string, AdsQueryValue>;
  /** JSON body per the operation notes. */
  body?: unknown;
  /** Advanced: override the cataloged vnd media type. */
  contentTypeOverride?: string;
  /**
   * Write operations only. The service defaults to TRUE (preview, no
   * mutation). Pass false ONLY after the user confirmed the previewed
   * change set. Ignored on reads.
   */
  dryRun?: boolean;
}

export interface AdsCallSuccess {
  ok: true;
  operation: string;
  profileId: string;
  legacySellerId: number;
  marketplaceId: string | null;
  /** Amazon's response body, verbatim. Absent on dry runs. */
  payload?: unknown;
  /** Write calls only: whether this was a preview (true) or a commit (false). */
  dryRun?: boolean;
  /** Write calls only: size of the proposed/applied change set. */
  itemsCount?: number;
  /** Write calls only: mcp_ads_changes audit row id (the rollback handle). */
  auditId?: string;
  /** Updates only (best-effort): pre-write snapshot of the targeted entities. */
  beforeState?: unknown;
  /** Dry runs only: the validated change set echoed back. */
  preview?: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List the warehouse-known Ads profiles for the signed-in tenant. */
export async function listAdsProfiles(
  opts: ReportClientOptions & { includeInactive?: boolean } = {},
): Promise<ListAdsProfilesResult | ReportFailure> {
  // Active-only is the service default (mx-ops#57); ask for the rest only
  // when the caller wants to discover inactive merchants.
  const qs = opts.includeInactive ? '?includeInactive=true' : '';
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/ads/profiles${qs}`, surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const body = r.json as {
    profiles?: unknown;
    activeCount?: unknown;
    inactiveCount?: unknown;
    inactiveHidden?: unknown;
    note?: unknown;
  };
  const profiles = Array.isArray(body.profiles) ? (body.profiles as AdsProfileView[]) : [];
  return {
    ok: true,
    profiles,
    // Tolerated as optional: an older service build does not send them, and
    // the list still works without the counts.
    ...(typeof body.activeCount === 'number' ? { activeCount: body.activeCount } : {}),
    ...(typeof body.inactiveCount === 'number' ? { inactiveCount: body.inactiveCount } : {}),
    ...(typeof body.inactiveHidden === 'boolean' ? { inactiveHidden: body.inactiveHidden } : {}),
    ...(typeof body.note === 'string' ? { note: body.note } : {}),
  };
}

/** List the service's Ads operation catalog, optionally filtered by family. */
export async function listAdsOperations(
  family?: string,
  opts: ReportClientOptions = {},
): Promise<ListAdsOperationsResult | ReportFailure> {
  const qs = family ? `?family=${encodeURIComponent(family)}` : '';
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/ads/operations${qs}`, surface: 'ads' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { operations?: unknown }).operations;
  const operations = Array.isArray(raw) ? (raw as AdsOperationView[]) : [];
  return { ok: true, operations };
}

/** The wire body shared by `/api/amazon/ads/call` and `/api/amazon/ads/proposals`:
 *  operation, profile selectors, pathParams, query, body. `dryRun` is only set
 *  when the caller set it (proposals never send it). */
export function buildAdsRequestBody(input: AdsCallInput): Record<string, unknown> {
  const body: Record<string, unknown> = { operation: input.operation };
  if (input.profileId) body.profileId = input.profileId;
  if (
    input.legacySellerId !== undefined &&
    input.legacySellerId !== null &&
    input.legacySellerId !== ''
  ) {
    const n =
      typeof input.legacySellerId === 'string'
        ? Number(input.legacySellerId)
        : input.legacySellerId;
    body.legacySellerId =
      typeof n === 'number' && Number.isFinite(n) ? n : input.legacySellerId;
  }
  if (input.sellerId) body.sellerId = input.sellerId;
  if (input.marketplace) body.marketplace = input.marketplace;
  if (input.pathParams && Object.keys(input.pathParams).length > 0) {
    body.pathParams = input.pathParams;
  }
  if (input.query && Object.keys(input.query).length > 0) body.query = input.query;
  if (input.body !== undefined) body.body = input.body;
  if (input.contentTypeOverride) body.contentTypeOverride = input.contentTypeOverride;
  // Only send dryRun when the caller set it explicitly; the service's own
  // default (TRUE for writes) is the safety contract.
  if (input.dryRun !== undefined) body.dryRun = input.dryRun;
  return body;
}

/** Execute one cataloged Ads operation (reads, or writes under the dryRun contract). */
export async function adsCall(
  input: AdsCallInput,
  opts: ReportClientOptions = {},
): Promise<AdsCallSuccess | ReportFailure> {
  const body = buildAdsRequestBody(input);

  // Outlast the service on a report create: it gives Amazon 60 s and sends a
  // create only once, so a client deadline of 60 s gave up first and told the
  // user to try again while the create could still land. 90 s leaves 30 s for
  // the service's own work (token, profile lookup, pacing) on top of Amazon's
  // 60. Reads and committed writes can still run longer (the service retries
  // their throttles), which is what mayChangeState is for: a lost answer on a
  // create or a commit is an unknown outcome, not an unreachable service. The
  // catalog's retry policy is not visible here, so "create" is read from the
  // operation id; a dry run or a read changes nothing and keeps the old wording.
  const mayChangeState = input.dryRun === false || /\.create_/.test(input.operation);
  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/ads/call', body, surface: 'ads', mayChangeState },
    { ...opts, timeoutMs: opts.timeoutMs ?? 90_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Partial<AdsCallSuccess>;
  if (typeof json.operation !== 'string') {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The service accepted the call but returned an unrecognized shape. ' +
        'Try again, or contact MixShift ops if it persists.',
      message: 'ads call response missing operation echo',
    };
  }
  return {
    ok: true,
    operation: json.operation,
    profileId: String(json.profileId ?? ''),
    legacySellerId: Number(json.legacySellerId ?? 0),
    marketplaceId: json.marketplaceId == null ? null : String(json.marketplaceId),
    payload: json.payload,
    ...(typeof json.dryRun === 'boolean' ? { dryRun: json.dryRun } : {}),
    ...(typeof json.itemsCount === 'number' ? { itemsCount: json.itemsCount } : {}),
    ...(typeof json.auditId === 'string' ? { auditId: json.auditId } : {}),
    ...(json.beforeState !== undefined ? { beforeState: json.beforeState } : {}),
    ...(json.preview !== undefined ? { preview: json.preview } : {}),
  };
}

// ---------------------------------------------------------------------------
// Creative Asset Library upload (assets.upload_image)
// ---------------------------------------------------------------------------

/** Input for adsAssetUpload. The preview (default) needs sourceUrl, name and
 *  assetSubType; the commit needs previewId + approvedPreviewHash and the same
 *  profile selector, and uploads the bytes the preview checked. */
export interface AdsAssetUploadInput {
  profileId?: string;
  legacySellerId?: number | string;
  sellerId?: string;
  marketplace?: string;
  /** Preview only: the https URL of the PNG or JPEG file itself. */
  sourceUrl?: string;
  /** Preview only: the name the asset gets in the library. */
  name?: string;
  /** Preview only: LOGO, PRODUCT_IMAGE, LIFESTYLE_IMAGE, OTHER_IMAGE, AUTHOR_IMAGE. */
  assetSubType?: string;
  asins?: string[];
  tags?: string[];
  brandEntityId?: string;
  /** The service defaults to TRUE (preview). Only false uploads. */
  dryRun?: boolean;
  previewId?: string;
  approvedPreviewHash?: string;
}

/** The service's preview or commit result. */
export interface AdsAssetUploadSuccess {
  ok: true;
  operation: string;
  dryRun: boolean;
  profileId: string;
  legacySellerId: number;
  marketplaceId: string | null;
  /** The full response body (preview: previewId, previewHash, expiresAt,
   *  detected, wouldRegister, duplicateNames, note; commit: assetId,
   *  versionId, failedSpecChecks, auditId, note). */
  result: Record<string, unknown>;
}

/** The wire body for POST /api/amazon/ads/assets/upload. Only fields the
 *  caller set are sent: the route is strict, and dryRun is left to the
 *  service's own default (TRUE) unless the caller set it. */
export function buildAssetUploadBody(input: AdsAssetUploadInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.profileId) body.profileId = input.profileId;
  if (
    input.legacySellerId !== undefined &&
    input.legacySellerId !== null &&
    input.legacySellerId !== ''
  ) {
    const n =
      typeof input.legacySellerId === 'string'
        ? Number(input.legacySellerId)
        : input.legacySellerId;
    body.legacySellerId =
      typeof n === 'number' && Number.isFinite(n) ? n : input.legacySellerId;
  }
  if (input.sellerId) body.sellerId = input.sellerId;
  if (input.marketplace) body.marketplace = input.marketplace;
  if (input.sourceUrl !== undefined) body.sourceUrl = input.sourceUrl;
  if (input.name !== undefined) body.name = input.name;
  if (input.assetSubType !== undefined) body.assetSubType = input.assetSubType;
  if (input.asins && input.asins.length > 0) body.asins = input.asins;
  if (input.tags && input.tags.length > 0) body.tags = input.tags;
  if (input.brandEntityId) body.brandEntityId = input.brandEntityId;
  if (input.dryRun !== undefined) body.dryRun = input.dryRun;
  if (input.previewId) body.previewId = input.previewId;
  if (input.approvedPreviewHash) body.approvedPreviewHash = input.approvedPreviewHash;
  return body;
}

/** Failure kinds a commit can end with after the image may have reached
 *  Amazon. The service marks its own maybe-applied register failures
 *  (`outcome: 'unknown'` in the envelope, which this client does not read) with
 *  one of these kinds, so a commit failing with any of them is reported as an
 *  unknown outcome: a new preview and commit could add a second asset. */
const COMMIT_MAYBE_APPLIED_KINDS: ReadonlySet<string> = new Set([
  'host_unreachable',
  'upstream_unavailable',
  'throttled',
  'unknown',
]);

/** The service's commit is a pacer wait plus three Amazon calls (upload slot,
 *  PUT of the bytes, register), each capped at 60 s, so it can take about
 *  180 s. The preview is one download. */
export const ASSET_UPLOAD_PREVIEW_TIMEOUT_MS = 90_000;
export const ASSET_UPLOAD_COMMIT_TIMEOUT_MS = 200_000;

/** Preview (default) or commit one image upload into a profile's Creative
 *  Asset Library. A commit is sent once: a lost answer is an unknown outcome
 *  (the asset may be in the library), never retried here. */
export async function adsAssetUpload(
  input: AdsAssetUploadInput,
  opts: ReportClientOptions = {},
): Promise<AdsAssetUploadSuccess | ReportFailure> {
  const body = buildAssetUploadBody(input);
  const commit = input.dryRun === false;
  const r = await amazonRequest(
    {
      method: 'POST',
      path: '/api/amazon/ads/assets/upload',
      body,
      surface: 'ads',
      mayChangeState: commit,
    },
    {
      ...opts,
      timeoutMs:
        opts.timeoutMs ??
        (commit ? ASSET_UPLOAD_COMMIT_TIMEOUT_MS : ASSET_UPLOAD_PREVIEW_TIMEOUT_MS),
    },
  );
  if (!r.ok) {
    if (commit && r.requestOutcome === undefined && COMMIT_MAYBE_APPLIED_KINDS.has(r.kind)) {
      return { ...r, requestOutcome: 'unknown' };
    }
    return r;
  }
  const json = (r.json ?? {}) as Record<string, unknown>;
  if (typeof json.operation !== 'string' || typeof json.dryRun !== 'boolean') {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The service accepted the upload request but returned an unrecognized shape. ' +
        (input.dryRun === false
          ? 'The image may or may not be in the library: search for it by name before trying again.'
          : 'Nothing was uploaded. Try the preview again, or contact MixShift ops if it persists.'),
      message: 'asset upload response missing operation or dryRun',
      ...(input.dryRun === false ? { requestOutcome: 'unknown' } : {}),
    };
  }
  return {
    ok: true,
    operation: json.operation,
    dryRun: json.dryRun,
    profileId: String(json.profileId ?? ''),
    legacySellerId: Number(json.legacySellerId ?? 0),
    marketplaceId: json.marketplaceId == null ? null : String(json.marketplaceId),
    result: json,
  };
}
