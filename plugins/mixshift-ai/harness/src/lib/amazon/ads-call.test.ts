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

// ---------------------------------------------------------------------------
// Unknown outcomes. The service sends a report create to Amazon only once, so
// a 5xx, a timeout or a lost answer cannot prove nothing was created, and a
// blind resend can make a duplicate. These envelopes are the PRODUCER's own
// output, captured from mx-legacy-auth's SpApiError.toEnvelope() for its
// retryPolicy 'never' path (2026-10-02), not written by hand; the HTTP status
// is the one its Ads route maps each kind to.
// ---------------------------------------------------------------------------

const UNCERTAIN_FRIENDLY =
  'Amazon may have already accepted this request. MixShift did not automatically retry it. ' +
  'Check its outcome before submitting it again to avoid creating a duplicate report.';

const GATEWAY_ENVELOPES = {
  uncertain5xx: {
    status: 502,
    body: {
      ok: false,
      kind: 'upstream_unavailable',
      friendly: UNCERTAIN_FRIENDLY,
      message: 'HTTP 503',
      status: 503,
      responsePayload: {},
      automaticRetry: false,
      requestOutcome: 'unknown',
    },
  },
  lostBody: {
    status: 500,
    body: {
      ok: false,
      kind: 'unknown',
      friendly: UNCERTAIN_FRIENDLY,
      message: 'Amazon answered HTTP 207 but the response body was empty or unreadable.',
      status: 207,
      automaticRetry: false,
      requestOutcome: 'unknown',
    },
  },
  concurrency429: {
    status: 429,
    body: {
      ok: false,
      kind: 'throttled',
      friendly:
        'Amazon refused this because too many reports are already running, not because Amazon ' +
        'Ads API requests are arriving too quickly. Waiting and retrying will NOT clear it. Free a ' +
        'slot by deleting a report you no longer need, or wait for one already running to finish, ' +
        'then send this again.',
      message:
        'Received 429 from the Amazon Ads API. Concurrency cap, not a rate cap: back-off does not clear it.',
      concurrencyCap: true,
      automaticRetry: false,
    },
  },
} as const;

const CREATE = { operation: 'reporting_v1.create_report', legacySellerId: 71, body: {} };

describe('adsCall unknown outcomes', () => {
  it.each(['uncertain5xx', 'lostBody'] as const)(
    'passes the service verdict through on %s',
    async (name) => {
      const env = GATEWAY_ENVELOPES[name];
      const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(env.status, env.body));
      const r = await adsCall(CREATE, injected(fetchImpl));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.kind).toBe(env.body.kind);
      expect(r.friendly).toBe(UNCERTAIN_FRIENDLY);
      expect(r.requestOutcome).toBe('unknown');
      expect(r.automaticRetry).toBe(false);
      expect(r.concurrencyCap).toBeUndefined();
    },
  );

  it('keeps a concurrency-cap refusal a refusal (no unknown outcome)', async () => {
    const env = GATEWAY_ENVELOPES.concurrency429;
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(env.status, env.body));
    const r = await adsCall(CREATE, injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('throttled');
    expect(r.concurrencyCap).toBe(true);
    expect(r.automaticRetry).toBe(false);
    expect(r.requestOutcome).toBeUndefined();
    expect(r.friendly).toBe(env.body.friendly);
  });

  const TIMEOUT = () =>
    new DOMException('The operation was aborted due to timeout', 'TimeoutError');

  it('says the outcome is unknown when its own timeout fires, and does not resend', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(TIMEOUT());
    const r = await adsCall(CREATE, injected(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('host_unreachable');
    expect(r.requestOutcome).toBe('unknown');
    expect(r.friendly).toMatch(/may still have gone through/);
    expect(r.friendly).not.toMatch(/unreachable|try again in a minute/i);
  });

  it('treats a real request deadline the same way', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Missing request deadline');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const r = await adsCall(CREATE, { ...injected(fetchImpl as never), timeoutMs: 5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.requestOutcome).toBe('unknown');
  });

  it('treats a socket closed after sending as an unknown outcome', async () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const r = await adsCall(CREATE, injected(vi.fn().mockRejectedValue(err)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.requestOutcome).toBe('unknown');
  });

  it('keeps a connection failure "unreachable": nothing was sent', async () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const r = await adsCall(CREATE, injected(vi.fn().mockRejectedValue(err)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('host_unreachable');
    expect(r.requestOutcome).toBeUndefined();
    expect(r.friendly).toMatch(/unreachable/);
  });

  it.each([
    ['an unparseable body', () => new Response('{"ok":true,"operation":', { status: 200 })],
    ['a proxy page', () => new Response('<html>Welcome</html>', { status: 200 })],
    [
      'our deadline firing mid-read',
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":true,'));
              controller.error(TIMEOUT());
            },
          }),
          { status: 200 },
        ),
    ],
  ])('says the outcome is unknown when a 2xx arrives with %s', async (_label, make) => {
    const r = await adsCall(CREATE, injected(vi.fn().mockResolvedValueOnce(make())));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('unknown');
    expect(r.httpStatus).toBe(200);
    expect(r.requestOutcome).toBe('unknown');
    expect(r.friendly).toMatch(/may still have gone through/);
  });

  it('treats a non-JSON 5xx from the edge as an unknown outcome on a create only', async () => {
    const edge = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const create = await adsCall(CREATE, injected(vi.fn().mockResolvedValueOnce(edge())));
    const read = await adsCall(
      { operation: 'sp.list_campaigns', legacySellerId: 71 },
      injected(vi.fn().mockResolvedValueOnce(edge())),
    );
    expect(create.ok || read.ok).toBe(false);
    if (create.ok || read.ok) return;
    expect(create.requestOutcome).toBe('unknown');
    expect(read.requestOutcome).toBeUndefined();
  });

  // Only a create or a committed write can leave something behind; a read or a
  // dry run keeps the plain "unreachable" wording.
  it.each([
    ['a read', { operation: 'sp.list_campaigns', legacySellerId: 71 }, undefined],
    ['a write dry run', { operation: 'sp.update_keywords', legacySellerId: 71, body: [] }, undefined],
    [
      'a committed write',
      { operation: 'sp.update_keywords', legacySellerId: 71, body: [], dryRun: false },
      'unknown',
    ],
    ['a report create', CREATE, 'unknown'],
  ])('on a timeout, %s has requestOutcome %s', async (_label, input, expected) => {
    const r = await adsCall(input, injected(vi.fn().mockRejectedValue(TIMEOUT())));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.requestOutcome).toBe(expected);
  });

  it('waits 90 s by default, longer than the 60 s the service gives Amazon', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { ok: true, operation: 'x', payload: {} }));
      await adsCall(CREATE, injected(fetchImpl));
      expect(timeout).toHaveBeenCalledWith(90_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('leaves a read-only surface timeout as "unreachable"', async () => {
    const r = await listAdsProfiles(injected(vi.fn().mockRejectedValue(TIMEOUT())));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe('host_unreachable');
    expect(r.requestOutcome).toBeUndefined();
  });
});
