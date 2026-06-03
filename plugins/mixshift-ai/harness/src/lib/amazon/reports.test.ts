import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listMerchants,
  startReport,
  pollReport,
  getReportDocument,
  type ReportClientOptions,
} from './reports.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-reports-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

// Inject api_base + token + fetch so the bulk of the suite never touches disk.
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
// listMerchants
// ---------------------------------------------------------------------------

describe('listMerchants', () => {
  it('returns merchants from { merchants: [...] }', async () => {
    const merchant = {
      amazonSellerId: 'A123',
      name: 'Acme',
      merchantType: 'Seller' as const,
      merchantRegion: 'NA',
      marketplaceId: 'ATVPDKIKX0DER',
      authorized: true,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, merchants: [merchant] }));
    const r = await listMerchants(injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.merchants).toEqual([merchant]);

    // Sent a Bearer + hit the right path.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/merchants');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
    });
  });

  it('tolerates a bare array response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [{ amazonSellerId: 'A1' }]));
    const r = await listMerchants(injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.merchants).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// startReport
// ---------------------------------------------------------------------------

describe('startReport', () => {
  it('returns a runId and forwards the wire-shape request body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, runId: 'run-uuid', status: 'IN_QUEUE' }));
    const r = await startReport(
      {
        amazonSellerId: 'A123',
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        start: '2026-05-01',
        end: '2026-05-31',
        marketplace: 'US',
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.runId).toBe('run-uuid');
      expect(r.status).toBe('IN_QUEUE');
    }
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://svc.test/api/amazon/reports');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    // Wire shape per the service handoff doc: amazonSellerId -> sellerId,
    // start/end (not dataStartTime/dataEndTime), single marketplace string.
    expect(body).toMatchObject({
      sellerId: 'A123',
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      start: '2026-05-01',
      end: '2026-05-31',
      marketplace: 'US',
    });
    // Lock the rename: the old field names must NOT leak onto the wire.
    expect(body.amazonSellerId).toBeUndefined();
    expect(body.dataStartTime).toBeUndefined();
    expect(body.dataEndTime).toBeUndefined();
    expect(body.marketplaceIds).toBeUndefined();
  });

  it('omits sellerId when amazonSellerId is absent (single-merchant inference)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, runId: 'run-uuid' }));
    const r = await startReport(
      { reportType: 'GET_SALES_AND_TRAFFIC_REPORT' },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ reportType: 'GET_SALES_AND_TRAFFIC_REPORT' });
    expect('sellerId' in body).toBe(false);
  });

  it('classifies a missing runId as unknown', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const r = await startReport(
      { amazonSellerId: 'A1', reportType: 'GET_X' },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// pollReport
// ---------------------------------------------------------------------------

describe('pollReport', () => {
  it('passes ready + status through', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ready: false, status: 'IN_PROGRESS' }));
    const r = await pollReport('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(false);
      expect(r.status).toBe('IN_PROGRESS');
    }
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://svc.test/api/amazon/reports/run-uuid',
    );
  });
});

// ---------------------------------------------------------------------------
// getReportDocument
// ---------------------------------------------------------------------------

describe('getReportDocument', () => {
  it('returns ready:false (NOT an error) when called early', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ready: false, status: 'IN_PROGRESS' }));
    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(false);
      expect(r.document).toBeUndefined();
    }
  });

  it('returns the document bytes from the `tsv` field + rowCountEstimate when ready', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        ready: true,
        status: 'DONE',
        tsv: 'order-id\tdate\n123\t2026-05-01\n',
        rowCountEstimate: 1,
      }),
    );
    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(true);
      expect(r.document).toContain('order-id\tdate');
      expect(r.rowCountEstimate).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure-envelope mapping (branch on kind, carry extras)
// ---------------------------------------------------------------------------

describe('failure envelope mapping', () => {
  it('maps restricted_report (403) + carries reportType', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(403, {
        ok: false,
        kind: 'restricted_report',
        reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
        friendly: 'Amazon rejected this as restricted.',
      }),
    );
    const r = await startReport(
      { amazonSellerId: 'A1', reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE' },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('restricted_report');
      expect(r.reportType).toBe('GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE');
      expect(r.httpStatus).toBe(403);
    }
  });

  it('maps reauth_required (409) + carries amazonSellerId', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(409, {
        ok: false,
        kind: 'reauth_required',
        amazonSellerId: 'A999',
      }),
    );
    const r = await pollReport('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('reauth_required');
      expect(r.amazonSellerId).toBe('A999');
      // Server omitted friendly -> client fills a default.
      expect(r.friendly).toMatch(/re-authorized/i);
    }
  });

  it('maps throttled (429) + carries retryAfterMs', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(429, { ok: false, kind: 'throttled', retryAfterMs: 5000 }),
    );
    const r = await pollReport('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('throttled');
      expect(r.retryAfterMs).toBe(5000);
    }
  });

  it('falls back to a status-derived kind on a non-JSON body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 503 }));
    const r = await listMerchants(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('spapi_not_configured');
  });

  it('classifies network failures as host_unreachable', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND svc.test'), {
          code: 'ENOTFOUND',
        }),
      );
    const r = await listMerchants(injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('host_unreachable');
  });
});

// ---------------------------------------------------------------------------
// 401 → force-refresh → retry (token-provider injection)
// ---------------------------------------------------------------------------

describe('401 retry', () => {
  it('force-refreshes the token and retries once', async () => {
    const tokenProvider = async (force?: boolean) => (force ? 'fresh' : 'stale');
    let calls = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      calls++;
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer stale') return jsonResponse(401, { ok: false });
      return jsonResponse(200, { ok: true, merchants: [] });
    });
    const r = await listMerchants(injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('returns session_expired when the forced refresh throws', async () => {
    const tokenProvider = async (force?: boolean) => {
      if (force) throw new Error('Your MixShift session expired');
      return 'stale';
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(401, { ok: false }));
    const r = await listMerchants(injected(fetchImpl, tokenProvider));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('session_expired');
  });
});

// ---------------------------------------------------------------------------
// Disk-backed creds path (exercises resolveBaseAndToken + getValidAccessToken)
// ---------------------------------------------------------------------------

describe('credential resolution from disk', () => {
  it('returns not_authenticated when no datahub creds exist', async () => {
    const r = await listMerchants({ dataDirOverride: testDir });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('not_authenticated');
  });

  it('uses api_base + access_token from disk creds', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, merchants: [] }));
    const r = await listMerchants({ dataDirOverride: testDir, fetchImpl });
    expect(r.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://mcp.mixshift.io/api/amazon/merchants');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer eyJfresh.token',
    });
  });
});

function freshDatahubFixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@dashapplications.com',
    person_label: 'sam.hager@mixshift.io',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}
