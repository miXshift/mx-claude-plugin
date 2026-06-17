import { describe, it, expect, vi } from 'vitest';

import { listAdsProfiles, listAdsOperations, adsCall } from './ads-call.js';
import { exitCodeForKind, type ReportClientOptions } from './reports.js';

// Inject api_base + token + fetch so the suite never touches disk (mirrors
// reports.test.ts / spapi-call.test.ts).
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

const PROFILE = {
  profileId: '2835259260187719',
  legacySellerId: 623,
  amazonSellerId: 'A3QZKJBUHVI46V',
  name: 'Hearth IQ USA',
  merchantType: 'Seller',
  merchantRegion: 'America',
  marketplaceId: 'ATVPDKIKX0DER',
  countryCode: 'US',
  marketplaceName: 'Amazon.com',
};

describe('listAdsProfiles', () => {
  it('lists profiles and hits the right path with a Bearer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, profiles: [PROFILE] }));
    const r = await listAdsProfiles(injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profiles).toEqual([PROFILE]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/ads/profiles');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('maps ads_not_configured to the typed kind with the shared exit code', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(503, {
        ok: false,
        kind: 'ads_not_configured',
        friendly: 'The Amazon Ads API is not enabled on this service. Contact MixShift ops.',
      }),
    );
    const r = await listAdsProfiles(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('ads_not_configured');
      expect(exitCodeForKind(r.kind)).toBe(6);
    }
  });
});

describe('listAdsOperations', () => {
  it('encodes the family filter', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, operations: [] }));
    const r = await listAdsOperations('Sponsored Products', injected(fetchImpl));
    expect(r.ok).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/ads/operations?family=Sponsored%20Products',
    );
  });
});

describe('adsCall', () => {
  it('POSTs the wire shape (numeric legacySellerId, selectors, body) and returns the payload verbatim', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'sp.list_campaigns',
        profileId: '2835259260187719',
        legacySellerId: 623,
        marketplaceId: 'ATVPDKIKX0DER',
        payload: { campaigns: [{ campaignId: '1' }], totalResults: 1 },
      }),
    );
    const r = await adsCall(
      {
        operation: 'sp.list_campaigns',
        legacySellerId: '623',
        body: { maxResults: 10 },
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profileId).toBe('2835259260187719');
      expect(r.payload).toEqual({ campaigns: [{ campaignId: '1' }], totalResults: 1 });
    }

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/ads/call');
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toEqual({
      operation: 'sp.list_campaigns',
      legacySellerId: 623,
      body: { maxResults: 10 },
    });
  });

  it('carries profileId, pathParams, query, and contentTypeOverride when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'reporting.get_report',
        profileId: 'P1',
        legacySellerId: 623,
        marketplaceId: null,
        payload: { status: 'COMPLETED', url: 'https://presigned' },
      }),
    );
    const r = await adsCall(
      {
        operation: 'reporting.get_report',
        profileId: 'P1',
        pathParams: { reportId: 'R-1' },
        query: { foo: ['a', 'b'] },
        contentTypeOverride: 'application/vnd.x.v9+json',
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.marketplaceId).toBeNull();
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(sent).toEqual({
      operation: 'reporting.get_report',
      profileId: 'P1',
      pathParams: { reportId: 'R-1' },
      query: { foo: ['a', 'b'] },
      contentTypeOverride: 'application/vnd.x.v9+json',
    });
  });

  it('surfaces merchant_not_found candidates for ambiguous profile selection', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(404, {
        ok: false,
        kind: 'merchant_not_found',
        friendly: 'This seller trades in multiple marketplaces.',
        candidates: [
          { legacySellerId: 623, marketplaceId: 'ATVPDKIKX0DER' },
          { legacySellerId: 622, marketplaceId: 'A1AM78C64UM0Y8' },
        ],
      }),
    );
    const r = await adsCall({ operation: 'sp.list_campaigns', sellerId: 'A3QZKJBUHVI46V' }, injected(fetchImpl));
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
          operation: 'profiles.list',
          profileId: 'P1',
          legacySellerId: 623,
          marketplaceId: 'ATVPDKIKX0DER',
          payload: [],
        }),
      );
    const tokenProvider = vi
      .fn()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh');
    const r = await adsCall({ operation: 'profiles.list' }, injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(true);
    expect(tokenProvider).toHaveBeenNthCalledWith(1, false);
    expect(tokenProvider).toHaveBeenNthCalledWith(2, true);
  });
});

describe('adsCall writes (dryRun contract)', () => {
  it('omits dryRun from the wire unless the caller set it (the service default is the contract)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'sp.update_keywords',
        profileId: 'P1',
        legacySellerId: 623,
        marketplaceId: 'ATVPDKIKX0DER',
        dryRun: true,
        itemsCount: 1,
        auditId: 'aud-1',
        preview: { keywords: [{ keywordId: 'K1', bid: 2.05 }] },
      }),
    );
    const r = await adsCall(
      {
        operation: 'sp.update_keywords',
        legacySellerId: 623,
        body: { keywords: [{ keywordId: 'K1', bid: 2.05 }] },
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect('dryRun' in sent).toBe(false);
    if (r.ok) {
      expect(r.dryRun).toBe(true);
      expect(r.itemsCount).toBe(1);
      expect(r.auditId).toBe('aud-1');
      expect(r.preview).toEqual({ keywords: [{ keywordId: 'K1', bid: 2.05 }] });
      expect(r.payload).toBeUndefined();
    }
  });

  it('sends dryRun:false only on explicit commit and parses the commit response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        operation: 'sp.update_keywords',
        profileId: 'P1',
        legacySellerId: 623,
        marketplaceId: 'ATVPDKIKX0DER',
        dryRun: false,
        itemsCount: 1,
        auditId: 'aud-2',
        beforeState: { keywords: [{ keywordId: 'K1', bid: 2.05 }] },
        payload: { keywords: { success: [{ keywordId: 'K1', index: 0 }], error: [] } },
      }),
    );
    const r = await adsCall(
      {
        operation: 'sp.update_keywords',
        legacySellerId: 623,
        body: { keywords: [{ keywordId: 'K1', bid: 2.1 }] },
        dryRun: false,
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const sent = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(sent.dryRun).toBe(false);
    if (r.ok) {
      expect(r.dryRun).toBe(false);
      expect(r.auditId).toBe('aud-2');
      expect(r.beforeState).toEqual({ keywords: [{ keywordId: 'K1', bid: 2.05 }] });
      expect(r.payload).toEqual({ keywords: { success: [{ keywordId: 'K1', index: 0 }], error: [] } });
    }
  });

  it('maps insufficient_scope to the typed kind with its own exit code', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        kind: 'insufficient_scope',
        friendly: 'This credential lacks the ads:write scope.',
        required_scope: 'ads:write',
      }),
    );
    const r = await adsCall(
      { operation: 'sp.update_keywords', legacySellerId: 623, body: { keywords: [] }, dryRun: false },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('insufficient_scope');
      expect(exitCodeForKind(r.kind)).toBe(11);
      expect(r.friendly).toMatch(/ads:write/);
    }
  });
});
