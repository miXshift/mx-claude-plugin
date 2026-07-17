/**
 * `mixshift amazon ...` — the Amazon SP-API on-demand amazon-report surface.
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
import { resolve as resolvePath, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  listMerchants,
  startReport,
  pollReport,
  getReportDocument,
  getReportDocumentMeta,
  streamReportDocumentToFile,
  isReportFailure,
  exitCodeForKind,
  throttleBackoffMs,
  chunkAsinList,
  mergeSqpDocuments,
  SQP_REPORT_TYPE,
  SQP_ASIN_OPTION_CHAR_LIMIT,
  type ReportFailure,
  type MerchantView,
  type StartReportInput,
  type PollReportResult,
} from '../lib/amazon/reports.js';
import {
  loadReportCatalog,
  findReportType,
  type ReportCatalogEntry,
} from '../lib/reports/catalog.js';
import { reportOutputPath } from '../lib/paths/resolve.js';
import { track, EventName } from '../lib/telemetry/index.js';
import { registerAmazonPricingCommands } from './amazon-pricing.js';
import { registerAmazonSpApiCommands } from './amazon-spapi.js';

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

  // Generic SP-API call surface: `amazon operations` (browse the service's
  // operation catalog) + `amazon call <operation>` (execute one). Covers the
  // read-operation long tail beyond reports and pricing.
  registerAmazonSpApiCommands(amazon);
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
            payload: {
              count: result.merchants.length,
              // Beta richness (feedback #10): bounded projection of merchant
              // identifiers so reviews can see WHICH seller/marketplace rows a
              // tenant can pull for (and their cron/auth posture), not just a
              // count. Id/flag fields only, never a full merchant object;
              // capped at 25 with a truncated flag.
              sample: result.merchants.slice(0, 25).map((m) => ({
                amazon_seller_id: m.amazonSellerId,
                ...(m.legacySellerId != null ? { legacy_seller_id: m.legacySellerId } : {}),
                ...(m.marketplaceId != null ? { marketplace_id: m.marketplaceId } : {}),
                ...(m.countryCode != null ? { country_code: m.countryCode } : {}),
                authorized: m.authorized,
                ...(typeof m.cronActive === 'boolean' ? { cron_active: m.cronActive } : {}),
              })),
              truncated: result.merchants.length > 25,
            },
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
        // SQP requires reportOptions.asin; Amazon accepts a request without
        // it and then FATALs the report during processing, with no useful
        // error. Preflight it locally so the failure is instant and
        // actionable, before ever calling startReport. `report start` kicks
        // off exactly one report, so an oversize asin (Amazon caps it at 200
        // chars) fails here too -- only `report run` can auto-batch it.
        const asin = requireSqpAsinOption(reportType, opts.option);
        if (asin !== undefined) requireAsinFitsSingleReport(asin);

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
            // Beta richness (feedback #10): stamp the run handle plus the
            // merchant/marketplace selectors the caller pulled for, so a
            // report.started can be traced to a seller/window — not just a
            // report type. run_id from the result; seller/marketplace from the
            // in-scope request (input). Never document bytes.
            payload: {
              report_type: reportType,
              status: result.status,
              run_id: result.runId,
              ...(input.amazonSellerId !== undefined ? { amazon_seller_id: input.amazonSellerId } : {}),
              ...(input.legacySellerId !== undefined ? { legacy_seller_id: input.legacySellerId } : {}),
              ...(input.marketplace !== undefined ? { marketplace: input.marketplace } : {}),
            },
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
            // Beta richness (feedback #10): carry the run handle (the poll
            // target) and Amazon's reportId once assigned, so a poll ties back
            // to a specific run. Mirrors the JSON output below.
            payload: {
              ready: result.ready,
              status: result.status,
              run_id: runId,
              ...(result.reportId !== undefined ? { report_id: result.reportId } : {}),
            },
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
        // SQP requires reportOptions.asin; Amazon accepts a request without
        // it and then FATALs the report during processing, with no useful
        // error. Preflight it locally, before any network call. Unlike
        // `report start`, an oversize asin here is NOT an error -- it drives
        // the auto-batch path below instead.
        const asin = requireSqpAsinOption(reportType, opts.option);
        const needsChunking = asin !== undefined && asin.length > SQP_ASIN_OPTION_CHAR_LIMIT;

        if (!root.json) {
          process.stderr.write(
            `\n• Running ${reportType} for ${sellerId || 'your merchant'} (blocking up to ${Math.round(opts.maxWaitMs / 1000)}s)...\n`,
          );
        }

        // --max-wait-ms is a PER-REPORT budget. For an ordinary single pull
        // that is the whole run. For the SQP auto-batch path each chunk is a
        // separate Amazon report and gets its own fresh --max-wait-ms window
        // (computed per chunk in the loop below), so total wall-clock scales
        // with the ASIN count instead of forcing an N-chunk run to finish
        // inside one report's budget -- Brand Analytics is heavily throttled,
        // and a shared deadline would make any multi-chunk request time out.
        const deadline = startedAt + opts.maxWaitMs;

        if (!needsChunking) {
          // -----------------------------------------------------------------
          // Ordinary path: one report, start -> poll -> stream to file. This
          // is ALSO the path for SQP when its asin already fits in one
          // report (<=200 chars) -- behavior here is byte-for-byte identical
          // to before this change.
          // -----------------------------------------------------------------
          const outcome = await startAndPollUntilReady(
            {
              amazonSellerId: opts.sellerId,
              legacySellerId: opts.legacySellerId,
              reportType,
              start: opts.start,
              end: opts.end,
              marketplace: opts.marketplace,
              reportOptions: Object.keys(opts.option).length > 0 ? opts.option : undefined,
            },
            // Single report: telemetry duration_ms stays "since command start"
            // (stepStartedAt === the command startedAt), byte-for-byte as before.
            { root, clientOpts, stepStartedAt: startedAt, deadline, intervalMs: opts.intervalMs, reportType },
          );

          if (outcome.outcome === 'start_failed' || outcome.outcome === 'poll_failed') {
            return emitFailure(outcome.failure, !!root.json);
          }
          if (outcome.outcome === 'timeout') {
            const msg =
              `Timed out after ${Math.round(opts.maxWaitMs / 1000)}s waiting for the report ` +
              `(last status: ${outcome.lastStatus}). The run handle is still valid — ` +
              `poll it later with \`mixshift amazon report poll ${outcome.runId}\`.`;
            if (root.json) {
              writeJson({
                status: 'error',
                failure_kind: 'timeout',
                run_id: outcome.runId,
                report_status: outcome.lastStatus,
                message: msg,
              });
            } else {
              process.stderr.write(`\n✗ ${msg}\n`);
            }
            process.exitCode = EXIT_NOT_READY;
            return;
          }

          const { runId, polls } = outcome;

          // fetch the document: always stream to a file (any size, no V8
          // string-length crash). Fetch metadata only, then pipe the
          // presigned body through gunzip into the destination.
          const meta = await getReportDocumentMeta(runId, clientOpts);
          if (isReportFailure(meta)) {
            await trackFailure(EventName.ReportFailed, meta, startedAt, root.dataDir, reportType);
            return emitFailure(meta, !!root.json);
          }
          if (!meta.ready || !meta.document) {
            // We just confirmed ready above, so this is an unexpected race;
            // treat it as not-ready so the run handle stays usable.
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
        }

        // -------------------------------------------------------------------
        // SQP auto-batch path: the asin list is longer than Amazon's 200-char
        // reportOptions.asin cap. Split it into multiple <=200-char pulls,
        // run them SEQUENTIALLY (Brand Analytics is heavily throttled; do not
        // parallelize), fetch each chunk's document buffered (chunk docs are
        // far below the 25 MB inline cap), and merge the JSON at the end.
        // -------------------------------------------------------------------
        const { asins: asinList, chunks } = chunkAsinList(asin as string);
        if (!root.json) {
          process.stderr.write(
            `SQP ASIN list: ${asinList.length} ASINs -> ${chunks.length} report pulls ` +
              `(Amazon caps reportOptions.asin at ${SQP_ASIN_OPTION_CHAR_LIMIT} chars)\n`,
          );
        }

        const docs: string[] = [];
        const runIds: string[] = [];
        let totalPolls = 0;

        for (let i = 0; i < chunks.length; i++) {
          const chunkNum = i + 1;
          const chunkAsinStr = chunks[i]!;
          if (!root.json) {
            process.stderr.write(`\n• chunk ${chunkNum}/${chunks.length}: starting...\n`);
          }

          // Each chunk is a separate Amazon report: it gets a fresh
          // --max-wait-ms budget (not the shared outer `deadline`), so a large
          // ASIN list is not forced to complete inside one report's window,
          // and a fresh `stepStartedAt` so its telemetry duration_ms measures
          // THIS chunk's start/poll latency, not cumulative time across chunks.
          const chunkStartedAt = Date.now();
          const chunkDeadline = chunkStartedAt + opts.maxWaitMs;
          const outcome = await startAndPollUntilReady(
            {
              amazonSellerId: opts.sellerId,
              legacySellerId: opts.legacySellerId,
              reportType,
              start: opts.start,
              end: opts.end,
              marketplace: opts.marketplace,
              reportOptions: { ...opts.option, asin: chunkAsinStr },
            },
            {
              root,
              clientOpts,
              stepStartedAt: chunkStartedAt,
              deadline: chunkDeadline,
              intervalMs: opts.intervalMs,
              reportType,
            },
          );

          if (outcome.outcome === 'start_failed' || outcome.outcome === 'poll_failed') {
            emitChunkFailure(outcome.failure, !!root.json, chunkNum, chunks.length, runIds);
            return;
          }
          if (outcome.outcome === 'timeout') {
            emitChunkTimeout(
              !!root.json,
              chunkNum,
              chunks.length,
              outcome.runId,
              outcome.lastStatus,
              runIds,
              opts.maxWaitMs,
            );
            return;
          }

          // Fetch buffered (not streamed): SQP chunk docs are far below the
          // 25 MB inline cap. getReportDocument already fails cleanly if a
          // chunk somehow comes back oversized.
          const docRes = await getReportDocument(outcome.runId, clientOpts);
          if (isReportFailure(docRes)) {
            // Per-chunk telemetry uses this chunk's own start time, not the
            // command start, so duration_ms is this chunk's latency (matching
            // the ReportStarted/ReportPolled events inside startAndPollUntilReady).
            await trackFailure(EventName.ReportFailed, docRes, chunkStartedAt, root.dataDir, reportType);
            emitChunkFailure(docRes, !!root.json, chunkNum, chunks.length, runIds);
            return;
          }
          if (!docRes.ready || docRes.document === undefined) {
            // We just confirmed ready above, so this is an unexpected race.
            await track(
              {
                event_name: EventName.ReportPolled,
                outcome: 'deferred',
                duration_ms: Date.now() - chunkStartedAt,
                payload: { ready: false, status: docRes.status, via: 'run' },
              },
              root.dataDir,
            );
            const msg =
              `SQP chunk ${chunkNum}/${chunks.length} reported ready but its document was not ` +
              `available yet (status: ${docRes.status ?? 'unknown'}). Its run handle is still ` +
              `valid: fetch it with \`mixshift amazon report get ${outcome.runId} --out <file>\`. ` +
              `${runIds.length} chunk(s) completed before this one` +
              `${runIds.length > 0 ? `: ${runIds.join(', ')}` : ''}.`;
            if (root.json) {
              writeJson({
                status: 'ok',
                ready: false,
                run_id: outcome.runId,
                run_ids: runIds,
                chunk: chunkNum,
                chunks: chunks.length,
                report_status: docRes.status,
                message: msg,
              });
            } else {
              process.stderr.write(`\n• ${msg}\n`);
            }
            process.exitCode = EXIT_NOT_READY;
            return;
          }

          docs.push(docRes.document);
          runIds.push(outcome.runId);
          totalPolls += outcome.polls;
        }

        // Every chunk succeeded: merge, write once, track once. If the merge
        // (a malformed chunk doc) or the file write (bad --out path, disk full)
        // throws HERE, all N throttled chunk pulls already completed — surface
        // their run_ids so the user can fetch them individually instead of
        // losing the whole expensive batch to the generic outer catch.
        const fullAsinList = asinList.join(' ');
        const outPath = resolvePath(
          opts.out ?? (await defaultOutPath(sellerId, reportType, root.dataDir)),
        );
        let bytes: number;
        try {
          const merged = mergeSqpDocuments(docs, fullAsinList);
          bytes = Buffer.byteLength(merged, 'utf8');
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, merged, 'utf8');
        } catch (mergeErr) {
          emitMergeFailure(mergeErr, !!root.json, chunks.length, runIds, outPath);
          return;
        }

        await trackRetrieved(startedAt, bytes, root.dataDir, reportType);
        if (root.json) {
          writeJson({
            status: 'ok',
            ready: true,
            run_id: runIds[0],
            run_ids: runIds,
            chunks: chunks.length,
            asin_count: asinList.length,
            out_path: outPath,
            bytes,
            polls: totalPolls,
          });
        } else {
          process.stderr.write(
            `\n✓ ${reportType} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
              `(${chunks.length} chunk(s), ${totalPolls} poll(s) total)\n` +
              `  wrote ${bytes} bytes to ${outPath} (${asinList.length} ASINs)\n`,
          );
        }
        return;
      } catch (err) {
        emitError(err, !!root.json);
      }
    });
}

// ---------------------------------------------------------------------------
// Shared start -> poll-until-ready machinery for `report run`
// ---------------------------------------------------------------------------

type StartPollOutcome =
  | { outcome: 'ready'; runId: string; polls: number }
  | { outcome: 'start_failed'; failure: ReportFailure }
  | { outcome: 'poll_failed'; runId: string; failure: ReportFailure; polls: number }
  | { outcome: 'timeout'; runId: string; lastStatus: string; polls: number };

/**
 * One start + poll-until-ready cycle, extracted so `report run` can share it
 * between the ordinary single-report path and each chunk of the SQP
 * auto-batch path (they are genuinely separate Amazon reports, so each gets
 * its own ReportStarted/ReportPolled/ReportPollThrottled telemetry). Fetching
 * the document is intentionally NOT part of this function: the two callers
 * fetch differently (stream-to-file vs. buffered) and merge differently
 * (single write vs. accumulate-then-merge).
 *
 * `ctx.deadline` and `ctx.stepStartedAt` are caller-supplied and NOT computed
 * inside this function, because their meaning differs by path:
 *   - the ordinary single-report path passes the outer command deadline
 *     (`startedAt + opts.maxWaitMs`) and the command's `startedAt`, so its
 *     telemetry `duration_ms` stays "since the command started" exactly as
 *     before this function existed;
 *   - the SQP auto-batch loop passes a FRESH `chunkDeadline = Date.now() +
 *     opts.maxWaitMs` and a fresh `chunkStartedAt` on every iteration, so each
 *     chunk gets its own full --max-wait-ms budget AND its telemetry
 *     `duration_ms` measures that chunk's own start/poll latency rather than
 *     cumulative time across all prior chunks.
 * Every telemetry emission here (ReportStarted / ReportPollThrottled /
 * ReportPolled / ReportFailed) is therefore relative to `ctx.stepStartedAt`.
 */
async function startAndPollUntilReady(
  input: StartReportInput,
  ctx: {
    root: RootOptions;
    clientOpts: { dataDirOverride: string | undefined };
    stepStartedAt: number;
    deadline: number;
    intervalMs: number;
    reportType: string;
  },
): Promise<StartPollOutcome> {
  const { root, clientOpts, stepStartedAt, deadline, intervalMs, reportType } = ctx;

  const started = await startReport(input, clientOpts);
  if (isReportFailure(started)) {
    await trackFailure(EventName.ReportFailed, started, stepStartedAt, root.dataDir, reportType);
    return { outcome: 'start_failed', failure: started };
  }
  await track(
    {
      event_name: EventName.ReportStarted,
      outcome: 'ok',
      duration_ms: Date.now() - stepStartedAt,
      payload: { report_type: reportType, status: started.status, via: 'run' },
    },
    root.dataDir,
  );
  const runId = started.runId;

  // Poll until ready or timeout. A 429 (throttled) is transient — Amazon
  // rate-limited this poll, not the pull — so back off (honoring any server
  // retry-after) and keep polling to the deadline instead of failing the
  // whole run on the first one. Only a non-throttled failure is terminal in
  // the loop; a run that stays throttled to the deadline surfaces at the
  // finalPoll below as ONE report.failed, not one per poll.
  let polls = 0;
  let throttledPolls = 0;
  let throttleStreak = 0;
  let lastStatus = started.status ?? 'UNKNOWN';
  let pollFailure: ReportFailure | undefined;
  // Capture the last successful poll so the post-loop step can reuse it
  // instead of firing a redundant Amazon poll on the ready path.
  let lastPoll: PollReportResult | undefined;
  while (Date.now() < deadline) {
    const poll = await pollReport(runId, clientOpts);
    if (isReportFailure(poll)) {
      if (poll.kind !== 'throttled') {
        pollFailure = poll;
        break;
      }
      throttledPolls += 1;
      throttleStreak += 1;
      const backoff = throttleBackoffMs(poll.retryAfterMs, intervalMs, throttleStreak, Date.now(), deadline);
      if (backoff <= 0) break; // out of time; fall through to the timeout path
      if (!root.json) {
        process.stderr.write(
          `  ... rate-limited by Amazon; backing off ${(backoff / 1000).toFixed(1)}s ` +
            `(throttle ${throttledPolls})\n`,
        );
      }
      await sleep(backoff);
      continue;
    }
    throttleStreak = 0;
    polls += 1;
    lastStatus = poll.status;
    lastPoll = poll;
    if (poll.ready) break;
    if (!root.json) process.stderr.write(`  ... ${poll.status} (poll ${polls})\n`);
    await sleep(intervalMs);
  }

  // One deduped summary when throttling happened at all, so the
  // error-aggregate sweep sees "throttled but handled" as its own signal
  // rather than as inflated report.failed rows.
  if (throttledPolls > 0) {
    await track(
      {
        event_name: EventName.ReportPollThrottled,
        outcome: 'ok',
        duration_ms: Date.now() - stepStartedAt,
        payload: { report_type: reportType, throttled_polls: throttledPolls, via: 'run' },
      },
      root.dataDir,
    );
  }

  // A non-throttled poll failure is terminal.
  if (pollFailure) {
    await trackFailure(EventName.ReportFailed, pollFailure, stepStartedAt, root.dataDir, reportType);
    return { outcome: 'poll_failed', runId, failure: pollFailure, polls };
  }

  // Reuse the ready poll from the loop; only re-poll if we never got a
  // non-failure poll (e.g. throttled until the deadline).
  const finalPoll = lastPoll ?? (await pollReport(runId, clientOpts));
  if (isReportFailure(finalPoll)) {
    await trackFailure(EventName.ReportFailed, finalPoll, stepStartedAt, root.dataDir, reportType);
    return { outcome: 'poll_failed', runId, failure: finalPoll, polls };
  }
  if (!finalPoll.ready) {
    await track(
      {
        event_name: EventName.ReportPolled,
        outcome: 'timeout',
        duration_ms: Date.now() - stepStartedAt,
        payload: { report_type: reportType, status: lastStatus, polls, throttled_polls: throttledPolls, via: 'run' },
      },
      root.dataDir,
    );
    return { outcome: 'timeout', runId, lastStatus: finalPoll.status, polls };
  }

  return { outcome: 'ready', runId, polls };
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
        // Beta richness (feedback #10): seller/report context the service
        // attached to the failure, so a report.failed can be tied to the
        // merchant + Amazon report it was for (present kind-dependently:
        // amazonSellerId on reauth_required, reportId/status on report_fatal).
        ...(failure.amazonSellerId !== undefined ? { amazon_seller_id: failure.amazonSellerId } : {}),
        ...(failure.reportId !== undefined ? { report_id: failure.reportId } : {}),
        ...(failure.status !== undefined ? { report_status: failure.status } : {}),
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

/** Like emitFailure, but for one chunk of the SQP auto-batch path in `report
 *  run`: adds chunk context (which chunk of N, run_ids of chunks that
 *  already completed) so a mid-run failure is diagnosable, and — same as
 *  emitFailure — never writes an output file (the merge only happens after
 *  every chunk succeeds). */
function emitChunkFailure(
  failure: ReportFailure,
  json: boolean,
  chunk: number,
  totalChunks: number,
  completedRunIds: string[],
): void {
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
      candidates: failure.candidates,
      chunk,
      chunks: totalChunks,
      run_ids: completedRunIds,
    });
  } else {
    process.stderr.write(`\n✗ [SQP chunk ${chunk}/${totalChunks}] ${failure.friendly}\n`);
    if (completedRunIds.length > 0) {
      process.stderr.write(
        `  ${completedRunIds.length} chunk(s) completed before this failure: ${completedRunIds.join(', ')}\n`,
      );
    }
    if (failure.candidates && failure.candidates.length > 0) {
      process.stderr.write(renderCandidates(failure.candidates));
    }
  }
  process.exitCode = exitCodeForKind(failure.kind);
}

/** Timeout counterpart to emitChunkFailure: the overall --max-wait-ms
 *  deadline was hit mid-chunk. The failing chunk's run handle is still valid
 *  to poll/get later; earlier chunks' run handles are listed too. No output
 *  file is written. */
function emitChunkTimeout(
  json: boolean,
  chunk: number,
  totalChunks: number,
  runId: string,
  lastStatus: string,
  completedRunIds: string[],
  maxWaitMs: number,
): void {
  const msg =
    `Timed out after ${Math.round(maxWaitMs / 1000)}s waiting for SQP chunk ${chunk}/${totalChunks} ` +
    `(last status: ${lastStatus}). Its run handle is still valid; poll it later with ` +
    `\`mixshift amazon report poll ${runId}\`. ${completedRunIds.length} chunk(s) completed ` +
    `before this one${completedRunIds.length > 0 ? `: ${completedRunIds.join(', ')}` : ''}.`;
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: 'timeout',
      run_id: runId,
      run_ids: completedRunIds,
      chunk,
      chunks: totalChunks,
      report_status: lastStatus,
      message: msg,
    });
  } else {
    process.stderr.write(`\n✗ ${msg}\n`);
  }
  process.exitCode = EXIT_NOT_READY;
}

/** Every SQP chunk pulled successfully but the final merge or file write threw
 *  (a malformed chunk document, or an unwritable --out path / full disk). All
 *  the expensive throttled pulls already completed, so surface their run_ids
 *  (like emitChunkFailure/emitChunkTimeout do) instead of letting the generic
 *  outer catch drop them: the user can fetch each with `report get <runId>`
 *  rather than re-running the whole batch. No output file is left behind. */
function emitMergeFailure(
  err: unknown,
  json: boolean,
  totalChunks: number,
  completedRunIds: string[],
  outPath: string,
): void {
  const detail = err instanceof Error ? err.message : String(err);
  const msg =
    `All ${totalChunks} SQP chunk(s) pulled, but combining them into ${outPath} failed: ${detail}. ` +
    `The completed pulls are still fetchable individually with ` +
    `\`mixshift amazon report get <run_id> --out <file>\`.`;
  if (json) {
    writeJson({
      status: 'error',
      failure_kind: 'merge_failed',
      chunks: totalChunks,
      run_ids: completedRunIds,
      out_path: outPath,
      message: msg,
      detail,
    });
  } else {
    process.stderr.write(`\n✗ ${msg}\n`);
    if (completedRunIds.length > 0) {
      process.stderr.write(`  completed chunk run ids: ${completedRunIds.join(', ')}\n`);
    }
  }
  process.exitCode = 1;
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

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderMerchants(merchants: MerchantView[]): string {
  if (merchants.length === 0) {
    return '_(no merchants — your tenant may not have any connected Amazon accounts yet)_';
  }
  // The service lists one row per (account, marketplace) whose seller has a
  // stored SP-API authorization. Tokens are region-scoped, so rows that are
  // NOT on a MixShift cron (cronActive=false) still appear and are pullable
  // on demand. We surface legacySellerId (the exact per-marketplace
  // disambiguator used to pin attribution) as its own column when present,
  // fold countryCode + marketplaceName + marketplaceId into one marketplace
  // cell, show `authorized` (false == Amazon access lost; warn before
  // pulling), and show `cron` when the service sends cronActive.
  const hasLegacy = merchants.some(
    (m) =>
      m.legacySellerId !== undefined && m.legacySellerId !== null && m.legacySellerId !== '',
  );
  const hasCron = merchants.some((m) => typeof m.cronActive === 'boolean');
  const cols = ['amazonSellerId'];
  if (hasLegacy) cols.push('legacySellerId');
  cols.push('name', 'type', 'region', 'marketplace', 'authorized');
  if (hasCron) cols.push('cron');

  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = merchants.map((m) => {
    const cells: string[] = [m.amazonSellerId];
    if (hasLegacy) cells.push(m.legacySellerId != null ? String(m.legacySellerId) : '');
    cells.push(mdCell(m.name), m.merchantType, m.merchantRegion, renderMarketplaceCell(m));
    cells.push(m.authorized ? 'yes' : 'no');
    if (hasCron) cells.push(m.cronActive === true ? 'yes' : m.cronActive === false ? 'no' : '');
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

/**
 * SQP (GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT) is the one report
 * type here that REQUIRES a reportOptions.asin value. Amazon accepts a
 * createReport call missing it, then FATALs the report during processing —
 * a slow, confusing failure with no useful error (confirmed live against a
 * beta user's account). Both `report start` and `report run` call this
 * BEFORE any network call so the failure is instant; it throws (the file's
 * existing convention for bad input — see loadItemList in
 * amazon-pricing.ts — is to throw and let the action's catch route it through
 * emitError, `{status:'error', message}`, exit 1). Returns the asin value
 * when the report type is SQP (so callers can act on it further), or
 * `undefined` for every other report type (a no-op).
 */
function requireSqpAsinOption(
  reportType: string,
  options: Record<string, string>,
): string | undefined {
  if (reportType !== SQP_REPORT_TYPE) return undefined;
  const asin = options.asin;
  if (!asin || !asin.trim()) {
    throw new Error(
      `${SQP_REPORT_TYPE} requires a reportOptions.asin value (a space-separated ASIN ` +
        'list). Amazon accepts the request without it and then fails the report with ' +
        'FATAL during processing, with no useful error message. Pass it with ' +
        '--option "asin=B0XXXX1111 B0XXXX2222". For more than ~18 ASINs, use `amazon ' +
        'report run`, which auto-batches any-size ASIN lists into multiple pulls and ' +
        'merges the resulting JSON into one file.',
    );
  }
  return asin;
}

/** `report start` kicks off exactly one report and cannot split a too-long
 *  asin across multiple pulls — only `report run` auto-batches. Call this
 *  after requireSqpAsinOption returns a defined asin, on the `report start`
 *  path only. */
function requireAsinFitsSingleReport(asin: string): void {
  if (asin.length > SQP_ASIN_OPTION_CHAR_LIMIT) {
    throw new Error(
      `reportOptions.asin is ${asin.length} characters; Amazon caps this option at ` +
        `${SQP_ASIN_OPTION_CHAR_LIMIT} characters per report (about 18 ASINs). \`amazon ` +
        'report start` starts exactly one report and cannot split this list; use `amazon ' +
        'report run`, which auto-batches any-size ASIN lists into multiple pulls and merges ' +
        'the resulting JSON documents into one output file.',
    );
  }
}

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
