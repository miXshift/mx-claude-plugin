import type { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateReportData, type Finding, type ReportDataDocument } from '../lib/report-contract/validate.js';
import {
  extractFigures,
  checkFigures,
  COMPOSITE_SELECTIONS,
  CompositeSelectionError,
  type CompositeSelection,
} from '../lib/report-contract/extract.js';
import {
  renderMonthlyReport,
  scanForecastVocabulary,
  type RenderReportDataDocument,
} from '../lib/report-contract/render-report.js';
import { UserFacingError } from '../lib/errors.js';

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    throw new UserFacingError(
      `Could not read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`,
      'report_data_unreadable',
    );
  }
}

/** Write `body` to `out`, creating its parent directory first (matches the
 *  convention in intelligence.ts / brand-view.ts) so a missing intermediate
 *  directory never surfaces as a raw ENOENT -> unhandled_exception crash.
 *  A residual write failure (permissions, disk full, etc.) is reclassified
 *  as a clean, recoverable UserFacingError instead. */
async function writeReportOutput(out: string, body: string): Promise<void> {
  try {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, body, 'utf8');
  } catch (err) {
    throw new UserFacingError(
      `Could not write ${out}: ${err instanceof Error ? err.message : String(err)}`,
      'report_out_unwritable',
    );
  }
}

interface RootOptions {
  json?: boolean;
}

interface FileResult {
  file: string;
  findings?: Finding[];
  /** Set instead of `findings` when the file could not be read/parsed as
   *  JSON -- processing continues to the next file rather than aborting
   *  the whole batch before any result prints. */
  error?: string;
}

/**
 * `--json` mode must never let a UserFacingError (a refusal or a read/write
 * failure) fall through to the CLI's top-level catch (cli.ts), which always
 * prints plain text ("error: ...") regardless of --json -- exactly the gap
 * that left --json callers with no parseable output on every failure path.
 * In JSON mode this emits the repo's standard `{status:'error', ...}`
 * envelope (mirrors ads.ts's emitFailure / data.ts's emitError) and sets
 * the exit code itself. In text mode the error is rethrown so cli.ts's
 * existing plain-text handling (and its crash telemetry) is unchanged.
 */
async function withReportErrorHandling(json: boolean, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!json) throw err;
    const isUserFacing = err instanceof UserFacingError;
    console.log(
      JSON.stringify(
        {
          status: 'error',
          error_class: isUserFacing ? err.errorClass : 'unhandled_exception',
          message: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

export function registerReportCommands(program: Command): void {
  const report = program
    .command('report')
    .description('Report-contract tools: validate typed report-data documents at the render seam.');

  report
    .command('validate <files...>')
    .description(
      'Run the report-contract validators (BASIS-1..UNIT-1) over one or more report-data.json ' +
        'documents. Exit 0 = all clean, 1 = findings, 2 = at least one file was unreadable ' +
        '(processing still continues through every file; 2 wins over 1 when both occur).',
    )
    .action(async (files: string[], _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        const results: FileResult[] = [];
        let anyUnreadable = false;
        // Per-file try/catch: an unreadable file mid-list used to throw out
        // of this loop before ANY result printed, hiding every finding
        // already computed for the files that came before it. Now it
        // becomes its own result entry and the loop continues.
        for (const file of files) {
          try {
            const doc = await readJson<ReportDataDocument>(file);
            results.push({ file, findings: validateReportData(doc) });
          } catch (err) {
            anyUnreadable = true;
            results.push({ file, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const total = results.reduce((n, r) => n + (r.findings?.length ?? 0), 0);
        const unreadableCount = results.filter((r) => r.error !== undefined).length;
        if (root.json) {
          console.log(
            JSON.stringify(
              { ok: total === 0 && !anyUnreadable, total, unreadable: unreadableCount, results },
              null,
              2,
            ),
          );
        } else {
          for (const r of results) {
            if (r.error !== undefined) {
              console.log(`\n${r.file}: UNREADABLE -- ${r.error}`);
              continue;
            }
            const findings = r.findings ?? [];
            console.log(`\n${r.file}: ${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}`);
            for (const f of findings) {
              console.log(`  [${f.rule}] ${f.subject} -- ${f.detail}`);
            }
          }
          const summary = [
            total === 0 ? null : `${total} finding(s)`,
            unreadableCount === 0 ? null : `${unreadableCount} file(s) unreadable`,
          ].filter((s): s is string => s !== null);
          console.log(`\n${summary.length === 0 ? 'PASS' : `FAIL: ${summary.join(', ')}`}`);
        }
        process.exitCode = anyUnreadable ? 2 : total === 0 ? 0 : 1;
      });
    });

  report
    .command('extract <response.json>')
    .description(
      'Deterministically extract typed figures from an intelligence run response ' +
        '(the model never reads raw envelope JSON). Use --check to enforce the ' +
        'extraction invariants; exit 0 = ok, 1 = check findings.',
    )
    .option('--out <path>', 'write the figures document here (default: stdout)')
    .option('--check', 'run the extraction invariants (delta identity, SKU split, bridge footing)', false)
    .option(
      '--select <envelope>',
      `for a composite run bundle (INS-MONTHLY-01), which envelope to extract: ${COMPOSITE_SELECTIONS.join(' | ')}`,
    )
    .action(async (file: string, opts: { out?: string; check: boolean; select?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        const response = await readJson<unknown>(file);
        if (opts.select && !(COMPOSITE_SELECTIONS as readonly string[]).includes(opts.select)) {
          throw new UserFacingError(
            `Unknown --select ${opts.select}. Choices: ${COMPOSITE_SELECTIONS.join(', ')}.`,
            'report_bad_selection',
          );
        }
        let doc;
        try {
          doc = extractFigures(response, opts.select as CompositeSelection | undefined);
        } catch (err) {
          if (err instanceof CompositeSelectionError) {
            throw new UserFacingError(err.message, 'report_composite_unselected');
          }
          throw err;
        }
        const findings = opts.check ? checkFigures(doc) : [];
        const body = JSON.stringify(doc, null, 2);
        if (opts.out) {
          await writeReportOutput(opts.out, body + '\n');
        }
        if (root.json) {
          console.log(
            JSON.stringify(
              { ok: findings.length === 0, figures: doc.figures.length, out: opts.out ?? null, findings },
              null,
              2,
            ),
          );
        } else {
          if (!opts.out) console.log(body);
          console.log(
            `\n${doc.figures.length} figure(s) extracted${opts.out ? ` -> ${opts.out}` : ''}`,
          );
          for (const f of findings) console.log(`  [${f.rule}] ${f.subject} -- ${f.detail}`);
          if (opts.check) console.log(findings.length === 0 ? 'CHECK: PASS' : `CHECK: FAIL (${findings.length})`);
        }
        process.exitCode = findings.length === 0 ? 0 : 1;
      });
    });

  report
    .command('render <report-data.json>')
    .description(
      'Render a validated report-data document to self-contained HTML via the ' +
        'deterministic renderer. Refuses to render a document that fails validation, or one ' +
        'whose untagged prose carries forecast vocabulary while the forecast is not ' +
        'provided-current, unless --force is given.',
    )
    .requiredOption('--out <path>', 'write the HTML artifact here')
    .option('--force', 'render even when the document has validator findings', false)
    .action(async (file: string, opts: { out: string; force: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        const doc = await readJson<RenderReportDataDocument>(file);
        const findings = validateReportData(doc);
        if (findings.length > 0 && !opts.force) {
          for (const f of findings) console.error(`  [${f.rule}] ${f.subject} -- ${f.detail}`);
          throw new UserFacingError(
            `Refusing to render: ${findings.length} validator finding(s). Fix report-data.json ` +
              '(corrections go to the data file, never the HTML) or pass --force.',
            'report_data_invalid',
          );
        }
        // Fail-closed at the render door: suppression of forecast content
        // is opt-in (kind: 'forecast'), so untagged forecast-flavored prose
        // would otherwise ship even when the forecast is stale/absent.
        const forecastOffenders = scanForecastVocabulary(doc);
        if (forecastOffenders.length > 0 && !opts.force) {
          for (const id of forecastOffenders) console.error(`  forecast vocabulary: ${id}`);
          throw new UserFacingError(
            `Refusing to render: forecast vocabulary found in ${forecastOffenders.length} ` +
              `untagged location(s) while the forecast is not provided-current: ` +
              `${forecastOffenders.join(', ')}. Tag forecast-dependent content with kind: 'forecast' ` +
              'or pass --force.',
            'report_forecast_vocabulary',
          );
        }
        const html = renderMonthlyReport(doc);
        await writeReportOutput(opts.out, html);
        if (root.json) {
          console.log(JSON.stringify({ ok: true, out: opts.out, bytes: html.length, findings }, null, 2));
        } else {
          console.log(`Rendered ${opts.out} (${html.length} bytes${findings.length ? `; ${findings.length} finding(s) overridden` : ''})`);
        }
      });
    });
}
