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
import { runDispatched } from '../lib/data/dispatch.js';
import type { DataQueryFailure } from '../lib/data/query-runner.js';

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
 * Reject an unreadable `--figures` path ONCE, before any document is processed.
 *
 * ⚠ This deliberately does NOT live inside `loadServedContract`. A bad
 * `--figures` value is a mistake in the COMMAND, not a property of any one
 * document, and `report validate` runs its per-file body inside a try/catch
 * that turns every throw into "<that document>: UNREADABLE". Throwing from
 * inside the loop therefore blamed a report-data.json that reads perfectly
 * well, counted it toward `unreadable`, and exited 2 -- pointing the operator
 * at the wrong file, which is the same misattribution this round already had
 * to fix in the render refusal.
 *
 * Silence is not an option either: skipping an unreadable path lets one typo
 * switch the served-unit check off and report CLEAN.
 */
async function assertFiguresReadable(explicit: string[] | undefined): Promise<void> {
  if (!explicit || explicit.length === 0) return;
  for (const path of [...new Set(explicit.map((p) => resolve(p)))]) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      throw new UserFacingError(
        `--figures ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        'figures_unreadable',
      );
    }
    // ⚠ READABILITY IS NOT ENOUGH. Proving the bytes exist and then letting the
    // parse fail quietly downstream leaves the same fail-open this guard was
    // written to close: a truncated figures file -- exactly what an
    // interrupted `report extract --out` leaves on disk, since the write is
    // not atomic -- reads fine, parses to nothing, contributes no index, and
    // the run reports CLEAN. `report render` then writes the HTML.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new UserFacingError(
        `--figures ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          'If an extract was interrupted, re-run `report extract --out` for it.',
        'figures_unreadable',
      );
    }
    if (!Array.isArray((parsed as { figures?: unknown })?.figures)) {
      throw new UserFacingError(
        `--figures ${path} is not a \`report extract\` document (no \`figures\` array).`,
        'figures_unreadable',
      );
    }
  }
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
 *   - An explicit `--figures` path that cannot be read is rejected up front by
 *     `assertFiguresReadable`. Skipping it would let one typo switch the
 *     served-unit check off and report CLEAN.
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
  // --no-figures means SKIP, including any stamp the document carries. Without
  // suppressAll the check would quietly continue off the figure's own
  // model-copied served_unit and the flag would be a lie.
  if (noFigures) return { ...none, index: { suppressAll: true } };

  let candidates: string[];
  if (explicit && explicit.length > 0) {
    candidates = [...new Set(explicit.map((p) => resolve(p)))];
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

  for (const path of candidates) {
    // ⚠ UNPARSEABLE IS NOT THE SAME AS IRRELEVANT, and the difference is the
    // whole fail-open. A file named `figures*.json` that does not parse is
    // almost certainly a CORRUPT extract artifact -- `report extract --out`
    // writes non-atomically, so an interrupted run leaves exactly this -- and
    // quietly skipping it means the served-unit check silently does nothing
    // and the run reports CLEAN. Reproduced on the auto-discovery path:
    // identical document and command, well-formed sidecar FAILs and truncated
    // sidecar PASSes.
    //
    // Read and parse fail SEPARATELY so the remediation matches the failure:
    // "re-run the extract" cures a truncated file and does nothing for a
    // permissions error.
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      throw new UserFacingError(
        `${path} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
          'Fix its permissions, delete the file, or pass --no-figures.',
        'figures_unreadable',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new UserFacingError(
        `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          'A `figures*.json` that will not parse is usually a `report extract --out` that was ' +
          'interrupted; re-run the extract, delete the file, or pass --no-figures.',
        'figures_unreadable',
      );
    }
    // A file that PARSES but carries no `figures` array is merely irrelevant --
    // a stray `figures-notes.json` in the working directory -- and must not
    // take down a render.
    const figures = (parsed as { figures?: unknown })?.figures;
    if (!Array.isArray(figures)) continue;
    for (const f of figures) {
      const id = (f as { id?: unknown })?.id;
      const servedUnit = (f as { served_unit?: unknown })?.served_unit;
      if (typeof id !== 'string' || typeof servedUnit !== 'string' || servedUnit === '') continue;
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
  }

  for (const id of conflicts) {
    delete units[id];
    delete origin[id];
  }

  // `sources` is used to tell the operator where a served unit came from, so
  // it must list only files that still contribute a SURVIVING unit -- naming a
  // file whose every entry was retired sends them to inspect an irrelevant one.
  const contributing = [...new Set(Object.values(origin))].sort();
  const index: ServedContractIndex | undefined =
    Object.keys(units).length > 0 || conflicts.size > 0
      ? { units, origin, suppressed: [...conflicts] }
      : undefined;
  return { index, sources: contributing, conflicts: [...conflicts] };
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
  /** Figure ids whose served-unit check was RETIRED because two figures files
   *  disagreed about them. Carried into --json because a silently-skipped
   *  check reads identical to a passing one, and Step 6 records this output
   *  as the run's audit trail. */
  served_unit_conflicts?: string[];
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
    .description(
      'Report tools: validate, extract and render typed report-data documents at the render seam, ' +
        'and pull the Report Max figure battery from the MixShift service.',
    );

  report
    .command('validate <files...>')
    .description(
      'Run the report-contract validators (BASIS-1..UNIT-2) over one or more report-data.json ' +
        'documents. Exit 0 = no error-severity findings (warnings may still be reported), ' +
        '1 = at least one error, 2 = at least one DOCUMENT was unreadable (processing still ' +
        'continues through the remaining documents; 2 wins over 1 when both occur). ' +
        'A corrupt sidecar is different, because it silently voids the served-unit check: ' +
        'an unreadable --figures path fails the whole command up front, and a corrupt ' +
        'auto-discovered figures*.json fails the run when its own document is reached.',
    )
    .option(
      '--figures <path...>',
      'the `report extract` output the document was composed from, so UNIT-2 can check ' +
        'each unit against the contract the engine served (default: figures*.json beside ' +
        'each document)',
    )
    .option(
      '--no-figures',
      'ignore any figures*.json beside the document (a served_unit carried on the figure ' +
        'itself is still checked)',
    )
    .action(async (files: string[], opts: { figures?: string[] | false }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        // Before the loop, so a bad flag is a command error rather than a
        // slander against the first document. See assertFiguresReadable.
        await assertFiguresReadable(figuresOpt(opts.figures));
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
                `  warn [UNIT-2] ${file}: ${id} -- two figures files disagree on this figure's ` +
                  'served unit; their evidence is discarded for it (a served_unit on the figure ' +
                  'itself still applies). Remove the stale file.',
              );
            }
            results.push({
              file,
              findings: validateReportData(doc, served.index),
              ...(served.conflicts.length > 0 ? { served_unit_conflicts: served.conflicts } : {}),
            });
          } catch (err) {
            // A corrupt figures*.json is an ENVIRONMENT problem, not a property
            // of this document, so it must not be recorded as "<document>:
            // UNREADABLE" -- that is the misattribution this round already had
            // to fix once for --figures, and auto-discovery reintroduced it
            // here. Auto-discovery is per-document so it cannot be hoisted
            // before the loop the way --figures was; instead the error escapes
            // the loop and fails the command, naming the sidecar.
            if (err instanceof UserFacingError && err.errorClass === 'figures_unreadable') throw err;
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
    .option(
      '--no-figures',
      'ignore any figures*.json beside the document (a served_unit carried on the figure ' +
        'itself is still checked)',
    )
    .action(
      async (
        file: string,
        opts: { out: string; force: boolean; figures?: string[] | false },
        cmd: Command,
      ) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        await assertFiguresReadable(figuresOpt(opts.figures));
        const doc = await readJson<RenderReportDataDocument>(file);
        const served = await loadServedContract(file, figuresOpt(opts.figures), opts.figures === false);
        for (const id of served.conflicts) {
          console.error(
            `  warn [UNIT-2] ${id} -- two figures files disagree on this figure's served unit; ` +
              "their evidence is discarded for it (a served_unit on the figure itself still applies). " +
              'Remove the stale file.',
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
          // Only when a served-contract finding is actually among the
          // blockers. Appending it to a BASIS-1 or TRACE-1 refusal points at
          // files that had nothing to do with the failure.
          // Structural, not a substring sniff of the rendered message. `detail`
          // interpolates the figure's own `unit`, which is document-controlled,
          // so a unit string containing "served by " could switch this hint on
          // for a refusal that has nothing to do with sidecars. Ask the index
          // instead: did this specific figure get its contract from a file?
          const servedIds = new Set(Object.keys(served.index?.origin ?? {}));
          const blamesServedUnit = blocking.some(
            (f) => f.rule === 'UNIT-2' && servedIds.has(f.subject),
          );
          const servedHint =
            blamesServedUnit && served.sources.length > 0
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
          // `served_unit_conflicts` belongs here as much as on validate -- more
          // so, since this is the command that WRITES the artifact. A retired
          // check reads exactly like a passing one otherwise, and SKILL.md
          // Step 6 records this output as the run's audit trail.
          console.log(
            JSON.stringify(
              {
                ok: true,
                out: opts.out,
                bytes: html.length,
                findings,
                ...(served.conflicts.length > 0
                  ? { served_unit_conflicts: served.conflicts }
                  : {}),
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`Rendered ${opts.out} (${html.length} bytes${findings.length ? `; ${findings.length} finding(s) overridden` : ''})`);
        }
      });
    });

  report
    .command('battery')
    .description(
      'Pull the Monthly Performance Report Max figure battery for one Seller Central account. ' +
        `The battery runs inside the MixShift service (named query ${BATTERY_QUERY_ID}) and returns one ` +
        'JSON document: data-aligned windows, account ads + retail per period with derived ratios, ' +
        'dark-day normalization, the settled-window efficiency check, daily series, sub-brand splits, ' +
        'ASIN movers + reconciliation, out-of-stock days, page-view-weighted Buy Box by item, and ' +
        '15-month history. A section that fails server-side is named under sections_failed and the ' +
        'rest still serves; only a call that yields no document at all (service not deployed yet, a ' +
        'timeout, a network drop) fails. Large accounts can take a few minutes. Exit 0 = document ' +
        'written (or printed with --out -), 1 = no document.',
    )
    .requiredOption('--seller-id <id>', 'MixShift SellerID of the Seller Central account row')
    .option(
      '--as-of <date>',
      'YYYY-MM-DD; windows still clamp to the data load date (default: today, local time)',
    )
    .option(
      '--brands <list>',
      'comma-separated sub-brand names as they appear in campaign names; enables the paid split',
    )
    .option(
      '--min-item-sales <n>',
      "sales floor for the Buy Box table (default: the account's median item revenue in the current window)",
    )
    .option('--buybox-floor <pct>', 'page-view-weighted Buy Box attention floor, percent', '92')
    .option(
      '--buybox-drop <pts>',
      'month-over-month drop in weighted Buy Box points that flags an item even above the floor',
      '5',
    )
    .option('--out <path>', 'write the figures document here; "-" prints it to stdout instead', 'figures.json')
    .option('--timeout <seconds>', 'per-statement query timeout on the service, seconds (max 120)', '60')
    .action(async (opts: BatteryOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await withReportErrorHandling(!!root.json, async () => {
        const params = batteryParams(opts);
        const outPath = resolveBatteryOut(opts.out);
        const result = await runDispatched<Record<string, unknown>>(BATTERY_QUERY_ID, {
          params,
          // Seller scope rides inside params for the battery; echoing it as the
          // request's top-level scope keeps the call shaped like every other
          // named query for gateway-side attribution. The service ignores it.
          sellerIds: [params.seller_id as number],
          queryTimeoutMs: batteryInt(opts.timeout, '--timeout', 1, 120) * 1_000,
          httpTimeoutMs: BATTERY_HTTP_TIMEOUT_MS,
        });
        if (!result.ok) throw batteryFailure(result.failure);
        const doc = assertBatteryDocument(result.rows[0]);
        const body = JSON.stringify(doc, null, 2);
        if (outPath) await writeReportOutput(outPath, body + '\n');
        if (root.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                out: outPath ?? null,
                revision: result.revision ?? null,
                sections_failed: doc.sections_failed ?? {},
                reconciliation: doc.reconciliation ?? null,
                ...(outPath ? {} : { figures: doc }),
              },
              null,
              2,
            ),
          );
        } else if (!outPath) {
          console.log(body);
        } else {
          for (const line of batterySummary(outPath, doc)) console.log(line);
        }
      });
    });
}

/** The pack battery id behind `report battery`. Append-only wire contract:
 *  a breaking change to its params or document ships as a new id. */
export const BATTERY_QUERY_ID = 'MPRX-FIGURES-01';

/** HTTP budget for one battery call: the service bounds a battery at 280s of
 *  response time (its wall-clock budget is sized from the statement timeout
 *  and the pool acquire, and checked before every statement), so the client
 *  waits a little longer than that rather than the single-statement default
 *  of queryTimeoutMs + 5s. */
export const BATTERY_HTTP_TIMEOUT_MS = 290_000;

/** Keys every battery document carries; their absence means this plugin build
 *  and the service disagree on the battery's shape, and the file must not be
 *  composed from. */
export const BATTERY_DOCUMENT_KEYS = ['windows', 'thresholds_applied', 'sections_failed', 'reconciliation'] as const;

/** Failure kinds the service is known to answer with. The kind becomes the
 *  telemetry error class, so anything outside this set folds to `unknown`
 *  to keep the class bounded. */
const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'access_denied_table',
  'access_denied_db',
  'unknown_table',
  'syntax_error',
  'timeout',
  'host_unreachable',
  'too_many_rows',
  'response_too_large',
  'busy',
  'unknown_query',
  'bad_params',
  'missing_params',
  'unknown',
]);

interface BatteryOptions {
  sellerId: string;
  asOf?: string;
  brands?: string;
  minItemSales?: string;
  buyboxFloor: string;
  buyboxDrop: string;
  out: string;
  timeout: string;
}

/** `-` means stdout (the script's `--out -`); anything else is a path. */
export function resolveBatteryOut(out: string): string | undefined {
  return out === '-' ? undefined : out;
}

function batteryInt(raw: string, flag: string, min: number, max?: number): number {
  const n = Number(raw);
  if (
    !/^-?\d+$/.test(raw.trim()) ||
    !Number.isSafeInteger(n) ||
    n < min ||
    (max !== undefined && n > max)
  ) {
    throw new UserFacingError(
      `${flag} must be an integer${max !== undefined ? ` between ${min} and ${max}` : ` >= ${min}`}, got "${raw}".`,
      'report_battery_bad_flag',
    );
  }
  return n;
}

function batteryNumber(raw: string, flag: string): number {
  const n = Number(raw);
  // Decimal digits only: Number() would also accept hex, exponents and
  // whitespace-padded input, none of which is a percentage anyone typed.
  if (!/^\d+(\.\d+)?$/.test(raw.trim()) || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new UserFacingError(`${flag} must be a number between 0 and 100, got "${raw}".`, 'report_battery_bad_flag');
  }
  return n;
}

function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Today on the operator's clock, as the script defaulted it: the month-end
 *  run must not roll into next month because the service lives in UTC. */
function localToday(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** Translate the flags into the battery's params. The service validates the
 *  same values again and answers bad_params; this pass exists so a typo is a
 *  clean local error before any call is made. */
export function batteryParams(opts: BatteryOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    seller_id: batteryInt(opts.sellerId, '--seller-id', 1),
    as_of: opts.asOf ?? localToday(),
    brands: (opts.brands ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b.length > 0),
    buybox_floor: batteryNumber(opts.buyboxFloor, '--buybox-floor'),
    buybox_drop: batteryNumber(opts.buyboxDrop, '--buybox-drop'),
  };
  if (!isCalendarDate(params.as_of as string)) {
    throw new UserFacingError(`--as-of must be a calendar date as YYYY-MM-DD, got "${opts.asOf}".`, 'report_battery_bad_flag');
  }
  if (opts.minItemSales !== undefined) {
    params.min_item_sales = batteryInt(opts.minItemSales, '--min-item-sales', 0);
  }
  return params;
}

/** Map a dispatcher failure to the user-facing error. The client's own HTTP
 *  budget expiring is classified host_unreachable by the transport (an abort
 *  looks like a dead host); for the battery, which legitimately runs for
 *  minutes, that is a timeout and must not read as a connectivity problem or
 *  land in the connectivity telemetry bucket. */
export function batteryFailure(failure: DataQueryFailure): UserFacingError {
  if (failure.kind === 'host_unreachable' && (failure.durationMs ?? 0) >= BATTERY_HTTP_TIMEOUT_MS - 5_000) {
    return new UserFacingError(
      `The figure battery did not answer within ${Math.round(BATTERY_HTTP_TIMEOUT_MS / 1000)}s. Retry once; ` +
        'if it repeats, report it with `mixshift feedback` and label the gap in the method notes. ' +
        `(${BATTERY_QUERY_ID}: client_timeout)`,
      'report_battery_timeout',
    );
  }
  const kind = KNOWN_FAILURE_KINDS.has(failure.kind) ? failure.kind : 'unknown';
  return new UserFacingError(`${failure.friendly} (${BATTERY_QUERY_ID}: ${failure.kind})`, `report_battery_${kind}`);
}

/** The battery answers as ONE row that IS the document. Anything else (an
 *  empty envelope, a wrapped or stringified document, an array row) must not
 *  be written to figures.json, where it would look like a complete pull with
 *  nothing in it. */
export function assertBatteryDocument(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new UserFacingError(
      `The service returned no figures document for ${BATTERY_QUERY_ID}. Retry; if it persists, report it.`,
      'report_battery_empty',
    );
  }
  const doc = row as Record<string, unknown>;
  const missing = BATTERY_DOCUMENT_KEYS.filter((k) => !(k in doc));
  if (missing.length > 0) {
    throw new UserFacingError(
      `The ${BATTERY_QUERY_ID} document is missing ${missing.join(', ')}: this plugin build and the service ` +
        'disagree on the battery shape. Update the plugin or wait for the service deploy; do not compose from this call.',
      'report_battery_bad_document',
    );
  }
  return doc;
}

/** The same closing lines the shipped script printed after `--out`, so a
 *  reader of the terminal still sees the reconciliation, every failed
 *  section, and every dark ad day without opening the file. Numbers may
 *  arrive as DECIMAL strings; coerce before formatting. */
export function batterySummary(out: string, doc: Record<string, unknown>): string[] {
  const money = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return 'n/a';
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : 'n/a';
  };
  const lines = [`wrote ${out}`];
  const rec = (doc.reconciliation ?? {}) as Record<string, unknown>;
  lines.push(
    `reconciliation: account ${money(rec.account_ops)} vs SKU sum ${money(rec.sku_sum)} (${rec.gap_pct ?? null}%)`,
  );
  const failed = (doc.sections_failed ?? {}) as Record<string, string>;
  for (const [name, why] of Object.entries(failed)) {
    lines.push(`SECTION FAILED (brief runs without it, label the gap): ${name}: ${String(why).slice(0, 140)}`);
  }
  const dark = (doc.dark_days ?? {}) as Record<string, { zero_spend_days?: string[]; normalization_factor?: number | null }>;
  for (const [k, v] of Object.entries(dark)) {
    if (v && Array.isArray(v.zero_spend_days) && v.zero_spend_days.length > 0) {
      lines.push(`dark ad days in ${k}: ${v.zero_spend_days.join(', ')} (normalize by ${v.normalization_factor})`);
    }
  }
  return lines;
}
