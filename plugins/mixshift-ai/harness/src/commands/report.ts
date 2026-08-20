import type { Command } from 'commander';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  validateReportData,
  blockingFindings,
  type Finding,
  type ReportDataDocument,
  type ServedContractIndex,
} from '../lib/report-contract/validate.js';
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

/** Commander maps `--no-figures` onto the POSITIVE key, so `opts.figures` is
 *  `false` (not a `noFigures` boolean) when the flag is passed. Narrow it back
 *  to the path list the loader wants. */
function figuresOpt(v: string[] | false | undefined): string[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/**
 * Build the served unit contract for a report-data document by reading the
 * `report extract` output it was composed from.
 *
 * `explicit` wins outright. With none given we look beside the document for
 * `figures*.json`, which is the layout SKILL.md's own worked run produces
 * (`report extract --out figures.mom.ops.json` next to `report-data.json`).
 * Finding nothing is not an error: pre-served-contract runs and hand-built test
 * documents have no sidecar, and UNIT-2's contract arm is specified to stay
 * silent when nothing was served rather than manufacture findings from skew.
 *
 * ⚠ Auto-discovery makes ambient files a BLOCKING input to a user-facing
 * command, so the two ways that goes wrong are handled explicitly:
 *
 *   - A stale or foreign sidecar could block a correct document, decided by
 *     nothing but filename sort order. So sidecars that DISAGREE about a
 *     figure retire that figure from the check (`conflicts`) instead of
 *     last-wins, and `origin` records which file supplied each unit so the
 *     refusal can name it -- the contradicting value appears nowhere in
 *     report-data.json, and pointing the operator there sends them to debug a
 *     file that looks correct. `--no-figures` opts out without reaching for
 *     `--force`, which would waive every other rule too.
 *   - An explicit `--figures` path that cannot be read THROWS. Skipping it
 *     would let one typo switch the served-unit check off and report CLEAN.
 *
 * A malformed or irrelevant file found by auto-discovery is still skipped
 * quietly: a stray `figures-notes.json` in the working directory must not take
 * down a render.
 */
async function loadServedContract(
  docPath: string,
  explicit: string[] | undefined,
  noFigures: boolean,
): Promise<{ index?: ServedContractIndex; sources: string[]; conflicts: string[] }> {
  const none = { sources: [] as string[], conflicts: [] as string[] };
  if (noFigures) return none;

  let candidates: string[];
  if (explicit && explicit.length > 0) {
    // ⚠ An explicit path that cannot be read is an ERROR, not a skip. Silently
    // continuing means a single typo in --figures voids the served-unit check
    // and the run reports CLEAN -- failing open on the exact check that exists
    // to catch a wrong unit.
    candidates = [...new Set(explicit.map((p) => resolve(p)))];
    for (const path of candidates) {
      try {
        await readFile(path, 'utf8');
      } catch (err) {
        throw new UserFacingError(
          `--figures ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
          'figures_unreadable',
        );
      }
    }
  } else {
    const dir = dirname(resolve(docPath));
    try {
      const entries = await readdir(dir);
      candidates = entries
        .filter((e) => /^figures.*\.json$/i.test(e))
        .sort()
        .map((e) => join(dir, e));
    } catch {
      return none;
    }
  }

  // id -> unit, plus where it came from, so a finding can name the file and
  // so two sidecars that disagree can be detected rather than resolved by
  // filename sort order.
  const units: Record<string, string> = {};
  const origin: Record<string, string> = {};
  const conflicts = new Set<string>();
  const sources: string[] = [];

  for (const path of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    const figures = (parsed as { figures?: unknown })?.figures;
    if (!Array.isArray(figures)) continue;
    let used = false;
    for (const f of figures) {
      const id = (f as { id?: unknown })?.id;
      const servedUnit = (f as { served_unit?: unknown })?.served_unit;
      if (typeof id !== 'string' || typeof servedUnit !== 'string' || servedUnit === '') continue;
      used = true;
      if (units[id] !== undefined && units[id] !== servedUnit) {
        // Two extractions disagree about the same figure. One of them is not
        // this document's -- a leftover from another run, brand, or month.
        // Neither is trustworthy evidence, so the id is dropped rather than
        // decided by sort order.
        conflicts.add(id);
        continue;
      }
      units[id] = servedUnit;
      origin[id] = path;
    }
    if (used) sources.push(path);
  }

  for (const id of conflicts) {
    delete units[id];
    delete origin[id];
  }

  return Object.keys(units).length > 0
    ? { index: { units, origin }, sources, conflicts: [...conflicts] }
    : { sources, conflicts: [...conflicts] };
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
      'Run the report-contract validators (BASIS-1..UNIT-2) over one or more report-data.json ' +
        'documents. Exit 0 = no error-severity findings (warnings may still be reported), ' +
        '1 = at least one error, 2 = at least one file was unreadable (processing still ' +
        'continues through every file; 2 wins over 1 when both occur).',
    )
    .option(
      '--figures <path...>',
      'the `report extract` output the document was composed from, so UNIT-2 can check ' +
        'each unit against the contract the engine served (default: figures*.json beside ' +
        'each document)',
    )
    .option('--no-figures', 'ignore any figures*.json beside the document; skip the served-unit check')
    .action(async (files: string[], opts: { figures?: string[] | false }, cmd: Command) => {
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
            const served = await loadServedContract(file, figuresOpt(opts.figures), opts.figures === false);
            for (const id of served.conflicts) {
              console.error(
                `  warn [UNIT-2] ${id} -- two figures files disagree on this figure's served unit; ` +
                  'the served-unit check is skipped for it. Remove the stale one.',
              );
            }
            results.push({ file, findings: validateReportData(doc, served.index) });
          } catch (err) {
            anyUnreadable = true;
            results.push({ file, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const total = results.reduce((n, r) => n + (r.findings?.length ?? 0), 0);
        // Only error-severity findings fail the run. A warning is a real
        // report about the document that may still be right about the world
        // (a 1200% ACOS on a near-zero-sales row), so it prints and does not
        // gate -- see FindingSeverity.
        const blocking = results.reduce(
          (n, r) => n + blockingFindings(r.findings ?? []).length,
          0,
        );
        const warnings = total - blocking;
        const unreadableCount = results.filter((r) => r.error !== undefined).length;
        if (root.json) {
          console.log(
            JSON.stringify(
              {
                ok: blocking === 0 && !anyUnreadable,
                total,
                blocking,
                warnings,
                unreadable: unreadableCount,
                results,
              },
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
              const tag = (f.severity ?? 'error') === 'warning' ? 'warn' : 'ERROR';
              console.log(`  ${tag} [${f.rule}] ${f.subject} -- ${f.detail}`);
            }
          }
          const summary = [
            blocking === 0 ? null : `${blocking} finding(s)`,
            unreadableCount === 0 ? null : `${unreadableCount} file(s) unreadable`,
          ].filter((s): s is string => s !== null);
          const pass = `PASS${warnings === 0 ? '' : ` (${warnings} warning(s))`}`;
          console.log(`\n${summary.length === 0 ? pass : `FAIL: ${summary.join(', ')}`}`);
        }
        process.exitCode = anyUnreadable ? 2 : blocking === 0 ? 0 : 1;
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
    .option(
      '--figures <path...>',
      'the `report extract` output the document was composed from, so UNIT-2 can check ' +
        'each unit against the contract the engine served (default: figures*.json beside ' +
        'the document)',
    )
    .option('--no-figures', 'ignore any figures*.json beside the document; skip the served-unit check')
    .action(
      async (
        file: string,
        opts: { out: string; force: boolean; figures?: string[] | false },
        cmd: Command,
      ) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        const doc = await readJson<RenderReportDataDocument>(file);
        const served = await loadServedContract(file, figuresOpt(opts.figures), opts.figures === false);
        for (const id of served.conflicts) {
          console.error(
            `  warn [UNIT-2] ${id} -- two figures files disagree on this figure's served unit; ` +
              'the served-unit check is skipped for it. Remove the stale one.',
          );
        }
        const findings = validateReportData(doc, served.index);
        const blocking = blockingFindings(findings);
        // Warnings are reported and never bar the door. Before this split the
        // gate refused on ANY finding, so the single heuristic check in UNIT-2
        // could force an operator to choose between not shipping a correct
        // report and passing --force, which waives BASIS-1 / TRACE-1 /
        // CAVEAT-1 along with it. That trade is now gone.
        for (const f of findings) {
          if ((f.severity ?? 'error') === 'warning') {
            console.error(`  warn [${f.rule}] ${f.subject} -- ${f.detail}`);
          }
        }
        if (blocking.length > 0 && !opts.force) {
          for (const f of blocking) console.error(`  ERROR [${f.rule}] ${f.subject} -- ${f.detail}`);
          // Name the sidecars. A UNIT-2 contract finding cites a value that
          // appears nowhere in report-data.json, so "fix report-data.json"
          // alone sends the operator to debug a file that looks correct.
          const servedHint =
            served.sources.length > 0
              ? ` Served units were read from: ${served.sources.join(', ')} — if one of those is ` +
                'from another run, remove it or pass --no-figures.'
              : '';
          throw new UserFacingError(
            `Refusing to render: ${blocking.length} validator finding(s). Fix report-data.json ` +
              '(corrections go to the data file, never the HTML) or pass --force.' +
              servedHint,
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
