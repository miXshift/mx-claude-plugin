/**
 * Client for the generic SP-API call surface on mx-legacy-auth
 * (https://mcp.mixshift.io). Sibling of reports.ts / pricing.ts, built on the
 * same amazonRequest transport (Bearer + 401-refresh-retry + envelope
 * mapping).
 *
 * What this surface is FOR: the long tail of SP-API READ operations beyond
 * reports and pricing batches — live catalog lookups, FBA inventory, order
 * metrics, finances transactions, orders search, offer depth, listings state,
 * Data Kiosk GraphQL, vendor purchase orders. The service holds a curated
 * operation catalog; a missing operation is a one-entry service change, never
 * new plugin plumbing.
 *
 * Two calls:
 *   listOperations → GET  /api/amazon/spapi/operations[?family=...]
 *   spapiCall      → POST /api/amazon/spapi/call
 *
 * Discovery-first usage: call listOperations (or `mixshift amazon
 * operations`) and READ THE NOTES before calling — they carry the required
 * params, casing gotchas (several v0 operations use PascalCase query params),
 * caps, and body shapes. The service injects the resolved marketplaceId into
 * the right query param and auto-fills {sellerId} path placeholders; callers
 * pass only what the notes ask for.
 *
 * The Amazon response body comes back VERBATIM under `payload` — the service
 * does not remodel it, so Amazon's public docs (docsUrl per operation) are
 * the response-shape contract.
 *
 * Failure envelope: identical kinds to reports.ts (branch on `kind`). A 403
 * surfaces as kind=restricted_report with the operation id in the message:
 * the app's roles or this seller's authorization do not cover the operation.
 */

import {
  amazonRequest,
  type ReportClientOptions,
  type ReportFailure,
} from './reports.js';

// ---------------------------------------------------------------------------
// Types (mirror the service's SpApiOperationView / SpApiCallResult)
// ---------------------------------------------------------------------------

/** One callable operation from the service catalog. `notes` is the
 *  integration contract: required params, casing, caps, body shape. */
export interface SpApiOperationView {
  /** Stable id for spapiCall, e.g. 'catalog.search_items'. */
  id: string;
  /** Display family, e.g. 'Catalog Items', 'Data Kiosk'. */
  family: string;
  /** Amazon's operation name, verbatim (for docs searchability). */
  operation: string;
  /** API version segment, e.g. '2022-04-01' or 'v0'. */
  version: string;
  /** Which app role gates it (informational; Amazon enforces). */
  role: string;
  method: 'GET' | 'POST' | 'DELETE';
  pathTemplate: string;
  /** Query param the service fills with the resolved marketplaceId. */
  marketplaceParam?: string;
  /** 'required' when the operation takes a JSON body. */
  body?: 'required' | 'none';
  summary: string;
  notes?: string;
  /** Present when Amazon scheduled removal or recommends a successor. */
  deprecation?: string;
  docsUrl: string;
}

export interface ListOperationsResult {
  ok: true;
  operations: SpApiOperationView[];
}

/** Query values: scalars or arrays (arrays join to Amazon's csv form). */
export type SpApiQueryValue = string | number | boolean | Array<string | number>;

export interface SpApiCallInput {
  /** Operation id from listOperations, e.g. 'fba_inventory.get_inventory_summaries'. */
  operation: string;
  /** AmazonSellerID from `amazon merchants`. Optional for single-merchant tenants. */
  amazonSellerId?: string;
  /** Exact per-marketplace seller record id; the authoritative disambiguator. */
  legacySellerId?: number | string;
  /** Country code (US, UK, ...) or raw marketplaceId. */
  marketplace?: string;
  /** Path placeholders, e.g. { asin: 'B0...' }. {sellerId} auto-fills server-side. */
  pathParams?: Record<string, string>;
  /** Query params per the operation notes. */
  query?: Record<string, SpApiQueryValue>;
  /** JSON body, only when the operation's catalog entry marks body: required. */
  body?: unknown;
}

export interface SpApiCallSuccess {
  ok: true;
  operation: string;
  amazonSellerId: string;
  legacySellerId: number;
  marketplaceId: string;
  /** Amazon's response body, verbatim. Shape per the operation's docsUrl. */
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** List the service's operation catalog, optionally filtered to one family. */
export async function listOperations(
  family?: string,
  opts: ReportClientOptions = {},
): Promise<ListOperationsResult | ReportFailure> {
  const qs = family ? `?family=${encodeURIComponent(family)}` : '';
  const r = await amazonRequest(
    { method: 'GET', path: `/api/amazon/spapi/operations${qs}` },
    { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  if (!r.ok) return r;
  const raw = (r.json as { operations?: unknown }).operations;
  const operations = Array.isArray(raw) ? (raw as SpApiOperationView[]) : [];
  return { ok: true, operations };
}

/** Execute one cataloged SP-API operation. Read-only against Amazon. */
export async function spapiCall(
  input: SpApiCallInput,
  opts: ReportClientOptions = {},
): Promise<SpApiCallSuccess | ReportFailure> {
  // Wire shape per the service handoff doc (POST /api/amazon/spapi/call). The
  // plugin's amazonSellerId goes on the wire as `sellerId`, mirroring
  // reports.ts; absent fields are omitted so the service applies its defaults.
  const body: Record<string, unknown> = { operation: input.operation };
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
  if (input.pathParams && Object.keys(input.pathParams).length > 0) {
    body.pathParams = input.pathParams;
  }
  if (input.query && Object.keys(input.query).length > 0) body.query = input.query;
  if (input.body !== undefined) body.body = input.body;

  // 60s: Data Kiosk getDocument and orders searches can be slow under load,
  // and unlike report documents the payload comes back inline.
  const r = await amazonRequest(
    { method: 'POST', path: '/api/amazon/spapi/call', body },
    { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  if (!r.ok) return r;
  const json = r.json as Partial<SpApiCallSuccess>;
  if (typeof json.operation !== 'string') {
    return {
      ok: false,
      kind: 'unknown',
      friendly:
        'The service accepted the call but returned an unrecognized shape. ' +
        'Try again, or contact MixShift ops if it persists.',
      message: `call response missing operation echo`,
    };
  }
  return {
    ok: true,
    operation: json.operation,
    amazonSellerId: String(json.amazonSellerId ?? ''),
    legacySellerId: Number(json.legacySellerId ?? 0),
    marketplaceId: String(json.marketplaceId ?? ''),
    payload: json.payload,
  };
}
