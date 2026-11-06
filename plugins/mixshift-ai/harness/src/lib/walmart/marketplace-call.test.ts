import { describe, it, expect, vi } from 'vitest';

import {
  listMarketplaceSellers,
  listMarketplaceOperations,
  marketplaceCall,
  exitCodeForMarketplaceKind,
  MARKETPLACE_CALL_TIMEOUT_MS,
  type MarketplaceClientOptions,
} from './marketplace-call.js';

function injected(
  fetchImpl: MarketplaceClientOptions['fetchImpl'],
  tokenProvider: MarketplaceClientOptions['tokenProvider'] = async () => 'tok',
): MarketplaceClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Made-up ids: this repo is public.
const SELLER = { sellerId: '1234567890', environment: 'production', label: 'acme', scopes: ['marketplace:read'] };
const READ_OP = { id: 'mp.sku_snapshot', family: 'inventory', method: 'GET', path: '/x', write: false };
const WRITE_OP = { id: 'mp.update_price', family: 'items', method: 'PUT', path: '/y', write: true };
const CATALOG = { ok: true, families: ['inventory', 'items'], operations: [READ_OP, WRITE_OP] };

describe('listMarketplaceSellers', () => {
  it('lists sellers from the right path with a Bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, sellers: [SELLER] }));
    const r = await listMarketplaceSellers(injected(fetchImpl));
    expect(r).toEqual({ ok: true, sellers: [SELLER] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/walmart/marketplace/sellers');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('keeps tenant_not_allowed as its own kind with exit 6', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'tenant_not_allowed' }));
    const r = await listMarketplaceSellers(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('tenant_not_allowed');
      expect(r.friendly).toMatch(/marketplace\/connect/);
      expect(exitCodeForMarketplaceKind(r.kind)).toBe(6);
    }
  });

  it('refreshes the token once on a 401 and retries', async () => {
    const tokens = ['old', 'new'];
    const tokenProvider = vi.fn(async () => tokens.shift()!);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, sellers: [] }));
    const r = await listMarketplaceSellers(injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(true);
    expect(tokenProvider).toHaveBeenLastCalledWith(true);
  });

  it('reports session_expired when the retry is also a 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const r = await listMarketplaceSellers(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('session_expired');
  });
});

describe('listMarketplaceOperations', () => {
  it('encodes the family filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, CATALOG));
    const r = await listMarketplaceOperations('inventory', injected(fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/walmart/marketplace/operations?family=inventory');
    expect(r.ok && r.operations.length).toBe(2);
  });
});

describe('marketplaceCall', () => {
  it('reads the catalog, then posts query/path (not params) with the environment', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          operation: 'mp.sku_snapshot',
          sellerId: '1234567890',
          environment: 'production',
          status: 200,
          payload: { complete: true },
        }),
      );
    const r = await marketplaceCall(
      { operation: 'mp.sku_snapshot', sellerId: '1234567890', environment: 'production', query: { sku: 'ABC-1' } },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://svc.test/api/walmart/marketplace/call');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).not.toHaveProperty('dryRun');
    expect(sent).not.toHaveProperty('body');
    expect(sent).toEqual({
      operation: 'mp.sku_snapshot',
      sellerId: '1234567890',
      environment: 'production',
      query: { sku: 'ABC-1' },
    });
  });

  it('refuses a catalog write client-side and sends nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, CATALOG));
    const r = await marketplaceCall({ operation: 'mp.update_price', sellerId: '1234567890' }, injected(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the catalog read only
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('write_refused');
      expect(r.friendly).toMatch(/MixShift app/);
      expect(exitCodeForMarketplaceKind(r.kind)).toBe(11);
    }
  });

  it('fails closed when the catalog cannot be read', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'seller_not_allowed' }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '9' }, injected(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
  });

  it('gives the sku snapshot a timeout of at least 120 s', () => {
    expect(MARKETPLACE_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });

  it('maps seller_not_allowed to exit 7', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'seller_not_allowed', sellerId: '555' }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('seller_not_allowed');
      expect(r.sellerId).toBe('555');
      expect(exitCodeForMarketplaceKind(r.kind)).toBe(7);
    }
  });

  it('carries Walmart HTTP status on a refused read and explains a 403 as a missing permission', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(502, { ok: false, kind: 'upstream_auth', friendly: "Walmart Marketplace refused MixShift's access for this seller.", status: 403, correlationId: 'c1', walmart: { error: 'forbidden' }, source: 'amazon_rejected', retryable: false }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('upstream_auth');
      expect(r.walmartStatus).toBe(403);
      expect(r.friendly).toMatch(/this one read \(403\)/);
      expect(r.friendly).not.toMatch(/refused MixShift's access/);
      expect(r.message).toBe("Walmart Marketplace refused MixShift's access for this seller.");
    }
  });

  it('treats upstream_auth with reason reauth_required as a dead connection whatever the status', async () => {
    for (const status of [400, 401, 403]) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, CATALOG))
        .mockResolvedValueOnce(
          jsonResponse(502, { ok: false, kind: 'upstream_auth', friendly: "Walmart no longer accepts this seller's connection to MixShift. Reconnect.", status, correlationId: 'c1', reason: 'reauth_required', sellerId: '555' }),
        );
      const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('reauth_required');
        expect(r.friendly).toMatch(/reconnect it by opening https:\/\/mcp\.mixshift\.io\/walmart\/marketplace\/connect/);
        expect(r.friendly).not.toMatch(/this one read/);
      }
    }
  });

  it('does not call upstream_auth without a reason or Walmart body a refused read', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(502, { ok: false, kind: 'upstream_auth', friendly: "Walmart Marketplace refused MixShift's access for this seller.", status: 401 }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.friendly).not.toMatch(/this one read/);
  });

  it('never refreshes the MixShift token for a Walmart 401 inside the gateway 502 envelope', async () => {
    const tokenProvider = vi.fn(async () => 'tok');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(502, { ok: false, kind: 'upstream_auth', status: 401, walmart: { error: 'x' } }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(false);
    expect(tokenProvider).not.toHaveBeenCalledWith(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('marks failures with operationKnown so telemetry never carries mistyped text', async () => {
    const known = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(403, { ok: false, kind: 'seller_not_allowed' }));
    const a = await marketplaceCall({ operation: 'mp.sku_snapshot', sellerId: '5' }, injected(known));
    const typo = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, kind: 'invalid_request', source: 'request' }));
    const b = await marketplaceCall({ operation: 'my secret note', sellerId: '5' }, injected(typo));
    expect(!a.ok && a.operationKnown).toBe(true);
    expect(!b.ok && b.operationKnown).toBe(false);
  });

  it('treats upstream_unavailable as Walmart being down, not a reconnect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(502, { ok: false, kind: 'upstream_unavailable' }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('upstream_unavailable');
      expect(r.friendly).toMatch(/does not need to reconnect/);
    }
  });

  it('flags an unrecognized kind instead of hiding it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, CATALOG))
      .mockResolvedValueOnce(jsonResponse(500, { ok: false, kind: 'brand_new_kind' }));
    const r = await marketplaceCall({ operation: 'mp.list_orders', sellerId: '555' }, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unknown');
      expect(r.unrecognizedKind).toBe('brand_new_kind');
    }
  });
});
