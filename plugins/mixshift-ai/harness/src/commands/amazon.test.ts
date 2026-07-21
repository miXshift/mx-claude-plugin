/**
 * Command-level tests for `mixshift amazon report start|run`, focused on the
 * SQP (GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) reportOptions.asin
 * requirement and the `report run` auto-batch/merge path.
 *
 * Amazon REQUIRES reportOptions.asin for SQP; omitting it lets Amazon accept
 * the createReport call and then FATAL it during processing, with no useful
 * error (confirmed live against a beta user's account). These tests pin:
 *   (a) `report run` splits a long ASIN list into multiple startReport calls
 *       (one per <=200-char chunk) and merges the resulting documents;
 *   (b) `report run` fails fast (before any network call) when asin is
 *       missing;
 *   (c) `report start` fails fast on BOTH a missing asin and an oversize
 *       asin (it cannot split a request across multiple report pulls);
 *   (d) a non-SQP `report run` (and an SQP run whose asin already fits in
 *       one chunk) is completely unaffected — still exactly one
 *       startReport + one streamReportDocumentToFile call;
 *   (e) a terminal failure partway through the auto-batch loop reports which
 *       chunk failed and which run_ids already completed, and writes no
 *       output file.
 *
 * The SP-API client functions are mocked (no network, no credentials); the
 * pure helpers (chunkAsinList, mergeSqpDocuments, isReportFailure,
 * exitCodeForKind, throttleBackoffMs, the SQP_* constants) stay real via
 * importOriginal, so the chunking/merge math under test is the real
 * implementation, not a stub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAmazonCommands } from './amazon.js';
import {
  startReport,
  pollReport,
  getReportDocument,
  getReportDocumentMeta,
  streamReportDocumentToFile,
  chunkAsinList,
  type StartReportInput,
} from '../lib/amazon/reports.js';
import { track } from '../lib/telemetry/index.js';
import { EventName } from '../lib/telemetry/events.js';

/** Pull the payload of the report.started track() call (the last one, so the
 *  SQP chunked path returns the most recent chunk's). */
function reportStartedPayloads(): any[] {
  return vi
    .mocked(track)
    .mock.calls.filter((c) => (c[0] as any)?.event_name === EventName.ReportStarted)
    .map((c) => (c[0] as any).payload);
}

/** Pull the payloads of any report.failed track() calls. */
function reportFailedPayloads(): any[] {
  return vi
    .mocked(track)
    .mock.calls.filter((c) => (c[0] as any)?.event_name === EventName.ReportFailed)
    .map((c) => (c[0] as any).payload);
}

const SQP_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';

vi.mock('../lib/amazon/reports.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/reports.js')>();
  return {
    ...actual, // keep chunkAsinList / mergeSqpDocuments / isReportFailure / exitCodeForKind / throttleBackoffMs / SQP_* real
    listMerchants: vi.fn(),
    startReport: vi.fn(),
    pollReport: vi.fn(),
    getReportDocument: vi.fn(),
    getReportDocumentMeta: vi.fn(),
    streamReportDocumentToFile: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

/** Mirror the cli.ts wiring `amazon` hangs off in production. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerAmazonCommands(program);
  return program;
}

async function runCli(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', ...args]);
}

function makeAsins(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `B0${String(i).padStart(8, '0')}`);
}

let tmpDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  tmpDir = await mkdtemp(join(tmpdir(), 'mx-amazon-cmd-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDir, { recursive: true, force: true });
});

const stdoutText = (): string => stdoutChunks.join('');
const lastJson = (): any => JSON.parse(stdoutText());

// ---------------------------------------------------------------------------
// report start — SQP preflight
// ---------------------------------------------------------------------------

describe('report start — SQP asin preflight', () => {
  it('fails fast when reportOptions.asin is missing, before any network call', async () => {
    await runCli('amazon', 'report', 'start', '--type', SQP_TYPE, '--json');

    expect(startReport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/reportOptions\.asin/);
  });

  it('fails fast when reportOptions.asin exceeds the 200-char cap', async () => {
    const asins = makeAsins(25); // 25*10 + 24 separators = 274 chars, over the cap
    await runCli(
      'amazon',
      'report',
      'start',
      '--type',
      SQP_TYPE,
      '--option',
      `asin=${asins.join(' ')}`,
      '--json',
    );

    expect(startReport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/200 characters/);
    expect(result.message).toMatch(/report run/);
  });

  it('does not gate non-SQP report types on asin at all', async () => {
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });
    await runCli('amazon', 'report', 'start', '--type', 'GET_SALES_AND_TRAFFIC_REPORT', '--json');

    expect(startReport).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(exitCodeBefore);
  });
});

// ---------------------------------------------------------------------------
// report run — SQP missing asin (fail fast, before any network call)
// ---------------------------------------------------------------------------

describe('report run — SQP asin preflight', () => {
  it('fails fast when reportOptions.asin is missing, before any network call', async () => {
    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      SQP_TYPE,
      '--out',
      join(tmpDir, 'x.json'),
      '--json',
    );

    expect(startReport).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/reportOptions\.asin/);
  });
});

// ---------------------------------------------------------------------------
// report run — SQP auto-batch: a long ASIN list splits into multiple pulls
// and the resulting documents are merged into one file.
// ---------------------------------------------------------------------------

describe('report run — SQP auto-batch', () => {
  it('splits a 30-ASIN list into multiple startReport calls, all other fields passed through, and merges the JSON', async () => {
    const asins = makeAsins(30);
    const fullAsinList = asins.join(' ');
    const { chunks: expectedChunks } = chunkAsinList(fullAsinList);
    expect(expectedChunks.length).toBeGreaterThanOrEqual(2); // 30 ASINs can't fit in one 200-char chunk

    const startedInputs: StartReportInput[] = [];
    const asinsByRunId = new Map<string, string>();
    let startCounter = 0;
    vi.mocked(startReport).mockImplementation(async (input) => {
      startCounter += 1;
      const runId = `run-${startCounter}`;
      startedInputs.push(input);
      asinsByRunId.set(runId, (input.reportOptions?.asin as string | undefined) ?? '');
      return { ok: true, runId, status: 'IN_QUEUE' };
    });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocument).mockImplementation(async (runId: string) => {
      const asinStr = asinsByRunId.get(runId) ?? '';
      const rows = asinStr
        .split(' ')
        .filter(Boolean)
        .map((asin) => ({ asin, searchQueryData: {} }));
      const text = JSON.stringify({
        reportSpecification: {
          reportType: SQP_TYPE,
          reportOptions: { reportPeriod: 'WEEK', asin: asinStr },
        },
        dataByAsin: rows,
      });
      return {
        ok: true,
        ready: true,
        status: 'DONE',
        document: text,
        bytes: Buffer.byteLength(text, 'utf8'),
      };
    });

    const outPath = join(tmpDir, 'sqp-merged.json');
    await runCli(
      'amazon',
      'report',
      'run',
      '--seller-id',
      'A1SELLER',
      '--legacy-seller-id',
      '42',
      '--type',
      SQP_TYPE,
      '--option',
      'reportPeriod=WEEK',
      '--option',
      `asin=${fullAsinList}`,
      '--start',
      '2026-07-05',
      '--end',
      '2026-07-11',
      '--out',
      outPath,
      '--json',
    );

    // One startReport call per chunk, each carrying the expected chunk asin
    // string and every other field passed through unchanged.
    expect(startedInputs).toHaveLength(expectedChunks.length);
    startedInputs.forEach((input, i) => {
      expect(input.reportOptions?.asin).toBe(expectedChunks[i]);
      expect(input.reportOptions?.reportPeriod).toBe('WEEK');
      expect(input.amazonSellerId).toBe('A1SELLER');
      expect(input.legacySellerId).toBe('42');
      expect(input.start).toBe('2026-07-05');
      expect(input.end).toBe('2026-07-11');
      expect(input.reportType).toBe(SQP_TYPE);
    });

    // The merged file on disk: every chunk's dataByAsin concatenated, and the
    // full ASIN list rewritten into reportSpecification.
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    expect(written.dataByAsin).toHaveLength(30);
    expect(written.reportSpecification.reportOptions.asin).toBe(fullAsinList);

    // Final --json envelope: run_ids/chunks/asin_count/bytes.
    const result = lastJson();
    expect(result.status).toBe('ok');
    expect(result.ready).toBe(true);
    expect(result.run_id).toBe('run-1');
    expect(result.run_ids).toEqual(startedInputs.map((_, i) => `run-${i + 1}`));
    expect(result.chunks).toBe(expectedChunks.length);
    expect(result.asin_count).toBe(30);
    expect(result.out_path).toBe(outPath);
    expect(typeof result.bytes).toBe('number');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('a terminal failure partway through reports chunk context, run_ids so far, and writes no output file', async () => {
    const asins = makeAsins(30);
    let startCounter = 0;
    vi.mocked(startReport).mockImplementation(async () => {
      startCounter += 1;
      if (startCounter === 2) {
        return {
          ok: false,
          kind: 'report_fatal',
          friendly: 'Amazon could not generate this report.',
        };
      }
      return { ok: true, runId: `run-${startCounter}`, status: 'IN_QUEUE' };
    });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocument).mockResolvedValue({
      ok: true,
      ready: true,
      status: 'DONE',
      document: JSON.stringify({ reportSpecification: {}, dataByAsin: [] }),
      bytes: 2,
    });

    const outPath = join(tmpDir, 'sqp-fail.json');
    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      SQP_TYPE,
      '--option',
      `asin=${asins.join(' ')}`,
      '--out',
      outPath,
      '--json',
    );

    const result = lastJson();
    expect(result.status).toBe('error');
    expect(result.chunk).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.run_ids).toEqual(['run-1']); // chunk 1 completed before chunk 2 failed
    expect(existsSync(outPath)).toBe(false);
  });

  it('when the final merge fails AFTER all chunks pulled, surfaces every completed run_id and writes no file', async () => {
    const asins = makeAsins(30);
    let startCounter = 0;
    vi.mocked(startReport).mockImplementation(async () => {
      startCounter += 1;
      return { ok: true, runId: `run-${startCounter}`, status: 'IN_QUEUE' };
    });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    // Every chunk pulls fine, but the SECOND chunk's document is malformed
    // (no dataByAsin), so mergeSqpDocuments throws only after all chunks are
    // done — exercising the post-loop merge/write failure path.
    let docCounter = 0;
    vi.mocked(getReportDocument).mockImplementation(async () => {
      docCounter += 1;
      const body =
        docCounter === 2
          ? JSON.stringify({ reportSpecification: {}, notDataByAsin: true })
          : JSON.stringify({ reportSpecification: {}, dataByAsin: [] });
      return { ok: true, ready: true, status: 'DONE', document: body, bytes: 2 };
    });

    const outPath = join(tmpDir, 'sqp-merge-fail.json');
    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      SQP_TYPE,
      '--option',
      `asin=${asins.join(' ')}`,
      '--out',
      outPath,
      '--json',
    );

    expect(process.exitCode).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('error');
    expect(result.failure_kind).toBe('merge_failed');
    // All chunks pulled, so every run_id must be recoverable by the user.
    expect(result.run_ids).toEqual(
      Array.from({ length: startCounter }, (_, i) => `run-${i + 1}`),
    );
    expect(result.run_ids.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(outPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// report run — non-SQP (and SQP-fits-in-one-chunk) is entirely unaffected
// ---------------------------------------------------------------------------

describe('report run — single-report path unaffected', () => {
  it('a non-SQP report type still takes the single streaming path (one startReport, one stream call)', async () => {
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocumentMeta).mockResolvedValue({
      ok: true,
      ready: true,
      status: 'DONE',
      document: { url: 'https://example.test/doc', compressionAlgorithm: null },
    });
    vi.mocked(streamReportDocumentToFile).mockResolvedValue({ ok: true, bytes: 1234 });

    const outPath = join(tmpDir, 'sales.json');
    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      'GET_SALES_AND_TRAFFIC_REPORT',
      '--start',
      '2026-07-01',
      '--end',
      '2026-07-07',
      '--out',
      outPath,
      '--json',
    );

    expect(startReport).toHaveBeenCalledTimes(1);
    expect(streamReportDocumentToFile).toHaveBeenCalledTimes(1);
    expect(getReportDocument).not.toHaveBeenCalled();
    const result = lastJson();
    expect(result.status).toBe('ok');
    expect(result.run_id).toBe('run-1');
    expect(result.bytes).toBe(1234);
    expect(result.chunks).toBeUndefined();
  });

  it('an SQP asin that already fits in one chunk (<=200 chars) also takes the single streaming path unchanged', async () => {
    const asins = makeAsins(10); // 10*10 + 9 = 109 chars, well under the cap
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocumentMeta).mockResolvedValue({
      ok: true,
      ready: true,
      status: 'DONE',
      document: { url: 'https://example.test/doc', compressionAlgorithm: null },
    });
    vi.mocked(streamReportDocumentToFile).mockResolvedValue({ ok: true, bytes: 999 });

    const outPath = join(tmpDir, 'sqp-small.json');
    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      SQP_TYPE,
      '--option',
      `asin=${asins.join(' ')}`,
      '--out',
      outPath,
      '--json',
    );

    expect(startReport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startReport).mock.calls[0]![0].reportOptions?.asin).toBe(asins.join(' '));
    expect(streamReportDocumentToFile).toHaveBeenCalledTimes(1);
    expect(getReportDocument).not.toHaveBeenCalled();
    const result = lastJson();
    expect(result.status).toBe('ok');
    expect(result.bytes).toBe(999);
    expect(result.chunks).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// report.started telemetry enrichment (FF-1): the event now carries the
// window (start/end) and reportOptions so a later FATAL is diagnosable.
// ---------------------------------------------------------------------------

describe('report.started telemetry captures window + reportOptions', () => {
  it('report start (SQP) stamps report_options, start, end, and run_id', async () => {
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });

    await runCli(
      'amazon',
      'report',
      'start',
      '--seller-id',
      'A1SELLER',
      '--type',
      SQP_TYPE,
      '--option',
      'reportPeriod=WEEK',
      '--option',
      'asin=B0AAAA1111 B0BBBB2222',
      '--start',
      '2026-07-05',
      '--end',
      '2026-07-11',
      '--json',
    );

    const payloads = reportStartedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      report_type: SQP_TYPE,
      run_id: 'run-1',
      amazon_seller_id: 'A1SELLER',
      start: '2026-07-05',
      end: '2026-07-11',
      report_options: { reportPeriod: 'WEEK', asin: 'B0AAAA1111 B0BBBB2222' },
    });
  });

  it('report run (non-SQP) stamps via:run, start, end, run_id on report.started', async () => {
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocumentMeta).mockResolvedValue({
      ok: true,
      ready: true,
      status: 'DONE',
      document: { url: 'https://example.test/doc', compressionAlgorithm: null },
    });
    vi.mocked(streamReportDocumentToFile).mockResolvedValue({ ok: true, bytes: 10 });

    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      'GET_SALES_AND_TRAFFIC_REPORT',
      '--start',
      '2026-07-01',
      '--end',
      '2026-07-07',
      '--out',
      join(tmpDir, 'st.json'),
      '--json',
    );

    const payloads = reportStartedPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      report_type: 'GET_SALES_AND_TRAFFIC_REPORT',
      via: 'run',
      run_id: 'run-1',
      start: '2026-07-01',
      end: '2026-07-07',
    });
  });

  it('report run (SQP auto-batch) emits one report.started per chunk, each with that chunk’s own asin', async () => {
    const asins = makeAsins(30);
    const { chunks: expectedChunks } = chunkAsinList(asins.join(' '));
    let startCounter = 0;
    const asinByRun = new Map<string, string>();
    vi.mocked(startReport).mockImplementation(async (input) => {
      startCounter += 1;
      const runId = `run-${startCounter}`;
      asinByRun.set(runId, (input.reportOptions?.asin as string) ?? '');
      return { ok: true, runId, status: 'IN_QUEUE' };
    });
    vi.mocked(pollReport).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    vi.mocked(getReportDocument).mockImplementation(async (runId: string) => {
      const asinStr = asinByRun.get(runId) ?? '';
      const rows = asinStr.split(' ').filter(Boolean).map((asin) => ({ asin }));
      const text = JSON.stringify({ reportSpecification: {}, dataByAsin: rows });
      return { ok: true, ready: true, status: 'DONE', document: text, bytes: text.length };
    });

    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      SQP_TYPE,
      '--option',
      'reportPeriod=WEEK',
      '--option',
      `asin=${asins.join(' ')}`,
      '--out',
      join(tmpDir, 'sqp.json'),
      '--json',
    );

    const payloads = reportStartedPayloads();
    expect(payloads).toHaveLength(expectedChunks.length);
    payloads.forEach((p, i) => {
      expect(p.via).toBe('run');
      expect(p.report_options.asin).toBe(expectedChunks[i]);
      expect(p.report_options.reportPeriod).toBe('WEEK');
      expect(p.run_id).toBe(`run-${i + 1}`);
    });
  });
});

// ---------------------------------------------------------------------------
// report.failed carries run_id so a failure correlates to its report.started
// (gemini review follow-up: without it, a first-poll failure leaves the
// started + failed events with no common id).
// ---------------------------------------------------------------------------

describe('report.failed carries run_id for started<->failed correlation', () => {
  it('report run: a non-throttled poll failure emits report.failed with the started run_id', async () => {
    vi.mocked(startReport).mockResolvedValue({ ok: true, runId: 'run-1', status: 'IN_QUEUE' });
    // First poll fails terminally (non-throttled) -> no report.polled ever
    // carries the id, so run_id on report.failed is the only correlator.
    vi.mocked(pollReport).mockResolvedValue({
      ok: false,
      kind: 'report_fatal',
      friendly: 'Amazon could not generate this report.',
    });

    await runCli(
      'amazon',
      'report',
      'run',
      '--type',
      'GET_SALES_AND_TRAFFIC_REPORT',
      '--start',
      '2026-07-01',
      '--end',
      '2026-07-07',
      '--out',
      join(tmpDir, 'x.json'),
      '--json',
    );

    const failed = reportFailedPayloads();
    expect(failed).toHaveLength(1);
    expect(failed[0].run_id).toBe('run-1');
    // Same id as the started event -> the pair is now correlatable.
    expect(reportStartedPayloads()[0].run_id).toBe('run-1');
  });

  it('report poll: a failure carries the polled run_id', async () => {
    vi.mocked(pollReport).mockResolvedValue({
      ok: false,
      kind: 'report_fatal',
      friendly: 'Amazon could not generate this report.',
    });

    await runCli('amazon', 'report', 'poll', 'run-xyz', '--json');

    const failed = reportFailedPayloads();
    expect(failed).toHaveLength(1);
    expect(failed[0].run_id).toBe('run-xyz');
    // No report_type on the poll/get path (not in scope there).
    expect(failed[0].report_type).toBeUndefined();
  });
});
