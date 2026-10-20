import { describe, it, expect, vi } from 'vitest';
import {
  exitCodeForShelfKind,
  shelfBuybox,
  shelfOffers,
  shelfProduct,
  shelfSearch,
  shelfSeller,
  shelfUsage,
  shelfZips,
  type ShelfClientOptions,
} from './client.js';

// Inject api_base + token + fetch so the suite never touches disk.
function injected(
  fetchImpl: ShelfClientOptions['fetchImpl'],
  tokenProvider: ShelfClientOptions['tokenProvider'] = async () => 'tok',
): ShelfClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Made-up subjects and sellers: this repo is public.
const BUYBOX = {
  ok: true,
  kind: 'buybox',
  retailer: 'amazon',
  country: 'us',
  zip: '75201',
  subject: 'B0EXAMPLE01',
  observed_at: '2026-10-19T23:01:45.167Z',
  source: 'shelf',
  data: { price: 7.99, currency: '$', in_stock: true, stock: 8, sold_by: 'Example Seller Co', seller_id: 'A1EXAMPLESELLER', promise_days_fastest: 1 },
};

describe('data calls', () => {
  it('buybox: POSTs the body with the ASIN upper-cased, a Bearer and JSON, and returns the envelope', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, BUYBOX));
    const r = await shelfBuybox({ asin: 'b0example01', zip: '75201', fresh: true, origin: 'demo' }, injected(fetchImpl));
    expect(r).toEqual(BUYBOX);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/shelf/buybox');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ asin: 'B0EXAMPLE01', zip: '75201', fresh: true, origin: 'demo' });
  });

  it('omits empty optional inputs and never sends fresh: false', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ...BUYBOX, kind: 'offers', data: { product: null, offers: [], offer_count: 0 } }));
    await shelfOffers({ asin: 'B0EXAMPLE01', zip: '', fresh: false, country: 'ca' }, injected(fetchImpl));
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).toEqual({ asin: 'B0EXAMPLE01', country: 'ca' });
  });

  it('search: sends query, surface and page to the search path', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ...BUYBOX, kind: 'search_mobile', subject: 'trail mix', data: { surface: 'mobile', page: 2, products: [] } }));
    const r = await shelfSearch({ query: '  trail mix ', surface: 'mobile', page: 2, zip: '10001' }, injected(fetchImpl));
    expect(r.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/shelf/search');
    expect(JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))).toEqual({ query: 'trail mix', surface: 'mobile', page: 2, zip: '10001' });
  });

  it('product keeps beta: true; seller sends seller_id and no zip', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ...BUYBOX, kind: 'product', beta: true, data: { title: 'T' } }))
      .mockResolvedValueOnce(jsonResponse(200, { ...BUYBOX, kind: 'seller', zip: '', subject: 'A1EXAMPLESELLER', data: { name: 'Example Seller Co' } }));
    const p = await shelfProduct({ asin: 'B0EXAMPLE01' }, injected(fetchImpl));
    expect(p).toMatchObject({ ok: true, beta: true, kind: 'product' });
    const s = await shelfSeller({ sellerId: ' a1exampleseller ' }, injected(fetchImpl));
    expect(s).toMatchObject({ ok: true, kind: 'seller', zip: '' });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://svc.test/api/shelf/seller');
    expect(JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))).toEqual({ seller_id: 'A1EXAMPLESELLER' });
  });

  it('an answer without its envelope fields is an unknown failure, not a crash', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, something: 1 }));
    const r = await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'unknown', httpStatus: 200 });
  });
});

describe('free calls', () => {
  it('zips: GET with the country, parsed into a list', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, retailer: 'amazon', country: 'ca', count: 2, zips: ['M5V 3L9', 'V6B 1A1'] }));
    const r = await shelfZips('ca', injected(fetchImpl));
    expect(r).toEqual({ ok: true, retailer: 'amazon', country: 'ca', count: 2, zips: ['M5V 3L9', 'V6B 1A1'] });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/shelf/zips?country=ca');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('GET');
  });

  it('usage: the counter, remaining computed when absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, period: '2026-10', allowance: 2000, used: 27, resets_at: '2026-11-01T00:00:00.000Z', source: 'discovery_first_month' }));
    const r = await shelfUsage(injected(fetchImpl));
    expect(r).toEqual({ ok: true, period: '2026-10', allowance: 2000, used: 27, remaining: 1973, resets_at: '2026-11-01T00:00:00.000Z', source: 'discovery_first_month' });
  });
});

describe('failure mapping (the shelf kind set, never collapsed to unknown)', () => {
  it('shelf_not_enabled keeps its kind and the service friendly line', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'shelf_not_enabled', friendly: 'Shelf data is not enabled for your organization yet.', source: 'account', retryable: false }));
    const r = await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'shelf_not_enabled', friendly: 'Shelf data is not enabled for your organization yet.', httpStatus: 403, source: 'account', retryable: false });
    expect(exitCodeForShelfKind('shelf_not_enabled')).toBe(6);
  });

  it('shelf_allowance_exhausted carries the counter and the reset date', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(402, { ok: false, kind: 'shelf_allowance_exhausted', friendly: 'used up', period: '2026-10', allowance: 2000, used: 2000, resets_at: '2026-11-01T00:00:00.000Z' }));
    const r = await shelfSearch({ query: 'x' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'shelf_allowance_exhausted', period: '2026-10', allowance: 2000, used: 2000, resetsAt: '2026-11-01T00:00:00.000Z' });
    expect(exitCodeForShelfKind('shelf_allowance_exhausted')).toBe(10);
  });

  it('zip_unavailable carries available_count; bad_request and invalid_request stay apart', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'zip_unavailable', friendly: 'no', country: 'us', available_count: 309 }))
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'bad_request', friendly: 'No such ASIN or seller on this marketplace.', message: 'ASIN Not Found' }))
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'invalid_request', friendly: 'The request body is invalid.', source: 'request', message: 'asin: Invalid' }));
    expect(await shelfBuybox({ asin: 'B0EXAMPLE01', zip: '37217' }, injected(fetchImpl))).toMatchObject({ kind: 'zip_unavailable', availableCount: 309 });
    expect(await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl))).toMatchObject({ kind: 'bad_request', message: 'ASIN Not Found' });
    expect(await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl))).toMatchObject({ kind: 'invalid_request', source: 'request' });
    expect(exitCodeForShelfKind('zip_unavailable')).toBe(12);
    expect(exitCodeForShelfKind('bad_request')).toBe(12);
    expect(exitCodeForShelfKind('invalid_request')).toBe(15);
  });

  it('an unknown service kind is kept as unrecognizedKind and reverse-mapped from the status', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(429, { ok: false, kind: 'shelf_rate_limited', friendly: 'slow down', retryAfterMs: 1000 }));
    const r = await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'throttled', unrecognizedKind: 'shelf_rate_limited', retryAfterMs: 1000, friendly: 'slow down' });
    expect(exitCodeForShelfKind('throttled')).toBe(8);
  });

  it('a 401 forces one token refresh and retries once; a second 401 is session_expired', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(401, { ok: false, kind: 'invalid_token' })).mockResolvedValueOnce(jsonResponse(200, BUYBOX));
    const tokenProvider = vi.fn(async (force?: boolean) => (force ? 'tok2' : 'tok1'));
    const r = await shelfBuybox({ asin: 'B0EXAMPLE01' }, injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(true);
    expect(tokenProvider).toHaveBeenCalledWith(true);
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok2' });

    const twice = vi.fn().mockResolvedValue(jsonResponse(401, { ok: false, kind: 'invalid_token' }));
    const again = await shelfUsage(injected(twice, tokenProvider));
    expect(again).toMatchObject({ ok: false, kind: 'session_expired' });
    expect(exitCodeForShelfKind('session_expired')).toBe(2);
  });

  it('a network failure is host_unreachable; no token means not_authenticated', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error('fetch failed'));
    expect(await shelfZips('us', injected(fetchImpl))).toMatchObject({ ok: false, kind: 'host_unreachable' });
    const noToken = vi.fn(async () => {
      throw new Error('No credentials found');
    });
    expect(await shelfZips('us', injected(vi.fn(), noToken))).toMatchObject({ ok: false, kind: 'not_authenticated' });
  });
});
