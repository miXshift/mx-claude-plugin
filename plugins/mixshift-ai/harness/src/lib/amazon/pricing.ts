/**
 * Client for the Amazon SP-API Pricing batch endpoints on mx-legacy-auth
 * (https://mcp.mixshift.io). Sibling to ../amazon/reports.ts: same Bearer
 * token plumbing, same envelope shape, same ReportFailure model. Reuses
 * reports.ts's amazonRequest transport so the auth + 401-retry + envelope
 * mapping logic lives in one place.
 *
 * Operations:
 *   - getFeaturedOfferExpectedPriceBatch  (FOEP, keyed by SKU)
 *   - getCompetitiveSummary               (keyed by ASIN)
 *
 * Each is exposed in two modes:
 *   - sync  (capped at 200 items, returns full responses inline)
 *   - async (no cap, returns runId; poll + fetch separately)
 *
 * Plus run-lifecycle calls used by either async variant:
 *   - pollPricingRun(runId)        progress + status
 *   - getPricingRunResult(runId)   the per-item responses array
 *
 * Failure model: ReportFailure (imported from reports.ts) — same kinds,
 * same envelope. The pricing surface speaks the same dialect as reports.
 */

import {
  amazonRequest,
  exitCodeForKind,
  isReportFailure,
  type ReportClientOptions,
  type ReportFailure,
} from './reports.js';

// ---------------------------------------------------------------------------
// Shared input shapes
// ---------------------------------------------------------------------------

interface MerchantSelection {
  /** AmazonSellerID from amazon merchants. */
  amazonSellerId?: string;
  /** Exact legacySellerId (seller.ID). Use when an AmazonSellerID maps to
   *  several marketplaces. Authoritative disambiguator. */
  legacySellerId?: number | string;
  /** Country code (US, UK, ...) or raw marketplaceId. */
  marketplace?: string;
}

// FOEP -----------------------------------------------------------------------

export interface FoepBatchInput extends MerchantSelection {
  /** FOEP is keyed by SKU (not ASIN). 1..200 for sync; 1..5000 for async. */
  skus: string[];
}

// Mirror of FoepResponseItem on the service side (kept intentionally loose
// because Amazon's per-item body shape can evolve).
export interface FoepResponseItem {
  status: { statusCode: number; reasonPhrase?: string };
  body?: {
    offerIdentifier?: {
      marketplaceId?: string;
      sellerId?: string;
      asin?: string;
      sku?: string;
    };
    featuredOfferExpectedPriceResults?: Array<{
      resultStatus: string;
      currentFeaturedOffer?: unknown;
      competingFeaturedOffer?: unknown;
      featuredOfferExpectedPrice?: {
        listingPrice?: { amount?: string; currencyCode?: string };
      } & Record<string, unknown>;
    } & Record<string, unknown>>;
    errors?: Array<{ code?: string; message?: string }>;
  };
  errors?: Array<{ code?: string; message?: string }>;
}

// Competitive Summary --------------------------------------------------------

export type CompetitiveSummaryIncludedData =
  | 'featuredBuyingOptions'
  | 'referencePrices'
  | 'lowestPricedOffers';

export interface CompetitiveSummaryBatchInput extends MerchantSelection {
  /** Keyed by ASIN. 1..200 for sync; 1..5000 for async. */
  asins: string[];
  /** Defaults to ['featuredBuyingOptions','referencePrices']. */
  includedData?: CompetitiveSummaryIncludedData[];
}

export interface CompetitiveSummaryResponseItem {
  status: { statusCode: number; reasonPhrase?: string };
  body?: {
    asin?: string;
    marketplaceId?: string;
    featuredBuyingOptions?: unknown[];
    referencePrices?: unknown[];
    lowestPricedOffers?: unknown[];
    errors?: Array<{ code?: string; message?: string }>;
  };
  errors?: Array<{ code?: string; message?: string }>;
}

// Run-lifecycle shapes -------------------------------------------------------

export interface PricingRunStatus {
  ok: true;
  runId: string;
  status: string; // IN_QUEUE | IN_PROGRESS | DONE | FATAL | CANCELLED
  itemsTotal: number;
  itemsCompleted: number;
  itemsSucceeded: number;
  itemsFailed: number;
  completedAt: string | null;
  errorDetail: string | null;
  operationClass: string;
  reportType: string;
}

export interface PricingRunResult<T> extends PricingRunStatus {
  responses: T[];
}

export interface PricingStartResult {
  ok: true;
  runId: string;
  status: string;
  itemsTotal: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMerchantBody(input: MerchantSelection): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.amazonSellerId) body.sellerId = input.amazonSellerId;
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
  if (input.marketplace) body.marketplace = input.marketplace;
  return body;
}

const FOEP_SYNC_PATH = '/api/amazon/pricing/get-featured-offer-expected-price-batch';
const FOEP_ASYNC_PATH = '/api/amazon/pricing/get-featured-offer-expected-price-batch/start';
const CS_SYNC_PATH = '/api/amazon/pricing/get-competitive-summary-batch';
const CS_ASYNC_PATH = '/api/amazon/pricing/get-competitive-summary-batch/start';

// ---------------------------------------------------------------------------
// Public API: FOEP
// ---------------------------------------------------------------------------

/** Sync FOEP. Capped at 200 SKUs server-side. Returns responses inline. */
export async function getFeaturedOfferExpectedPriceBatch(
  input: FoepBatchInput,
  opts: ReportClientOptions = {},
): Promise<PricingRunResult<FoepResponseItem> | ReportFailure> {
  const body: Record<string, unknown> = { ...buildMerchantBody(input), skus: input.skus };
  // Sync calls can take up to ~3 min on a 200-SKU job (5 batches @ 35s pacing).
  // Bump the default timeout above the standard 30s.
  const r = await amazonRequest(
    { method: 'POST', path: FOEP_SYNC_PATH, body, surface: 'pricing' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 240_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingRunResult<FoepResponseItem>;
}

/** Async FOEP start. Returns runId; poll separately. */
export async function startFeaturedOfferExpectedPriceBatch(
  input: FoepBatchInput,
  opts: ReportClientOptions = {},
): Promise<PricingStartResult | ReportFailure> {
  const body: Record<string, unknown> = { ...buildMerchantBody(input), skus: input.skus };
  const r = await amazonRequest(
    { method: 'POST', path: FOEP_ASYNC_PATH, body, surface: 'pricing' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingStartResult;
}

// ---------------------------------------------------------------------------
// Public API: Competitive Summary
// ---------------------------------------------------------------------------

export async function getCompetitiveSummaryBatch(
  input: CompetitiveSummaryBatchInput,
  opts: ReportClientOptions = {},
): Promise<PricingRunResult<CompetitiveSummaryResponseItem> | ReportFailure> {
  const body: Record<string, unknown> = {
    ...buildMerchantBody(input),
    asins: input.asins,
  };
  if (input.includedData && input.includedData.length > 0) {
    body.includedData = input.includedData;
  }
  const r = await amazonRequest(
    { method: 'POST', path: CS_SYNC_PATH, body, surface: 'pricing' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 240_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingRunResult<CompetitiveSummaryResponseItem>;
}

export async function startCompetitiveSummaryBatch(
  input: CompetitiveSummaryBatchInput,
  opts: ReportClientOptions = {},
): Promise<PricingStartResult | ReportFailure> {
  const body: Record<string, unknown> = {
    ...buildMerchantBody(input),
    asins: input.asins,
  };
  if (input.includedData && input.includedData.length > 0) {
    body.includedData = input.includedData;
  }
  const r = await amazonRequest(
    { method: 'POST', path: CS_ASYNC_PATH, body, surface: 'pricing' },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingStartResult;
}

// ---------------------------------------------------------------------------
// Public API: run lifecycle (kind-agnostic poll + result)
// ---------------------------------------------------------------------------

/** Poll a pricing run; does not re-call SP-API. */
export async function pollPricingRun(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<PricingRunStatus | ReportFailure> {
  const r = await amazonRequest(
    {
      method: 'GET',
      path: `/api/amazon/pricing/runs/${encodeURIComponent(runId)}`,
      surface: 'pricing',
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingRunStatus;
}

/** Fetch per-item responses for a pricing run. */
export async function getPricingRunResult<T = FoepResponseItem | CompetitiveSummaryResponseItem>(
  runId: string,
  opts: ReportClientOptions = {},
): Promise<PricingRunResult<T> | ReportFailure> {
  const r = await amazonRequest(
    {
      method: 'GET',
      path: `/api/amazon/pricing/runs/${encodeURIComponent(runId)}/result`,
      surface: 'pricing',
    },
    { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  if (!r.ok) return r;
  return r.json as PricingRunResult<T>;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { exitCodeForKind, isReportFailure };
export type { ReportFailure };
