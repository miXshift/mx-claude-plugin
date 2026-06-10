import { describe, it, expect, vi } from 'vitest';

import { listOperations, spapiCall } from './spapi-call.js';
import type { ReportClientOptions } from './reports.js';

// Inject api_base + token + fetch so the suite never touches disk (mirrors
// reports.test.ts).
function injected(
  fetchImpl: ReportClientOptions['fetchImpl'],
  tokenProvider: ReportClientOptions['tokenProvider'] = async () => 'tok',
): ReportClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OPERATION_VIEW = {
  id: 'catalog.search_items',
  family: 'Catalog Items',
  operation: 'searchCatalogItems',
  version: '2022-04-01',
  role: 'Product Listing',
  method: 'GET' as const,
  pathTemplate: '/catalog/2022-04-01/items',
  marketplaceParam: 'marketplaceIds',
  summary: 'Look up catalog items.',
  notes: 'identifiers csv max 20.',
  docsUrl: 'https://developer-docs.amazon.com/sp-api/docs/catalog-items-api-v2022-04-01-reference',
};

describe('listOperations', () => {
  it('lists the catalog and hits the right path', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, operations: [OPERATION_VIEW] }));
    const r = await listOperations(undefined, injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.operations).toEqual([OPERATION_VIEW]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/spapi/operations');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('encodes the family filter into the query string', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, operations: [] }));
    const r = await listOperations('Data Kiosk', injected(fetchImpl));
    expect(r.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/spapi/operations?family=Data%20Kiosk',
    );
  });
});

describe('spapiCall', () => {
  it('POSTs the wire shape (amazonSellerId -> sellerId, numeric legacySellerId) and returns the payload verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'catalog.search_items',
        amazonSellerId: 'A1',
        legacySellerId: 71,
        marketplaceId: 'ATVPDKIKX0DER',
        payload: { numberOfResults: 1, items: [{ asin: 'B0TEST' }] },
      }),
    );
    const r = await spapiCall(
      {
        operation: 'catalog.search_items',
        amazonSellerId: 'A1',
        legacySellerId: '71',
        query: { identifiers: 'B0TEST', identifiersType: 'ASIN' },
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.operation).toBe('catalog.search_items');
      expect(r.legacySellerId).toBe(71);
      expect(r.payload).toEqual({ numberOfResults: 1, items: [{ asin: 'B0TEST' }] });
    }

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/spapi/call');
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      operation: 'catalog.search_items',
      sellerId: 'A1',
      legacySellerId: 71,
      query: { identifiers: 'B0TEST', identifiersType: 'ASIN' },
    });
  });

  it('omits absent fields and includes pathParams + body when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'data_kiosk.create_query',
        amazonSellerId: 'A1',
        legacySellerId: 71,
        marketplaceId: 'ATVPDKIKX0DER',
        payload: { queryId: 'Q1' },
      }),
    );
    const r = await spapiCall(
      {
        operation: 'data_kiosk.create_query',
        body: { query: 'query { ... }' },
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(sent).toEqual({
      operation: 'data_kiosk.create_query',
      body: { query: 'query { ... }' },
    });
    expect('sellerId' in sent).toBe(false);
    expect('pathParams' in sent).toBe(false);
  });

  it('maps a service failure envelope to a typed ReportFailure (kind preserved)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        kind: 'restricted_report',
        friendly: 'Amazon denied vendor_orders.get_purchase_orders (403).',
        operation: 'vendor_orders.get_purchase_orders',
      }),
    );
    const r = await spapiCall(
      { operation: 'vendor_orders.get_purchase_orders' },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('restricted_report');
      expect(r.friendly).toMatch(/vendor_orders\.get_purchase_orders/);
      expect(r.httpStatus).toBe(403);
    }
  });

  it('surfaces merchant_not_found candidates for multi-marketplace sellers', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(404, {
        ok: false,
        kind: 'merchant_not_found',
        friendly: 'This seller trades in multiple marketplaces.',
        candidates: [
          { legacySellerId: 71, amazonSellerId: 'A1', marketplaceId: 'ATVPDKIKX0DER' },
          { legacySellerId: 200, amazonSellerId: 'A1', marketplaceId: 'A2EUQ1WTGCTBG2' },
        ],
      }),
    );
    const r = await spapiCall({ operation: 'catalog.search_items', amazonSellerId: 'A1' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('merchant_not_found');
      expect(r.candidates).toHaveLength(2);
    }
  });

  it('retries once on a mid-session 401 with a refreshed token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { ok: false, error: 'token_expired' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          operation: 'sellers.get_marketplace_participations',
          amazonSellerId: 'A1',
          legacySellerId: 71,
          marketplaceId: 'ATVPDKIKX0DER',
          payload: {},
        }),
      );
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const r = await spapiCall(
      { operation: 'sellers.get_marketplace_participations' },
      injected(fetchImpl, tokenProvider),
    );
    expect(r.ok).toBe(true);
    expect(tokenProvider).toHaveBeenNthCalledWith(1, false);
    expect(tokenProvider).toHaveBeenNthCalledWith(2, true);
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer fresh',
    });
  });
});
