import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  getFeaturedOfferExpectedPriceBatch,
  startFeaturedOfferExpectedPriceBatch,
  getCompetitiveSummaryBatch,
  startCompetitiveSummaryBatch,
  pollPricingRun,
  getPricingRunResult,
  exitCodeForKind as pricingExitCodeForKind,
  isReportFailure,
} from './pricing.js';
import { _refreshState } from '../auth/credentials.js';
import { exitCodeForKind, type ReportClientOptions } from './reports.js';

/**
 * Plugin-side pricing client tests. Verify the HTTP request shapes the client
 * sends to mx-legacy-auth: path, method, Authorization, body. fetch is fully
 * mocked via the fetchImpl injection slot, so no real network and no on-disk
 * credentials needed.
 *
 * Failure-envelope mapping (the 401-retry, host_unreachable classification,
 * etc.) is already covered by reports.test.ts since pricing reuses the same
 * amazonRequest transport; we don't duplicate that here. We do confirm the
 * pricing surface preserves typed failures (ReportFailure) through the path
 * where the service returns a non-success envelope.
 */

beforeEach(() => {
  _refreshState.inFlight = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

// ---------------------------------------------------------------------------
// FOEP sync
// ---------------------------------------------------------------------------

describe('getFeaturedOfferExpectedPriceBatch (sync)', () => {
  it('POSTs to the verbatim path with skus + merchant disambiguators', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-1',
        status: 'DONE',
        itemsTotal: 2,
        itemsCompleted: 1,
        itemsSucceeded: 2,
        itemsFailed: 0,
        completedAt: '2026-06-05T16:00:00Z',
        errorDetail: null,
        operationClass: 'pricing_foep_batch',
        reportType: 'getFeaturedOfferExpectedPriceBatch',
        responses: [{ status: { statusCode: 200 } }, { status: { statusCode: 200 } }],
      }),
    );
    const r = await getFeaturedOfferExpectedPriceBatch(
      {
        skus: ['SKU-1', 'SKU-2'],
        marketplace: 'US',
        legacySellerId: 574,
      },
      injected(fetchImpl),
    );
    expect(isReportFailure(r)).toBe(false);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://svc.test/api/amazon/pricing/get-featured-offer-expected-price-batch',
    );
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      skus: ['SKU-1', 'SKU-2'],
      marketplace: 'US',
      legacySellerId: 574,
    });
  });

  it('coerces legacySellerId string -> number on the wire', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'r',
        status: 'DONE',
        itemsTotal: 1,
        itemsCompleted: 1,
        itemsSucceeded: 1,
        itemsFailed: 0,
        completedAt: '',
        errorDetail: null,
        operationClass: 'pricing_foep_batch',
        reportType: 'getFeaturedOfferExpectedPriceBatch',
        responses: [],
      }),
    );
    await getFeaturedOfferExpectedPriceBatch(
      { skus: ['SKU-1'], legacySellerId: '574' },
      injected(fetchImpl),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.legacySellerId).toBe(574);
  });

  it('returns the typed envelope from the service', async () => {
    const payload = {
      ok: true,
      runId: 'run-1',
      status: 'DONE',
      itemsTotal: 1,
      itemsCompleted: 1,
      itemsSucceeded: 1,
      itemsFailed: 0,
      completedAt: 't',
      errorDetail: null,
      operationClass: 'pricing_foep_batch',
      reportType: 'getFeaturedOfferExpectedPriceBatch',
      responses: [{ status: { statusCode: 200 }, body: { offerIdentifier: { sellerId: 'A1' } } }],
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, payload));
    const r = await getFeaturedOfferExpectedPriceBatch(
      { skus: ['SKU-1'] },
      injected(fetchImpl),
    );
    if (!isReportFailure(r)) {
      expect(r.runId).toBe('run-1');
      expect(r.responses).toHaveLength(1);
    }
  });

  it('propagates a typed failure envelope (reauth_required)', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(409, {
        ok: false,
        kind: 'reauth_required',
        friendly: 'Auth lapsed',
        amazonSellerId: 'A1',
      }),
    );
    const r = await getFeaturedOfferExpectedPriceBatch(
      { skus: ['SKU-1'] },
      injected(fetchImpl),
    );
    expect(isReportFailure(r)).toBe(true);
    if (isReportFailure(r)) {
      expect(r.kind).toBe('reauth_required');
      expect(r.amazonSellerId).toBe('A1');
    }
  });
});

// ---------------------------------------------------------------------------
// FOEP async start
// ---------------------------------------------------------------------------

describe('startFeaturedOfferExpectedPriceBatch (async)', () => {
  it('POSTs to the /start path and returns the runId', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-9',
        status: 'IN_QUEUE',
        itemsTotal: 500,
      }),
    );
    const r = await startFeaturedOfferExpectedPriceBatch(
      { skus: Array.from({ length: 500 }, (_, i) => `S${i}`) },
      injected(fetchImpl),
    );
    expect(isReportFailure(r)).toBe(false);
    if (!isReportFailure(r)) {
      expect(r.runId).toBe('run-9');
      expect(r.status).toBe('IN_QUEUE');
    }
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/pricing/get-featured-offer-expected-price-batch/start',
    );
  });
});

// ---------------------------------------------------------------------------
// CompetitiveSummary
// ---------------------------------------------------------------------------

describe('getCompetitiveSummaryBatch (sync)', () => {
  it('POSTs to the CS path with asins + includedData', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-cs',
        status: 'DONE',
        itemsTotal: 1,
        itemsCompleted: 1,
        itemsSucceeded: 1,
        itemsFailed: 0,
        completedAt: 't',
        errorDetail: null,
        operationClass: 'pricing_competitive_summary_batch',
        reportType: 'getCompetitiveSummary',
        responses: [{ status: { statusCode: 200 } }],
      }),
    );
    await getCompetitiveSummaryBatch(
      {
        asins: ['B0001'],
        marketplace: 'US',
        includedData: ['lowestPricedOffers'],
      },
      injected(fetchImpl),
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/pricing/get-competitive-summary-batch');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      asins: ['B0001'],
      marketplace: 'US',
      includedData: ['lowestPricedOffers'],
    });
  });

  it('omits includedData when caller did not pass any', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-cs',
        status: 'DONE',
        itemsTotal: 1,
        itemsCompleted: 1,
        itemsSucceeded: 1,
        itemsFailed: 0,
        completedAt: 't',
        errorDetail: null,
        operationClass: 'pricing_competitive_summary_batch',
        reportType: 'getCompetitiveSummary',
        responses: [],
      }),
    );
    await getCompetitiveSummaryBatch({ asins: ['B0001'] }, injected(fetchImpl));
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect('includedData' in body).toBe(false);
  });
});

describe('startCompetitiveSummaryBatch (async)', () => {
  it('hits the /start path', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-cs-async',
        status: 'IN_QUEUE',
        itemsTotal: 300,
      }),
    );
    await startCompetitiveSummaryBatch(
      { asins: Array.from({ length: 300 }, (_, i) => `B${i.toString().padStart(4, '0')}`) },
      injected(fetchImpl),
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/pricing/get-competitive-summary-batch/start',
    );
  });
});

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

describe('pollPricingRun + getPricingRunResult', () => {
  it('pollPricingRun GETs /runs/:id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-1',
        status: 'IN_PROGRESS',
        itemsTotal: 100,
        itemsCompleted: 2,
        itemsSucceeded: 70,
        itemsFailed: 5,
        completedAt: null,
        errorDetail: null,
        operationClass: 'pricing_foep_batch',
        reportType: 'getFeaturedOfferExpectedPriceBatch',
      }),
    );
    const r = await pollPricingRun('run-1', injected(fetchImpl));
    expect(isReportFailure(r)).toBe(false);
    if (!isReportFailure(r)) {
      expect(r.status).toBe('IN_PROGRESS');
      expect(r.itemsCompleted).toBe(2);
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/pricing/runs/run-1');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('getPricingRunResult GETs /runs/:id/result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        runId: 'run-1',
        status: 'DONE',
        itemsTotal: 2,
        itemsCompleted: 1,
        itemsSucceeded: 2,
        itemsFailed: 0,
        completedAt: 't',
        errorDetail: null,
        operationClass: 'pricing_foep_batch',
        reportType: 'getFeaturedOfferExpectedPriceBatch',
        responses: [{ status: { statusCode: 200 } }, { status: { statusCode: 200 } }],
      }),
    );
    const r = await getPricingRunResult('run-1', injected(fetchImpl));
    expect(isReportFailure(r)).toBe(false);
    if (!isReportFailure(r)) {
      expect(r.responses).toHaveLength(2);
    }
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/pricing/runs/run-1/result',
    );
  });
});

// ---------------------------------------------------------------------------
// Exit-code contract
// ---------------------------------------------------------------------------

describe('exit codes', () => {
  it('shares the one exitCodeForKind with the report surface (no drift)', () => {
    // 0.5.18 shipped a second, divergent kind→code mapping on this surface.
    // The mapping is a documented contract in mx-report-pull, so pricing must
    // re-export the report one, not define its own.
    expect(pricingExitCodeForKind).toBe(exitCodeForKind);
  });
});
