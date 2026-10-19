import { describe, it, expect, vi } from 'vitest';

import {
  listWalmartAdvertisers,
  listWalmartOperations,
  walmartAdsCall,
  exitCodeForWalmartKind,
  type WalmartClientOptions,
} from './ads-call.js';

// Inject api_base + token + fetch so the suite never touches disk.
function injected(
  fetchImpl: WalmartClientOptions['fetchImpl'],
  tokenProvider: WalmartClientOptions['tokenProvider'] = async () => 'tok',
): WalmartClientOptions {
  return { apiBaseOverride: 'https://svc.test', tokenProvider, fetchImpl };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Made-up ids: this repo is public.
const ADVERTISER = {
  label: 'acme',
  advertiserId: '1000001',
  api: 'sponsored_search',
  environment: 'production',
  access: 'owner',
};

describe('listWalmartAdvertisers', () => {
  it('lists advertisers from the right path with a Bearer', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, advertisers: [ADVERTISER] }));
    const r = await listWalmartAdvertisers(injected(fetchImpl));
    expect(r).toEqual({ ok: true, advertisers: [ADVERTISER] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/walmart/ads/advertisers');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('keeps tenant_not_allowed as its own kind (the Amazon kind set would collapse it to unknown)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        kind: 'tenant_not_allowed',
        friendly: 'Walmart Connect is not enabled for this MixShift account yet. Contact MixShift to join the beta.',
      }),
    );
    const r = await listWalmartAdvertisers(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('tenant_not_allowed');
      expect(r.friendly).toMatch(/not enabled for this MixShift account/);
      expect(r.unrecognizedKind).toBeUndefined();
      expect(exitCodeForWalmartKind(r.kind)).toBe(6);
    }
  });

  it('refreshes the token once on a 401 and retries', async () => {
    const tokens = ['old', 'new'];
    const tokenProvider = vi.fn(async () => tokens.shift()!);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, advertisers: [] }));
    const r = await listWalmartAdvertisers(injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(true);
    expect(tokenProvider).toHaveBeenLastCalledWith(true);
    expect((fetchImpl.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new' });
  });
});

describe('listWalmartOperations', () => {
  it('encodes the family filter and returns families + operations', async () => {
    const op = { id: 'ss.list_campaigns', family: 'Sponsored Search', api: 'sponsored_search', method: 'GET', path: '/api/v1/campaigns', write: false };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, families: ['Sponsored Search'], operations: [op] }));
    const r = await listWalmartOperations('Sponsored Search', injected(fetchImpl));
    expect(fetchImpl.mock.calls[0][0]).toBe('https://svc.test/api/walmart/ads/operations?family=Sponsored%20Search');
    expect(r).toEqual({ ok: true, families: ['Sponsored Search'], operations: [op] });
  });
});

describe('walmartAdsCall', () => {
  it('POSTs the wire shape and omits dryRun unless the caller set it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'ss.list_campaigns',
        environment: 'production',
        advertiserId: '1000001',
        status: 200,
        correlationId: 'c-1',
        payload: [{ campaignId: 1, status: 'live' }],
      }),
    );
    const r = await walmartAdsCall(
      { operation: 'ss.list_campaigns', advertiserId: '1000001', query: { limit: '5' } },
      injected(fetchImpl),
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/walmart/ads/call');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      operation: 'ss.list_campaigns',
      advertiserId: '1000001',
      query: { limit: '5' },
    });
    expect(r).toMatchObject({
      ok: true,
      operation: 'ss.list_campaigns',
      environment: 'production',
      advertiserId: '1000001',
      status: 200,
      correlationId: 'c-1',
      payload: [{ campaignId: 1, status: 'live' }],
    });
  });

  it('passes a write preview through untouched and sends dryRun:false only on commit', async () => {
    const preview = {
      ok: true,
      dryRun: true,
      operation: 'ss.update_campaigns',
      environment: 'sandbox',
      advertiserId: '1000001',
      preview: { method: 'PUT', path: '/api/v1/campaigns', body: [{ campaignId: 1, status: 'paused' }] },
      message: 'Preview only, nothing was sent to Walmart.',
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, preview));
    const r = await walmartAdsCall(
      { operation: 'ss.update_campaigns', advertiserId: '1000001', body: [{ campaignId: 1, status: 'paused' }] },
      injected(fetchImpl),
    );
    expect(r).toMatchObject({ ok: true, dryRun: true, preview: preview.preview });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).not.toHaveProperty('dryRun');

    await walmartAdsCall(
      { operation: 'ss.update_campaigns', advertiserId: '1000001', body: [], dryRun: false },
      injected(fetchImpl),
    );
    expect(JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string)).toMatchObject({ dryRun: false });
  });

  // Shape from a real grouped download (production, 2026-10-13): rows hold one
  // summed row per group with a sourceRows count; rowCount is the raw file.
  it('keeps download fields (ready, rows, groupCount) the service adds', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'ss.download_report',
        environment: 'production',
        advertiserId: '1000001',
        snapshotId: '42',
        ready: true,
        jobStatus: 'done',
        rowCount: 3,
        groupBy: ['campaignId'],
        groupCount: 1,
        truncated: false,
        columns: ['campaignId', 'numAdsShown', 'numAdsClicks', 'adSpend', 'sourceRows'],
        rows: [{ campaignId: '1', numAdsShown: 100, numAdsClicks: 5, adSpend: 10, sourceRows: 3 }],
      }),
    );
    const r = await walmartAdsCall(
      { operation: 'ss.download_report', advertiserId: '1000001', query: { snapshotId: '42', groupBy: 'campaignId' } },
      injected(fetchImpl),
    );
    expect(r).toMatchObject({ ok: true, ready: true, rowCount: 3, groupCount: 1, rows: [{ campaignId: '1', adSpend: 10, sourceRows: 3 }] });
  });

  it('maps advertiser_not_allowed with the echoed advertiser id and exit 7', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        kind: 'advertiser_not_allowed',
        friendly: 'That Walmart advertiser is not connected to this MixShift account.',
        advertiserId: '999',
      }),
    );
    const r = await walmartAdsCall({ operation: 'ss.list_campaigns', advertiserId: '999' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'advertiser_not_allowed', advertiserId: '999', httpStatus: 403 });
    if (!r.ok) expect(exitCodeForWalmartKind(r.kind)).toBe(7);
  });

  it('carries the required scope on insufficient_scope', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, { ok: false, kind: 'insufficient_scope', friendly: 'needs ads:write', required: 'ads:write' }),
    );
    const r = await walmartAdsCall({ operation: 'ss.update_campaigns', advertiserId: '1000001' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'insufficient_scope', requiredScope: 'ads:write' });
  });

  it('records an unrecognized kind instead of hiding it, and never says Amazon', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(500, { ok: false, kind: 'brand_new_kind' }));
    const r = await walmartAdsCall({ operation: 'ss.list_campaigns', advertiserId: '1000001' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'unknown', unrecognizedKind: 'brand_new_kind' });
    if (!r.ok) expect(r.friendly).not.toMatch(/Amazon/);
  });

  it('maps the UNCERTAIN write envelope: request outcome, automaticRetry and the change id', async () => {
    // Shape from the service's live envelope (ids faked: this repo is public).
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(502, {
        ok: false,
        kind: 'upstream_unavailable',
        friendly: 'Walmart did not confirm this change, so it may or may not have been applied.',
        message: 'Walmart Connect stopped answering partway through.',
        requestOutcome: 'unknown',
        automaticRetry: false,
        auditId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    const r = await walmartAdsCall(
      { operation: 'ss.update_campaigns', advertiserId: '1000001', body: [], dryRun: false },
      injected(fetchImpl),
    );
    expect(r).toMatchObject({
      ok: false,
      kind: 'upstream_unavailable',
      requestOutcome: 'unknown',
      automaticRetry: false,
      auditId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('a failure without those fields carries none of them (the fail-closed refusal)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(500, { ok: false, kind: 'unknown', friendly: 'The change was NOT sent to Walmart.' }),
    );
    const r = await walmartAdsCall(
      { operation: 'ss.update_campaigns', advertiserId: '1000001', body: [], dryRun: false },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.requestOutcome).toBeUndefined();
      expect(r.automaticRetry).toBeUndefined();
      expect(r.auditId).toBeUndefined();
    }
  });

  it('reports an unknown outcome when a commit loses its answer', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValueOnce(timeout);
    const r = await walmartAdsCall(
      { operation: 'ss.update_campaigns', advertiserId: '1000001', body: [], dryRun: false },
      injected(fetchImpl),
    );
    expect(r).toMatchObject({ ok: false, kind: 'host_unreachable', requestOutcome: 'unknown' });
    if (!r.ok) expect(r.friendly).toMatch(/may still have gone through/);
  });

  it('a read that times out is plainly unreachable (nothing could have changed)', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValueOnce(timeout);
    const r = await walmartAdsCall({ operation: 'ss.list_campaigns', advertiserId: '1000001' }, injected(fetchImpl));
    expect(r).toMatchObject({ ok: false, kind: 'host_unreachable' });
    if (!r.ok) expect(r.requestOutcome).toBeUndefined();
  });

  it('a missing token is not_authenticated with exit 2', async () => {
    const fetchImpl = vi.fn();
    const r = await walmartAdsCall(
      { operation: 'ss.list_campaigns', advertiserId: '1000001' },
      injected(fetchImpl, async () => {
        throw new Error('No datahub credentials found');
      }),
    );
    expect(r).toMatchObject({ ok: false, kind: 'not_authenticated' });
    if (!r.ok) expect(exitCodeForWalmartKind(r.kind)).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
