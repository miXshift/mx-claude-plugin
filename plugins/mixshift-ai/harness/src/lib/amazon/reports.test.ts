import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
  throttleBackoffMs,
  chunkAsinList,
  mergeSqpDocuments,
  SQP_ASIN_OPTION_CHAR_LIMIT,
  THROTTLE_BACKOFF_CAP_MS,
  THROTTLE_BACKOFF_FLOOR_MS,
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

  // -------------------------------------------------------------------------
  // Reliability v2: stall/timeout + retry + real error_class (never `unknown`)
  // -------------------------------------------------------------------------

  const noSleep = async (): Promise<void> => {};

  /** A presigned response whose body yields `chunk` then ERRORS mid-stream —
   *  simulates a dropped connection while downloading. */
  function erroringBody(chunk: Buffer): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(chunk));
        controller.error(new Error('ECONNRESET mid-stream'));
      },
    });
    return new Response(body, { status: 200 });
  }

  const doc = (sig: string) => ({
    url: `https://s3.amazonaws.com/report?sig=${sig}`,
    compressionAlgorithm: null,
  });

  it('retries a transient network error, then succeeds', async () => {
    const tsv = 'a\tb\n1\t2\n';
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from(tsv, 'utf8')));
    const outPath = join(testDir, 'retry-net.tsv');

    const r = await streamReportDocumentToFile(doc('a'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readFile(outPath, 'utf8')).toBe(tsv);
  });

  it('retries a 5xx presigned response, then succeeds', async () => {
    const tsv = 'sku\tunits\nABC\t42\n';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(503, Buffer.from('slow down')))
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from(tsv, 'utf8')));
    const outPath = join(testDir, 'retry-5xx.tsv');

    const r = await streamReportDocumentToFile(doc('b'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readFile(outPath, 'utf8')).toBe(tsv);
  });

  it('recovers from a mid-stream drop on retry', async () => {
    const tsv = 'x\ty\n9\t9\n';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(erroringBody(Buffer.from('partial')))
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from(tsv, 'utf8')));
    const outPath = join(testDir, 'retry-midstream.tsv');

    const r = await streamReportDocumentToFile(doc('c'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The retry overwrote the truncated first attempt with the full document.
    expect(await readFile(outPath, 'utf8')).toBe(tsv);
  });

  it('gives up after maxDownloadAttempts with a real download_failed class (never unknown)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const sleep = vi.fn(noSleep);
    const outPath = join(testDir, 'give-up.tsv');

    const r = await streamReportDocumentToFile(doc('d'), outPath, {
      fetchImpl,
      sleepImpl: sleep,
      maxDownloadAttempts: 3,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('download_failed');
      expect(r.kind).not.toBe('unknown');
      expect(r.message).toMatch(/3 attempt/);
      expect(r.friendly).toMatch(/still ready/i);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // backoff between attempts, not after the last
  });

  it('does NOT retry an expired presigned link (410) and surfaces it at once', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(bytesResponse(410, Buffer.from('Gone')))
      .mockResolvedValueOnce(bytesResponse(200, Buffer.from('should-not-be-used', 'utf8')));
    const outPath = join(testDir, 'expired.tsv');

    const r = await streamReportDocumentToFile(doc('e'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(410);
      expect(r.friendly).toMatch(/expired/i);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry against the same URL
  });

  it('honors maxDownloadAttempts:1 (no retry)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const outPath = join(testDir, 'single.tsv');

    const r = await streamReportDocumentToFile(doc('f'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
      maxDownloadAttempts: 1,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('download_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('salvages a truncated download to <path>.partial after exhausting retries', async () => {
    // Fresh Response per call: a ReadableStream body can only be consumed once.
    const fetchImpl = vi.fn(async () => erroringBody(Buffer.from('partial-bytes')));
    const outPath = join(testDir, 'trunc.tsv');

    const r = await streamReportDocumentToFile(doc('g'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
      maxDownloadAttempts: 2,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('download_failed');
    // The truncated file is NOT left where a consumer would read it as complete.
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
    // It was renamed to .partial (best-effort salvage).
    const partial = await readFile(`${outPath}.partial`, 'utf8').catch(() => null);
    expect(partial).not.toBeNull();
  });

  it('classifies a mkdir/open failure as download_failed instead of throwing out of the loop', async () => {
    // Put a FILE where the output directory needs to be, so mkdir(dirname)
    // fails (ENOTDIR/EEXIST). The fetch itself succeeds; the failure is purely
    // in creating the destination — which must still be classified + retried,
    // not thrown as a raw error past the retry loop (the red-team gap).
    const blocker = join(testDir, 'blocker');
    await writeFile(blocker, 'x');
    const outPath = join(blocker, 'sub', 'report.tsv');
    const fetchImpl = vi.fn(async () => bytesResponse(200, Buffer.from('data', 'utf8')));

    const r = await streamReportDocumentToFile(doc('h'), outPath, {
      fetchImpl,
      sleepImpl: noSleep,
      maxDownloadAttempts: 2,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('download_failed'); // classified, not a bare thrown error
      expect(r.kind).not.toBe('unknown');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2); // went through the retry loop
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
      // Amazon rejected the request itself. Terminal and caller-fixable, so it
      // gets its own code rather than the generic 1 -- a script can branch on
      // "stop and fix the request" without parsing text.
      bad_request: 12,
      host_unreachable: 1,
      download_failed: 1,
      unknown: 1,
    };
    for (const [kind, code] of Object.entries(documented)) {
      expect(exitCodeForKind(kind as ReportFailureKind)).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// throttleBackoffMs — the poll-loop backoff after a 429, so a `report run`
// rides out a transient Amazon rate-limit instead of failing on the first one
// ---------------------------------------------------------------------------

describe('throttleBackoffMs', () => {
  const INTERVAL = 5000;
  const DEADLINE = 300_000; // `now` is passed explicitly; 0..DEADLINE is the window

  it('honors a server retry-after in full (bounded only by the deadline)', () => {
    expect(throttleBackoffMs(12_000, INTERVAL, 1, 0, DEADLINE)).toBe(12_000);
    // Larger than the exponential cap, but still honored — Amazon told us.
    expect(throttleBackoffMs(60_000, INTERVAL, 1, 0, DEADLINE)).toBe(60_000);
  });

  it('floors a small retry-after at the base interval', () => {
    expect(throttleBackoffMs(1000, INTERVAL, 1, 0, DEADLINE)).toBe(INTERVAL);
  });

  it('falls back to exponential backoff off the interval when no retry-after', () => {
    expect(throttleBackoffMs(undefined, INTERVAL, 1, 0, DEADLINE)).toBe(5000);
    expect(throttleBackoffMs(undefined, INTERVAL, 2, 0, DEADLINE)).toBe(10_000);
    expect(throttleBackoffMs(undefined, INTERVAL, 3, 0, DEADLINE)).toBe(20_000);
  });

  it('caps the exponential fallback at THROTTLE_BACKOFF_CAP_MS', () => {
    // Streak 4 would be 40s off a 5s interval; capped to 30s.
    expect(throttleBackoffMs(undefined, INTERVAL, 4, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_CAP_MS);
    expect(throttleBackoffMs(undefined, INTERVAL, 50, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_CAP_MS);
  });

  it('treats a retry-after of 0/undefined as absent', () => {
    expect(throttleBackoffMs(0, INTERVAL, 1, 0, DEADLINE)).toBe(5000);
  });

  it('never waits past the deadline', () => {
    // Retry-after wants 12s but only 4s remain.
    expect(throttleBackoffMs(12_000, INTERVAL, 1, 296_000, DEADLINE)).toBe(4000);
  });

  it('returns 0 once the deadline has passed so the caller stops', () => {
    expect(throttleBackoffMs(5000, INTERVAL, 1, DEADLINE, DEADLINE)).toBe(0);
    expect(throttleBackoffMs(5000, INTERVAL, 1, DEADLINE + 1, DEADLINE)).toBe(0);
  });
});

// Adversarial / degenerate inputs — hardening surfaced by the red-team pass:
// a 0ms interval must not make the helper return 0 (which the caller reads as
// "give up"), and NaN/negative inputs must not leak through as NaN.
describe('throttleBackoffMs — adversarial / degenerate inputs', () => {
  const DEADLINE = 300_000;

  it('floors a zero interval so a 429 still backs off instead of giving up', () => {
    expect(throttleBackoffMs(undefined, 0, 1, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_FLOOR_MS);
    // exponential still applies, off the floored interval
    expect(throttleBackoffMs(undefined, 0, 3, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_FLOOR_MS * 4);
  });

  it('treats NaN / negative retry-after as absent (falls back to interval backoff)', () => {
    expect(throttleBackoffMs(Number.NaN, 5000, 1, 0, DEADLINE)).toBe(5000);
    expect(throttleBackoffMs(-1000, 5000, 1, 0, DEADLINE)).toBe(5000);
  });

  it('handles a NaN / negative interval via the floor', () => {
    expect(throttleBackoffMs(undefined, Number.NaN, 1, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_FLOOR_MS);
    expect(throttleBackoffMs(undefined, -5000, 1, 0, DEADLINE)).toBe(THROTTLE_BACKOFF_FLOOR_MS);
  });

  it('clamps a streak of 0 or negative to the first backoff step', () => {
    expect(throttleBackoffMs(undefined, 5000, 0, 0, DEADLINE)).toBe(5000);
    expect(throttleBackoffMs(undefined, 5000, -3, 0, DEADLINE)).toBe(5000);
  });

  it('honors a huge retry-after only up to the remaining time (no deadline overrun)', () => {
    expect(throttleBackoffMs(999_999, 5000, 1, 0, DEADLINE)).toBe(DEADLINE);
  });

  it('always returns a finite positive wait while time remains', () => {
    for (const ra of [undefined, 0, -1, Number.NaN, 250, 999_999]) {
      for (const streak of [0, 1, 5, 50]) {
        const v = throttleBackoffMs(ra, 0, streak, 0, DEADLINE);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(DEADLINE);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// chunkAsinList — splits a long ASIN list into <=200-char reportOptions.asin
// chunks for the SQP auto-batch path in `report run`
// ---------------------------------------------------------------------------

describe('chunkAsinList', () => {
  it('returns a single chunk when the whole list fits', () => {
    const r = chunkAsinList('B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC');
    expect(r.asins).toEqual(['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC']);
    expect(r.chunks).toEqual(['B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC']);
  });

  it('returns { asins: [], chunks: [] } on blank/empty input', () => {
    expect(chunkAsinList('')).toEqual({ asins: [], chunks: [] });
    expect(chunkAsinList('   ')).toEqual({ asins: [], chunks: [] });
    expect(chunkAsinList('\n\t  \n')).toEqual({ asins: [], chunks: [] });
  });

  it('splits on any run of whitespace, not just single spaces', () => {
    const r = chunkAsinList('B0AAAAAAAA\tB0BBBBBBBB\n\nB0CCCCCCCC   B0DDDDDDDD');
    expect(r.asins).toEqual(['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC', 'B0DDDDDDDD']);
    expect(r.chunks).toEqual(['B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC B0DDDDDDDD']);
  });

  it('dedupes repeated ASINs, preserving first-seen order', () => {
    const r = chunkAsinList('B0AAAAAAAA B0BBBBBBBB B0AAAAAAAA B0CCCCCCCC B0BBBBBBBB');
    expect(r.asins).toEqual(['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC']);
    expect(r.chunks).toEqual(['B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC']);
  });

  it('packs greedily up to the char limit, splitting into a new chunk once a token would overflow', () => {
    // 10-char ASINs joined by single spaces: charLimit 21 fits exactly 2 per
    // chunk (10 + 1 + 10 = 21), so a 5-ASIN list packs 2/2/1.
    const asins = ['B0AAAAAAAA', 'B0BBBBBBBB', 'B0CCCCCCCC', 'B0DDDDDDDD', 'B0EEEEEEEE'];
    const r = chunkAsinList(asins.join(' '), 21);
    expect(r.chunks).toEqual([
      'B0AAAAAAAA B0BBBBBBBB',
      'B0CCCCCCCC B0DDDDDDDD',
      'B0EEEEEEEE',
    ]);
  });

  it('respects an exact-boundary chunk (candidate length == charLimit stays in the chunk)', () => {
    // 10 + 1 + 10 = 21 exactly; charLimit 21 must keep both in one chunk.
    const r = chunkAsinList('B0AAAAAAAA B0BBBBBBBB', 21);
    expect(r.chunks).toEqual(['B0AAAAAAAA B0BBBBBBBB']);
    // One char less (20) cannot fit both -> two chunks.
    const r2 = chunkAsinList('B0AAAAAAAA B0BBBBBBBB', 20);
    expect(r2.chunks).toEqual(['B0AAAAAAAA', 'B0BBBBBBBB']);
  });

  it('every produced chunk is at or under the char limit', () => {
    const asins = Array.from({ length: 40 }, (_, i) => `B0${String(i).padStart(8, '0')}`);
    const r = chunkAsinList(asins.join(' '), SQP_ASIN_OPTION_CHAR_LIMIT);
    expect(r.asins).toHaveLength(40);
    for (const chunk of r.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SQP_ASIN_OPTION_CHAR_LIMIT);
    }
    // Round-trips back to the full deduped ASIN set with nothing dropped.
    expect(r.chunks.join(' ').split(' ').sort()).toEqual([...r.asins].sort());
  });

  it('throws on a single token longer than the char limit (cannot be a valid ASIN)', () => {
    expect(() => chunkAsinList('B0AAAAAAAA B0' + 'X'.repeat(250), 200)).toThrow(/characters/);
  });

  it('uses the default SQP_ASIN_OPTION_CHAR_LIMIT (200) when no limit is passed', () => {
    const asins = Array.from({ length: 20 }, (_, i) => `B0${String(i).padStart(8, '0')}`);
    const r = chunkAsinList(asins.join(' '));
    for (const chunk of r.chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });
});

// ---------------------------------------------------------------------------
// mergeSqpDocuments — recombines N chunked SQP report documents into the
// single { reportSpecification, dataByAsin[] } shape Amazon's own schema
// (sellingPartnerSearchQueryPerformanceReport.json) defines
// ---------------------------------------------------------------------------

describe('mergeSqpDocuments', () => {
  function doc(rows: unknown[], asinOption?: string): string {
    return JSON.stringify({
      reportSpecification: {
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        reportOptions: { reportPeriod: 'WEEK', ...(asinOption !== undefined ? { asin: asinOption } : {}) },
      },
      dataByAsin: rows,
    });
  }

  it('concatenates dataByAsin across chunks in order', () => {
    const d1 = doc([{ asin: 'B0AAAAAAAA', n: 1 }], 'B0AAAAAAAA');
    const d2 = doc([{ asin: 'B0BBBBBBBB', n: 2 }, { asin: 'B0BBBBBBBB', n: 3 }], 'B0BBBBBBBB');
    const merged = JSON.parse(mergeSqpDocuments([d1, d2], 'B0AAAAAAAA B0BBBBBBBB'));
    expect(merged.dataByAsin).toEqual([
      { asin: 'B0AAAAAAAA', n: 1 },
      { asin: 'B0BBBBBBBB', n: 2 },
      { asin: 'B0BBBBBBBB', n: 3 },
    ]);
  });

  it('keeps the first document reportSpecification otherwise, rewriting reportOptions.asin to the full list', () => {
    const d1 = doc([], 'B0AAAAAAAA');
    const d2 = doc([], 'B0BBBBBBBB');
    const merged = JSON.parse(mergeSqpDocuments([d1, d2], 'B0AAAAAAAA B0BBBBBBBB'));
    expect(merged.reportSpecification.reportType).toBe(
      'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    );
    expect(merged.reportSpecification.reportOptions.reportPeriod).toBe('WEEK');
    expect(merged.reportSpecification.reportOptions.asin).toBe('B0AAAAAAAA B0BBBBBBBB');
  });

  it('single-doc passthrough still applies the asin fix-up', () => {
    const d1 = doc([{ asin: 'B0AAAAAAAA', n: 1 }], 'B0AAAAAAAA');
    const merged = JSON.parse(mergeSqpDocuments([d1], 'B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC'));
    expect(merged.dataByAsin).toEqual([{ asin: 'B0AAAAAAAA', n: 1 }]);
    expect(merged.reportSpecification.reportOptions.asin).toBe(
      'B0AAAAAAAA B0BBBBBBBB B0CCCCCCCC',
    );
  });

  it('leaves reportSpecification untouched when reportOptions.asin is absent', () => {
    const d1 = doc([{ asin: 'B0AAAAAAAA', n: 1 }]); // no asin option this time
    const merged = JSON.parse(mergeSqpDocuments([d1], 'B0AAAAAAAA'));
    expect(merged.reportSpecification.reportOptions.asin).toBeUndefined();
    expect(merged.reportSpecification.reportOptions.reportPeriod).toBe('WEEK');
  });

  it('throws, naming the chunk index, when a chunk is missing dataByAsin', () => {
    const good = doc([{ asin: 'B0AAAAAAAA', n: 1 }], 'B0AAAAAAAA');
    const bad = JSON.stringify({ reportSpecification: {} }); // no dataByAsin
    expect(() => mergeSqpDocuments([good, bad], 'B0AAAAAAAA')).toThrow(/chunk 2 of 2/);
    expect(() => mergeSqpDocuments([bad, good], 'B0AAAAAAAA')).toThrow(/chunk 1 of 2/);
  });

  it('throws, naming the chunk index, on invalid JSON', () => {
    const good = doc([{ asin: 'B0AAAAAAAA', n: 1 }], 'B0AAAAAAAA');
    expect(() => mergeSqpDocuments([good, '{not json'], 'B0AAAAAAAA')).toThrow(/chunk 2 of 2/);
  });

  it('throws on zero documents', () => {
    expect(() => mergeSqpDocuments([], 'B0AAAAAAAA')).toThrow();
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
    email: 'amazon+clients@example.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}
