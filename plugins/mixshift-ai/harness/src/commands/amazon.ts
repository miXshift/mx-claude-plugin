/**
 * `mixshift amazon ...` — the Amazon SP-API on-demand report-pull surface.
 *
 * This is the report analogue of `mixshift data ...`: a catalog-driven
 * workhorse for pulling reports MixShift doesn't already hold in the
 * warehouse, or a known report for an ad-hoc window, so the user can analyze
 * / build with / combine / store the result.
 *
 * Command shape:
 *   amazon merchants                 list the merchants you can pull for
 *   amazon list-reports              browse the report catalog (grouped)
 *   amazon describe-report <type>    detail for one report type
 *   amazon report start ...          kick off a run -> prints runId (fast)
 *   amazon report poll <runId>       check done-ness -> {ready,status} (fast)
 *   amazon report get <runId>        fetch the document once ready (fast)
 *   amazon report run ...            start+poll+get in one blocking call
 *
 * Why start/poll/get are SEPARATE commands: chat hosts (Cowork, claude.ai)
 * cap the Bash tool at ~45s, and a report can take minutes to generate. Each
 * of these returns immediately, so the skill polls across separate tool calls
 * instead of blocking. `report run` is the convenience for a real terminal
 * where blocking for a few minutes is fine — it is NOT for chat surfaces.
 *
 * Exit / telemetry contract: action handlers set `process.exitCode` and
 * `return`; cli.ts owns the single `process.exit()` after flushing telemetry.
 * Failures branch the exit code on the typed failure `kind` (see
 * exitCodeForKind) so terminal scripts can react; chat reads `failure_kind`
 * from the --json envelope.
 *
 * Privacy: telemetry captures report_type + duration + outcome (+ failure
 * kind) only. Never the document bytes, never the amazonSellerId.
 */

import type { Command } from 'commander';
import { resolve as resolvePath } from 'node:path';
import {
  listMerchants,
  startReport,
  pollReport,
  getReportDocument,
  getReportDocumentMeta,
  streamReportDocumentToFile,
  isReportFailure,
  type ReportFailure,
  type ReportFailureKind,
  type MerchantView,
  type StartReportInput,
} from '../lib/amazon/reports.js';
import {
  loadReportCatalog,
  findReportType,
  type ReportCatalogEntry,
} from '../lib/reports/catalog.js';
import { reportOutputPath } from '../lib/paths/resolve.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { registerAmazonPricingCommands } from './amazon-pricing.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

/** Distinct exit code for "the run isn't done yet" on `report get` — NOT an
 *  error, but distinct from success(0) so `&&` chains don't process a file
 *  that was never written. The skill keys off `ready` in --json instead. */
const EXIT_NOT_READY = 10;

export function registerAmazonCommands(program: Command): void {
  const amazon = program
    .command('amazon')
    .description(
      'Pull Amazon SP-API reports on demand (read-only). Catalog-driven; ' +
        'fetches data MixShift may not already hold, for any window you need.',
    );

  registerMerchants(amazon);
  registerListReports(amazon);
  registerDescribeReport(amazon);

  const report = amazon
    .command('report')
    .description('Start, poll, and fetch a report run.');

  registerReportStart(report);
  registerReportPoll(report);
  registerReportGet(report);
  registerReportRun(report);

  // SP-API Pricing batch surface (FOEP + Competitive Summary). Verbatim
  // Amazon operation names; sync (default) or --async. Sibling of report.
  registerAmazonPricingCommands(amazon);
}

// ---------------------------------------------------------------------------
// amazon merchants
// ---------------------------------------------------------------------------

function registerMerchants(amazon: Command): void {
  amazon
    .command('merchants')
    .description('List the Amazon merchants (seller/vendor accounts) you can pull reports for.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await listMerchants({ dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackFailure(EventName.AmazonMerchantsListed, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.AmazonMerchantsListed,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { count: result.merchants.length },
          },
          root.dataDir,
        );
        if (root.json) {
          writeJson({ status: 'ok', merchants: result.merchants });
        } else {
          process.stderr.write(`\n✓ ${result.merchants.length} merchant(s)\n\n`);
          process.stdout.write(renderMerchants(result.merchants) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// amazon list-reports
// ---------------------------------------------------------------------------

function registerListReports(amazon: Command): void {
  amazon
    .command('list-reports')
    .description('Browse the report catalog (every report type, grouped).')
    .option('--applies-to <kind>', 'filter: seller | vendor')
    .option('--group <name>', 'filter to one display group (e.g. "FBA Inventory")')
    .action(
      async (opts: { appliesTo?: string; group?: string }, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const all = await loadReportCatalog();
          const filtered = all.filter((e) => {
            if (opts.appliesTo && e.appliesTo !== opts.appliesTo && e.appliesTo !== 'both') {
              return false;
            }
            if (opts.group && e.group !== opts.group) return false;
            return true;
          });
          if (root.json) {
            writeJson({ status: 'ok', count: filtered.length, reports: filtered });
          } else {
            process.stderr.write(`\n✓ ${filtered.length} report type(s)\n`);
            process.stdout.write(renderReportList(filtered) + '\n');
          }
          return;
        } catch (err) {
          emitError(err, !!root.json);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// amazon describe-report <reportType>
// ---------------------------------------------------------------------------

function registerDescribeReport(amazon: Command): void {
  amazon
    .command('describe-report <reportType>')
    .description('Show purpose, window rules, options, and parse hints for one report type.')
    .action(async (reportType: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const entry = await findReportType(reportType);
        if (!entry) {
          // Catalog MISS is not an error. The catalog is a convenience cache,
          // not the source of truth; Amazon's public SP-API docs are. Emit a
          // soft, informational result that points the agent at the docs (where
          // the report's schema, reportOptions, and window rules are public and
          // not credential-gated) so it can drive the pull immediately and
          // propose a catalog entry. `report start` already passes unknown
          // types straight through, so a miss never blocks a pull.
          if (root.json) {
            writeJson({ status: 'ok', known: false, report_type: reportType });
          } else {
            process.stdout.write(renderUnknownReport(reportType) + '\n');
          }
          return;
        }
        if (root.json) {
          writeJson({ status: 'ok', known: true, report: entry });
        } else {
          process.stdout.write(renderReportDetail(entry) + '\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// amazon report start
// ---------------------------------------------------------------------------

interface StartCliOptions {
  sellerId?: string;
  legacySellerId?: string;
  type?: string;
  start?: string;
  end?: string;
  marketplace?: string;
  option: Record<string, string>;
}

function registerReportStart(report: Command): void {
  report
    .command('start')
    .description(
      'Kick off a report run. Returns a runId immediately (does not wait for ' +
        'the document). Poll it with `amazon report poll <runId>`.',
    )
    .option('--seller-id <amazonSellerId>', 'Amazon seller/vendor ID from `amazon merchants` (NOT the numeric warehouse id). Optional when the tenant has exactly one merchant.')
    .option('--legacy-seller-id <id>', 'exact per-marketplace warehouse record id from `amazon merchants` (the `legacySellerId` column). Pins attribution when one seller-id spans multiple marketplaces; prevents the service re-resolving to the wrong marketplace.')
    .requiredOption('--type <reportType>', 'Amazon report type enum, e.g. GET_SALES_AND_TRAFFIC_REPORT')
    .option('--start <date>', 'data window start (YYYY-MM-DD or ISO 8601). Required by some report types; see describe-report.')
    .option('--end <date>', 'data window end (YYYY-MM-DD or ISO 8601).')
    .option('--marketplace <id>', 'marketplace: country code (US/UK/DE/JP) or a raw marketplaceId. Defaults server-side to the merchant marketplace.')
    .option('--option <key=value>', 'reportOptions knob (repeatable), e.g. --option reportPeriod=WEEK', collectKV, {})
    .action(async (opts: StartCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const reportType = opts.type ?? '';
      try {
        const input: StartReportInput = {
          amazonSellerId: opts.sellerId,
          legacySellerId: opts.legacySellerId,
          reportType,
          start: opts.start,
          end: opts.end,
          marketplace: opts.marketplace,
          reportOptions: Object.keys(opts.option).length > 0 ? opts.option : undefined,
        };
        const result = await startReport(input, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackFailure(EventName.ReportFailed, result, startedAt, root.dataDir, reportType);
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.ReportStarted,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { report_type: reportType, status: result.status },
          },
          root.dataDir,
        );
        if (root.json) {
          writeJson({ status: 'ok', run_id: result.runId, report_status: result.status });
        } else {
          process.stdout.write(
            `\n✓ Report run started.\n` +
              `  - run_id: ${result.runId}\n` +
              (result.status ? `  - status: ${result.status}\n` : '') +
              `\nNext: \`mixshift amazon report poll ${result.runId}\` until ready, ` +
              `then \`amazon report get ${result.runId} --out <file>\`.\n`,
          );
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// amazon report poll <runId>
// ---------------------------------------------------------------------------

function registerReportPoll(report: Command): void {
  report
    .command('poll <runId>')
    .description('Check whether a run is done. Returns {ready, status}. Gate on `ready`, not `status`.')
    .action(async (runId: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      try {
        const result = await pollReport(runId, { dataDirOverride: root.dataDir });
        if (isReportFailure(result)) {
          await trackFailure(EventName.ReportFailed, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }
        await track(
          {
            event_name: EventName.ReportPolled,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { ready: result.ready, status: result.status },
          },
          root.dataDir,
        );
        if (root.json) {
          writeJson({
            status: 'ok',
            ready: result.ready,
            report_status: result.status,
            report_id: result.reportId,
          });
        } else {
          process.stdout.write(
            `\n${result.ready ? '✓ ready' : '• not ready yet'}  (status: ${result.status})\n` +
              (result.ready
                ? `\nNext: \`mixshift amazon report get ${runId} --out <file>\`.\n`
                : `\nPoll again in a few seconds.\n`),
          );
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// amazon report get <runId>
// ---------------------------------------------------------------------------

function registerReportGet(report: Command): void {
  report
    .command('get <runId>')
    .description(
      'Fetch the report document. Safe to call before ready (returns ready:false, ' +
        'exit 10, keep polling). With --out, streams the document straight to ' +
        'the file in chunks (any size); without --out, prints a size-capped ' +
        'copy to stdout. Prefer --out so document size is never a concern.',
    )
    .option('--out <path>', 'stream the document to this file (recommended; handles reports of any size)')
    .action(async (runId: string, opts: { out?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const clientOpts = { dataDirOverride: root.dataDir };
      try {
        // --out path: stream to disk. Never materialize the document as a
        // string, so a multi-GB report lands on disk without the V8
        // string-length crash. Fetch metadata only (readiness + presigned URL),
        // then pipe the body through gunzip into the file.
        if (opts.out) {
          const meta = await getReportDocumentMeta(runId, clientOpts);
          if (isReportFailure(meta)) {
            await trackFailure(EventName.ReportFailed, meta, startedAt, root.dataDir);
            return emitFailure(meta, !!root.json);
          }
          if (!meta.ready || !meta.document) {
            return emitNotReady(meta.status, startedAt, root.dataDir, !!root.json);
          }

          const outPath = resolvePath(opts.out);
          const streamed = await streamReportDocumentToFile(meta.document, outPath, clientOpts);
          if (isReportFailure(streamed)) {
            await trackFailure(EventName.ReportFailed, streamed, startedAt, root.dataDir);
            return emitFailure(streamed, !!root.json);
          }
          await trackRetrieved(startedAt, streamed.bytes, root.dataDir);
          if (root.json) {
            writeJson({ status: 'ok', ready: true, out_path: outPath, bytes: streamed.bytes });
          } else {
            process.stderr.write(`\n✓ wrote ${streamed.bytes} bytes to ${outPath}\n`);
          }
          return;
        }

        // No --out: print a size-capped inline copy to stdout. Oversized
        // documents fail cleanly (pointing at --out) instead of crashing.
        const result = await getReportDocument(runId, clientOpts);
        if (isReportFailure(result)) {
          await trackFailure(EventName.ReportFailed, result, startedAt, root.dataDir);
          return emitFailure(result, !!root.json);
        }
        if (!result.ready) {
          return emitNotReady(result.status, startedAt, root.dataDir, !!root.json);
        }

        const document = result.document ?? '';
        const bytes = result.bytes ?? Buffer.byteLength(document, 'utf-8');
        await trackRetrieved(startedAt, bytes, root.dataDir);
        if (root.json) {
          writeJson({ status: 'ok', ready: true, bytes, document });
        } else {
          process.stderr.write(`\n✓ ${bytes} bytes (use --out <file> to save)\n`);
          process.stdout.write(document);
          if (!document.endsWith('\n')) process.stdout.write('\n');
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

/** Emit the "run isn't done yet" result (NOT an error) and set the distinct
 *  EXIT_NOT_READY code. Shared by the --out and stdout paths of `report get`. */
function emitNotReady(
  status: string | undefined,
  startedAt: number,
  dataDir: string | undefined,
  json: boolean,
): void {
  void track(
    {
      event_name: EventName.ReportPolled,
      outcome: 'deferred',
      duration_ms: Date.now() - startedAt,
      payload: { ready: false, status, via: 'get' },
    },
    dataDir,
  );
  if (json) {
    writeJson({ status: 'ok', ready: false, report_status: status });
  } else {
    process.stdout.write(
      `\n• not ready yet (status: ${status ?? 'unknown'}). Poll again, then re-run get.\n`,
    );
  }
  process.exitCode = EXIT_NOT_READY;
}

// ---------------------------------------------------------------------------
// amazon report run  (convenience — blocking; terminal-only)
// ---------------------------------------------------------------------------

interface RunCliOptions extends StartCliOptions {
  out?: string;
  intervalMs: number;
  maxWaitMs: number;
}

function registerReportRun(report: Command): void {
  report
    .command('run')
    .description(
      'Convenience: start + poll-until-ready + get, in one blocking call. ' +
        'TERMINAL-ONLY — it can run for minutes, which exceeds the ~45s Bash ' +
        'ceiling on chat surfaces. In chat, use start/poll/get separately.',
    )
    .option('--seller-id <amazonSellerId>', 'Amazon seller/vendor ID from `amazon merchants`. Optional when the tenant has exactly one merchant.')
    .option('--legacy-seller-id <id>', 'exact per-marketplace warehouse record id from `amazon merchants` (the `legacySellerId` column). Pins attribution when one seller-id spans multiple marketplaces.')
    .requiredOption('--type <reportType>', 'Amazon report type enum')
    .option('--start <date>', 'data window start (YYYY-MM-DD or ISO 8601)')
    .option('--end <date>', 'data window end (YYYY-MM-DD or ISO 8601)')
    .option('--marketplace <id>', 'marketplace: country code (US/UK/DE/JP) or a raw marketplaceId')
    .option('--option <key=value>', 'reportOptions knob (repeatable)', collectKV, {})
    .option('--out <path>', 'output file (default ~/.mixshift/reports/<sellerId>/<date>-<type>.<ext>)')
    .option('--interval-ms <ms>', 'poll interval', parseIntOpt, 5000)
    .option('--max-wait-ms <ms>', 'give up after this long', parseIntOpt, 300000)
    .action(async (opts: RunCliOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      const reportType = opts.type ?? '';
      const sellerId = opts.sellerId ?? '';
      const clientOpts = { dataDirOverride: root.dataDir };
      try {
        if (!root.json) {
          process.stderr.write(
            `\n• Running ${reportType} for ${sellerId || 'your merchant'} (blocking up to ${Math.round(opts.maxWaitMs / 1000)}s)...\n`,
          );
        }

        // 1. start
        const started = await startReport(
          {
            amazonSellerId: opts.sellerId,
            legacySellerId: opts.legacySellerId,
            reportType,
            start: opts.start,
            end: opts.end,
            marketplace: opts.marketplace,
            reportOptions: Object.keys(opts.option).length > 0 ? opts.option : undefined,
          },
          clientOpts,
        );
        if (isReportFailure(started)) {
          await trackFailure(EventName.ReportFailed, started, startedAt, root.dataDir, reportType);
          return emitFailure(started, !!root.json);
        }
        await track(
          {
            event_name: EventName.ReportStarted,
            outcome: 'ok',
            duration_ms: Date.now() - startedAt,
            payload: { report_type: reportType, status: started.status, via: 'run' },
          },
          root.dataDir,
        );
        const runId = started.runId;

        // 2. poll until ready or timeout
        const deadline = startedAt + opts.maxWaitMs;
        let polls = 0;
        let lastStatus = started.status ?? 'UNKNOWN';
        while (Date.now() < deadline) {
          const poll = await pollReport(runId, clientOpts);
          if (isReportFailure(poll)) {
            await trackFailure(EventName.ReportFailed, poll, startedAt, root.dataDir, reportType);
            return emitFailure(poll, !!root.json);
          }
          polls += 1;
          lastStatus = poll.status;
          if (poll.ready) break;
          if (!root.json) process.stderr.write(`  ... ${poll.status} (poll ${polls})\n`);
          await sleep(opts.intervalMs);
        }

        const finalPoll = await pollReport(runId, clientOpts);
        if (isReportFailure(finalPoll)) {
          await trackFailure(EventName.ReportFailed, finalPoll, startedAt, root.dataDir, reportType);
          return emitFailure(finalPoll, !!root.json);
        }
        if (!finalPoll.ready) {
          await track(
            {
              event_name: EventName.ReportPolled,
              outcome: 'timeout',
              duration_ms: Date.now() - startedAt,
              payload: { report_type: reportType, status: lastStatus, polls, via: 'run' },
            },
            root.dataDir,
          );
          const msg =
            `Timed out after ${Math.round(opts.maxWaitMs / 1000)}s waiting for the report ` +
            `(last status: ${finalPoll.status}). The run handle is still valid — ` +
            `poll it later with \`mixshift amazon report poll ${runId}\`.`;
          if (root.json) {
            writeJson({ status: 'error', failure_kind: 'timeout', run_id: runId, report_status: finalPoll.status, message: msg });
          } else {
            process.stderr.write(`\n✗ ${msg}\n`);
          }
          process.exitCode = EXIT_NOT_READY;
          return;
        }

        // 3. fetch the document: always stream to a file (any size, no V8
        // string-length crash). Fetch metadata only, then pipe the presigned
        // body through gunzip into the destination.
        const meta = await getReportDocumentMeta(runId, clientOpts);
        if (isReportFailure(meta)) {
          await trackFailure(EventName.ReportFailed, meta, startedAt, root.dataDir, reportType);
          return emitFailure(meta, !!root.json);
        }
        if (!meta.ready || !meta.document) {
          // We just confirmed ready above, so this is an unexpected race; treat
          // it as not-ready so the run handle stays usable.
          await track(
            {
              event_name: EventName.ReportPolled,
              outcome: 'deferred',
              duration_ms: Date.now() - startedAt,
              payload: { ready: false, status: meta.status, via: 'run' },
            },
            root.dataDir,
          );
          const msg =
            `The report reported ready but its document was not available yet ` +
            `(status: ${meta.status ?? 'unknown'}). The run handle is still valid; ` +
            `fetch it with \`mixshift amazon report get ${runId} --out <file>\`.`;
          if (root.json) {
            writeJson({ status: 'ok', ready: false, run_id: runId, report_status: meta.status, message: msg });
          } else {
            process.stderr.write(`\n• ${msg}\n`);
          }
          process.exitCode = EXIT_NOT_READY;
          return;
        }

        // default out path: scope by amazonSellerId, ext by catalog format.
        const outPath = resolvePath(
          opts.out ?? (await defaultOutPath(sellerId, reportType, root.dataDir)),
        );
        const streamed = await streamReportDocumentToFile(meta.document, outPath, clientOpts);
        if (isReportFailure(streamed)) {
          await trackFailure(EventName.ReportFailed, streamed, startedAt, root.dataDir, reportType);
          return emitFailure(streamed, !!root.json);
        }
        const bytes = streamed.bytes;

        await trackRetrieved(startedAt, bytes, root.dataDir, reportType);
        if (root.json) {
          writeJson({ status: 'ok', ready: true, run_id: runId, out_path: outPath, bytes, polls });
        } else {
          process.stderr.write(
            `\n✓ ${reportType} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${polls} poll(s))\n` +
              `  wrote ${bytes} bytes to ${outPath}\n`,
          );
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

async function trackRetrieved(
  startedAt: number,
  bytes: number,
  dataDir: string | undefined,
  reportType?: string,
): Promise<void> {
  await track(
    {
      event_name: EventName.ReportRetrieved,
      outcome: 'ok',
      duration_ms: Date.now() - startedAt,
      // bytes is a size, not content — safe. No document bytes, no sellerId.
      payload: { bytes, ...(reportType ? { report_type: reportType } : {}) },
    },
    dataDir,
  );
}

async function trackFailure(
  eventName: string,
  failure: ReportFailure,
  startedAt: number,
  dataDir: string | undefined,
  reportType?: string,
): Promise<void> {
  await track(
    {
      event_name: eventName,
      outcome: 'failed',
      error_class: failure.kind,
      duration_ms: Date.now() - startedAt,
      payload: {
        kind: failure.kind,
        ...(reportType ? { report_type: reportType } : {}),
        ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
      },
    },
    dataDir,
  );
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Emit a typed report failure and set the exit code from its kind. */
function emitFailure(failure: ReportFailure, json: boolean): void {
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: failure.kind,
      message: failure.friendly,
      detail: failure.message,
      http_status: failure.httpStatus,
      amazon_seller_id: failure.amazonSellerId,
      report_type: failure.reportType,
      retry_after_ms: failure.retryAfterMs,
      // Multi-marketplace merchant_not_found: the rows to disambiguate with.
      candidates: failure.candidates,
    });
  } else {
    process.stderr.write(`\n✗ ${failure.friendly}\n`);
    if (failure.candidates && failure.candidates.length > 0) {
      process.stderr.write(renderCandidates(failure.candidates));
    }
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

/** Render the candidate rows from a multi-marketplace `merchant_not_found` so
 *  the caller can re-run pinned to an exact record. */
function renderCandidates(candidates: NonNullable<ReportFailure['candidates']>): string {
  const lines = ['\n  This seller trades in several marketplaces. Re-run with one of:'];
  for (const c of candidates) {
    const where = [c.countryCode, c.marketplaceName]
      .filter((s): s is string => !!s)
      .join(' ');
    const idPart = c.marketplaceId ? ` (${c.marketplaceId})` : '';
    const legacy = c.legacySellerId != null ? `--legacy-seller-id ${c.legacySellerId}` : '';
    lines.push(`    - ${legacy}  →  ${where}${idPart}`.replace(/\s+→/, ' →'));
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/** Generic (thrown Error) path — mirrors data.ts emitError. */
function emitError(err: unknown, json: boolean): void {
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    writeJson({ status: 'error', message });
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

/**
 * Map a failure kind to an exit code so terminal scripts can branch. Chat
 * reads `failure_kind` from --json instead. Mirrors data.ts using 4 for the
 * "Amazon won't let us" case (restricted) like access_denied_table=4.
 */
function exitCodeForKind(kind: ReportFailureKind): number {
  switch (kind) {
    case 'not_authenticated':
    case 'session_expired':
      return 2; // sign in / re-login (run `mixshift auth login`)
    case 'restricted_report':
      return 4; // Amazon needs an RDT/PII role MixShift lacks
    case 'reauth_required':
      return 5; // merchant grant lapsed — reconnect this merchant
    case 'spapi_not_configured':
      return 6; // SP-API not enabled for this tenant
    case 'merchant_not_found':
      return 7; // selector matched no merchant
    case 'throttled':
      return 8; // Amazon rate limit — retry later
    case 'report_fatal':
      return 9; // Amazon returned FATAL / CANCELLED
    case 'host_unreachable':
    case 'unknown':
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderMerchants(merchants: MerchantView[]): string {
  if (merchants.length === 0) {
    return '_(no merchants — your tenant may not have any connected Amazon accounts yet)_';
  }
  // The service lists one row per (account, marketplace) and pre-filters to
  // SP-API-active rows, so every row here is already active. We surface
  // legacySellerId (the exact per-marketplace disambiguator used to pin
  // attribution) as its own column when present, fold countryCode +
  // marketplaceName + marketplaceId into one marketplace cell, and show
  // `authorized` (false == Amazon access lost; warn before pulling).
  const hasLegacy = merchants.some(
    (m) =>
      m.legacySellerId !== undefined && m.legacySellerId !== null && m.legacySellerId !== '',
  );
  const cols = ['amazonSellerId'];
  if (hasLegacy) cols.push('legacySellerId');
  cols.push('name', 'type', 'region', 'marketplace', 'authorized');

  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = merchants.map((m) => {
    const cells: string[] = [m.amazonSellerId];
    if (hasLegacy) cells.push(m.legacySellerId != null ? String(m.legacySellerId) : '');
    cells.push(mdCell(m.name), m.merchantType, m.merchantRegion, renderMarketplaceCell(m));
    cells.push(m.authorized ? 'yes' : 'no');
    return '| ' + cells.join(' | ') + ' |';
  });
  return [header, sep, ...rows].join('\n');
}

function renderMarketplaceCell(m: MerchantView): string {
  const label = [m.countryCode, m.marketplaceName]
    .filter((s): s is string => !!s)
    .map((s) => mdCell(s))
    .join(' ');
  const id = m.marketplaceId;
  if (label && id) return `${label} (${id})`;
  if (label) return label;
  return id ?? '';
}

function renderReportList(entries: ReportCatalogEntry[]): string {
  if (entries.length === 0) return '\n_(no report types match)_\n';
  const byGroup = new Map<string, ReportCatalogEntry[]>();
  for (const e of entries) {
    const g = e.group ?? 'Other';
    const list = byGroup.get(g) ?? [];
    list.push(e);
    byGroup.set(g, list);
  }
  const lines: string[] = [];
  for (const [group, list] of byGroup) {
    lines.push('');
    lines.push(`## ${group}`);
    for (const e of list) {
      const tags = [
        e.appliesTo !== 'both' ? e.appliesTo : '',
        e.documentFormat,
        e.window === 'required' ? 'window-required' : e.window === 'forbidden' ? 'no-window' : '',
        e.warehouseCoverage !== 'none' ? `warehouse:${e.warehouseCoverage}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`- \`${e.reportType}\`  —  ${e.purpose}` + (tags ? `  *(${tags})*` : ''));
    }
  }
  return lines.join('\n');
}

function renderReportDetail(e: ReportCatalogEntry): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`# ${e.title}`);
  lines.push(`\`${e.reportType}\``);
  lines.push('');
  lines.push(e.purpose);
  lines.push('');
  lines.push(`- **applies to**: ${e.appliesTo}`);
  lines.push(`- **document format**: ${e.documentFormat}`);
  lines.push(`- **window**: ${e.window}${e.windowNotes ? ` — ${e.windowNotes}` : ''}`);
  lines.push(`- **warehouse coverage**: ${e.warehouseCoverage}`);
  if (e.reportOptions.length > 0) {
    lines.push(`- **reportOptions**:`);
    for (const o of e.reportOptions) {
      lines.push(
        `    - \`${o.key}\`${o.example ? ` (e.g. ${o.example})` : ''}${o.note ? ` — ${o.note}` : ''}`,
      );
    }
  }
  if (e.parseHints) lines.push(`- **parse hints**: ${e.parseHints}`);
  if (e.notes) lines.push(`- **notes**: ${e.notes}`);
  return lines.join('\n');
}

/** Rendered when describe-report is asked about a type not in the catalog. The
 *  catalog is a cache, not a gate: this is informational, not an error. It tells
 *  the agent the type is still pullable and to resolve its requirements from
 *  Amazon's public SP-API docs (report schema / reportOptions / window rules are
 *  public), then propose adding it to the catalog so the cache grows. */
function renderUnknownReport(reportType: string): string {
  return [
    '',
    `# ${reportType}`,
    '',
    'Not in the local report catalog yet. That does not mean it cannot be ' +
      'pulled: the catalog is a convenience cache, not the list of allowed ' +
      'reports, and `report start` accepts any report type.',
    '',
    'To pull it now: look up this report type in Amazon\'s public SP-API ' +
      'documentation (the report schema, its `reportOptions`, and any data-window ' +
      'rules are published and are NOT credential-gated), then run ' +
      `\`mixshift amazon report start --type ${reportType} ...\` with the ` +
      'options the docs call for.',
    '',
    'If it is a report worth keeping, propose a new entry for ' +
      '`shared/reports/catalog.yaml` so the next caller gets it from the cache.',
  ].join('\n');
}

function mdCell(v: string): string {
  return String(v).replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// Option parsers / small utilities
// ---------------------------------------------------------------------------

function collectKV(
  value: string,
  prev: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq < 0) {
    throw new Error(`--option must be key=value (got "${value}")`);
  }
  const key = value.slice(0, eq).trim();
  const val = value.slice(eq + 1);
  if (!key) throw new Error(`--option key is empty in "${value}"`);
  return { ...prev, [key]: val };
}

function parseIntOpt(v: string): number {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${v}"`);
  return n;
}

async function defaultOutPath(
  sellerId: string,
  reportType: string,
  dataDir: string | undefined,
): Promise<string> {
  const entry = await findReportType(reportType);
  const ext: 'tsv' | 'json' = entry?.documentFormat === 'json' ? 'json' : 'tsv';
  const scope = sellerId || 'unknown-merchant';
  return reportOutputPath(scope, todayISO(), reportType, ext, dataDir);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
