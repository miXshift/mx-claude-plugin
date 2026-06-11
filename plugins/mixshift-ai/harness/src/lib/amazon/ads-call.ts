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
 * credential lacks ads:write; user sessions hold it, machine credentials
 * need an explicit grant).
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
}

/** One callable Ads operation from the service catalog. `notes` is the
 *  integration contract: body vs query conventions, media types, caps. */
export interface AdsOperationView {
  id: string;
  family: string;
  operation: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
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
  opts: ReportClientOptions = {},
): Promise<ListAdsProfilesResult | ReportFailure> {
  const r = await amazonRequest(
    { method: 'GET', path: '/api/amazon/ads/profiles' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { profiles?: unknown }).profiles;
  const profiles = Array.isArray(raw) ? (raw as AdsProfileView[]) : [];
  return { ok: true, profiles };
}

/** List the service's Ads operation catalog, optionally filtered by family. */
export async function listAdsOperations(
  family?: string,
  opts: ReportClientOptions = {},
): Promise<ListAdsOperationsResult | ReportFailure> {
  const qs = family ? `?family=${encodeURIComponent(family)}` : '';
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/ads/operations${qs}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { operations?: unknown }).operations;
  const operations = Array.isArray(raw) ? (raw as AdsOperationView[]) : [];
  return { ok: true, operations };
}

/** Execute one cataloged Ads operation (reads, or writes under the dryRun contract). */
export async function adsCall(
  input: AdsCallInput,
  opts: ReportClientOptions = {},
): Promise<AdsCallSuccess | ReportFailure> {
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

  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/ads/call', body },
    { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
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
