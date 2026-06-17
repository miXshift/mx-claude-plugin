import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  listMerchants,
  startReport,
  pollReport,
  getReportDocument,
  getReportDocumentMeta,
  streamReportDocumentToFile,
  exitCodeForKind,
  type ReportClientOptions,
  type ReportFailureKind,
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

// The presigned-URL fetch returns raw bytes (not JSON). Used to mock the
// second hop in getReportDocument: the direct S3 download.
function bytesResponse(status: number, body: Buffer | Uint8Array): Response {
  return new Response(body, { status });
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

  it('passes through the disambiguation fields when the service sends them', async () => {
    // One amazonSellerId fans out per marketplace; legacySellerId is the exact
    // per-marketplace record id and the deterministic disambiguator. The list is
    // pre-gated to SP-API-active rows, so there is no separate active flag, and
    // authorized is meaningful (false == grant lapsed). The client must carry
    // legacySellerId / marketplaceId / countryCode / marketplaceName untouched.
    const merchant = {
      amazonSellerId: 'A1F8PIDV939RA2',
      name: 'Summit Labs',
      merchantType: 'Seller' as const,
      merchantRegion: 'NA',
      marketplaceId: 'ATVPDKIKX0DER',
      marketplaceName: 'United States',
      countryCode: 'US',
      legacySellerId: 71,
      authorized: false,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, merchants: [merchant] }));
    const r = await listMerchants(injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.merchants[0]).toMatchObject({
        legacySellerId: 71,
        marketplaceId: 'ATVPDKIKX0DER',
        marketplaceName: 'United States',
        countryCode: 'US',
        authorized: false,
      });
    }
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
    // legacySellerId is only sent when provided.
    expect('legacySellerId' in body).toBe(false);
  });

  it('forwards legacySellerId on the wire when provided', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, runId: 'run-uuid' }));
    const r = await startReport(
      {
        amazonSellerId: 'A1F8PIDV939RA2',
        legacySellerId: 71,
        reportType: 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL',
        marketplace: 'US',
      },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    // legacySellerId pins attribution to the exact per-marketplace record so the
    // service does not re-resolve a shared sellerId to the wrong marketplace.
    expect(body).toMatchObject({
      sellerId: 'A1F8PIDV939RA2',
      legacySellerId: 71,
      marketplace: 'US',
    });
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

  it('fetches the presigned URL itself and returns the decoded (uncompressed) document', async () => {
    const tsv = 'order-id\tdate\n123\t2026-05-01\n';
    const fetchImpl = vi
      .fn()
      // 1) metadata call -> service hands back a presigned URL, never bytes.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          ready: true,
          status: 'DONE',
          document: {
            reportDocumentId: 'doc-1',
            url: 'https://s3.amazonaws.com/report?sig=abc',
            compressionAlgorithm: null,
          },
        }),
      )
      // 2) the direct S3 download -> raw bytes.
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from(tsv, 'utf8')));

    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(true);
      expect(r.document).toBe(tsv);
      expect(r.bytes).toBe(Buffer.byteLength(tsv));
      expect(r.reportDocumentId).toBe('doc-1');
    }

    // The S3 hop hit the presigned URL with NO Authorization header (a Bearer
    // would make S3 reject the presigned request).
    const [docUrl, docInit] = fetchImpl.mock.calls[1];
    expect(docUrl).toBe('https://s3.amazonaws.com/report?sig=abc');
    const headers = ((docInit as RequestInit | undefined)?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it('gunzips the document when compressionAlgorithm is GZIP', async () => {
    const tsv = 'sku\tunits\nABC\t42\n';
    const gz = gzipSync(Buffer.from(tsv, 'utf8'));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          ready: true,
          status: 'DONE',
          document: {
            reportDocumentId: 'doc-2',
            url: 'https://s3.amazonaws.com/report.gz?sig=xyz',
            compressionAlgorithm: 'GZIP',
          },
        }),
      )
      .mockResolvedValueOnce(bytesResponse(200, gz));

    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(true);
      expect(r.document).toBe(tsv);
      expect(r.compressionAlgorithm).toBe('GZIP');
    }
  });

  it('surfaces an expired presigned link (403) as a friendly re-fetch failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          ready: true,
          status: 'DONE',
          document: {
            url: 'https://s3.amazonaws.com/report?sig=expired',
            compressionAlgorithm: null,
          },
        }),
      )
      .mockResolvedValueOnce(bytesResponse(403, Buffer.from('AccessDenied')));

    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(403);
      expect(r.friendly).toMatch(/expired/i);
    }
  });

  it('fails cleanly (not a crash) when the inline document exceeds the cap, pointing at --out', async () => {
    // A document larger than the inline cap must NOT be materialized as a
    // string (that is the V8 kMaxInt crash). getReportDocument caps the read
    // and returns a friendly "use --out" failure instead. 26 MB clears the
    // 25 MB cap.
    const huge = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          ready: true,
          status: 'DONE',
          document: {
            url: 'https://s3.amazonaws.com/big?sig=abc',
            compressionAlgorithm: null,
          },
        }),
      )
      .mockResolvedValueOnce(bytesResponse(200, huge));

    const r = await getReportDocument('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('unknown');
      expect(r.friendly).toMatch(/--out/);
    }
  });
});

// ---------------------------------------------------------------------------
// getReportDocumentMeta: readiness + presigned URL, WITHOUT downloading bytes
// ---------------------------------------------------------------------------

describe('getReportDocumentMeta', () => {
  it('returns the document descriptor and does NOT fetch the bytes', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        ready: true,
        status: 'DONE',
        document: {
          reportDocumentId: 'doc-meta',
          url: 'https://s3.amazonaws.com/report?sig=meta',
          compressionAlgorithm: 'GZIP',
        },
      }),
    );
    const r = await getReportDocumentMeta('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(true);
      expect(r.document).toMatchObject({
        reportDocumentId: 'doc-meta',
        url: 'https://s3.amazonaws.com/report?sig=meta',
        compressionAlgorithm: 'GZIP',
      });
    }
    // Only the metadata call, never the presigned S3 download.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns ready:false with no document when called early', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, ready: false, status: 'IN_PROGRESS' }));
    const r = await getReportDocumentMeta('run-uuid', injected(fetchImpl));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ready).toBe(false);
      expect(r.document).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// streamReportDocumentToFile: pipe the presigned body to disk (any size)
// ---------------------------------------------------------------------------

describe('streamReportDocumentToFile', () => {
  it('streams an uncompressed document to a file and reports bytes', async () => {
    const tsv = 'order-id\tdate\n123\t2026-05-01\n';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from(tsv, 'utf8')));
    const outPath = join(testDir, 'nested', 'report.tsv');

    const r = await streamReportDocumentToFile(
      {
        reportDocumentId: 'doc-1',
        url: 'https://s3.amazonaws.com/report?sig=abc',
        compressionAlgorithm: null,
      },
      outPath,
      { fetchImpl },
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes).toBe(Buffer.byteLength(tsv));
      expect(r.reportDocumentId).toBe('doc-1');
    }
    // The bytes actually landed on disk (parent dir was created).
    expect(await readFile(outPath, 'utf8')).toBe(tsv);

    // Presigned fetch carried NO Authorization header.
    const [, init] = fetchImpl.mock.calls[0];
    const headers = ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('gunzips a GZIP document while streaming to disk', async () => {
    const tsv = 'sku\tunits\nABC\t42\n';
    const gz = gzipSync(Buffer.from(tsv, 'utf8'));
    const fetchImpl = vi.fn().mockResolvedValueOnce(bytesResponse(200, gz));
    const outPath = join(testDir, 'report.gz.tsv');

    const r = await streamReportDocumentToFile(
      {
        url: 'https://s3.amazonaws.com/report.gz?sig=xyz',
        compressionAlgorithm: 'GZIP',
      },
      outPath,
      { fetchImpl },
    );

    expect(r.ok).toBe(true);
    // File holds the DECOMPRESSED bytes.
    expect(await readFile(outPath, 'utf8')).toBe(tsv);
  });

  it('surfaces an expired presigned link (403) as a friendly re-fetch failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(403, Buffer.from('AccessDenied')));
    const outPath = join(testDir, 'never-written.tsv');

    const r = await streamReportDocumentToFile(
      { url: 'https://s3.amazonaws.com/report?sig=expired', compressionAlgorithm: null },
      outPath,
      { fetchImpl },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(403);
      expect(r.friendly).toMatch(/expired/i);
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

  it('maps merchant_not_found (404) + carries the marketplace candidates', async () => {
    // A shared amazonSellerId fans out per marketplace. When the caller did not
    // pin one, the service answers 404 with one candidate per marketplace, each
    // carrying its deterministic legacySellerId for an exact re-run.
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(404, {
        ok: false,
        kind: 'merchant_not_found',
        friendly: 'This seller trades in several marketplaces.',
        candidates: [
          {
            legacySellerId: 71,
            amazonSellerId: 'A1F8PIDV939RA2',
            marketplaceId: 'ATVPDKIKX0DER',
            marketplaceName: 'United States',
            name: 'Summit Labs',
          },
          {
            legacySellerId: 419,
            amazonSellerId: 'A1F8PIDV939RA2',
            marketplaceId: 'A2Q3Y263D00KWC',
            marketplaceName: 'Brazil',
            name: 'Summit Labs',
          },
        ],
      }),
    );
    const r = await startReport(
      { amazonSellerId: 'A1F8PIDV939RA2', reportType: 'GET_X' },
      injected(fetchImpl),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('merchant_not_found');
      expect(r.candidates).toHaveLength(2);
      expect(r.candidates?.[0]).toMatchObject({
        legacySellerId: 71,
        marketplaceName: 'United States',
      });
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

// ---------------------------------------------------------------------------
// exitCodeForKind — the kind → exit-code contract shared by every surface
// that emits ReportFailure, documented in the mx-amazon-report failure table
// ---------------------------------------------------------------------------

describe('exitCodeForKind', () => {
  it('maps every kind to the exit code documented in the skill failure table', () => {
    // A full Record so adding a ReportFailureKind without deciding its exit
    // code fails to compile.
    const documented: Record<ReportFailureKind, number> = {
      not_authenticated: 2,
      session_expired: 2,
      restricted_report: 4,
      reauth_required: 5,
      spapi_not_configured: 6,
      ads_not_configured: 6,
      merchant_not_found: 7,
      throttled: 8,
      report_fatal: 9,
      insufficient_scope: 11,
      host_unreachable: 1,
      unknown: 1,
    };
    for (const [kind, code] of Object.entries(documented)) {
      expect(exitCodeForKind(kind as ReportFailureKind)).toBe(code);
    }
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
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}
