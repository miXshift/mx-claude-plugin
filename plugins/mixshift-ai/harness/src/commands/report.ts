import type { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { validateReportData, type Finding, type ReportDataDocument } from '../lib/report-contract/validate.js';
import { extractFigures, checkFigures } from '../lib/report-contract/extract.js';
import { renderMonthlyReport, type RenderReportDataDocument } from '../lib/report-contract/render-report.js';
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

interface RootOptions {
  json?: boolean;
}

interface FileResult {
  file: string;
  findings: Finding[];
}

export function registerReportCommands(program: Command): void {
  const report = program
    .command('report')
    .description('Report-contract tools: validate typed report-data documents at the render seam.');

  report
    .command('validate <files...>')
    .description(
      'Run the report-contract validators (BASIS-1..UNIT-1) over one or more report-data.json ' +
        'documents. Exit 0 = all clean, 1 = findings.',
    )
    .action(async (files: string[], _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const results: FileResult[] = [];
      for (const file of files) {
        const doc = await readJson<ReportDataDocument>(file);
        results.push({ file, findings: validateReportData(doc) });
      }
      const total = results.reduce((n, r) => n + r.findings.length, 0);
      if (root.json) {
        console.log(JSON.stringify({ ok: total === 0, total, results }, null, 2));
      } else {
        for (const r of results) {
          console.log(`\n${r.file}: ${r.findings.length === 0 ? 'CLEAN' : `${r.findings.length} finding(s)`}`);
          for (const f of r.findings) {
            console.log(`  [${f.rule}] ${f.subject} -- ${f.detail}`);
          }
        }
        console.log(`\n${total === 0 ? 'PASS' : `FAIL: ${total} finding(s)`}`);
      }
      process.exitCode = total === 0 ? 0 : 1;
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
    .action(async (file: string, opts: { out?: string; check: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const response = await readJson<unknown>(file);
      const doc = extractFigures(response);
      const findings = opts.check ? checkFigures(doc) : [];
      const body = JSON.stringify(doc, null, 2);
      if (opts.out) {
        await writeFile(opts.out, body + '\n', 'utf8');
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

  report
    .command('render <report-data.json>')
    .description(
      'Render a validated report-data document to self-contained HTML via the ' +
        'deterministic renderer. Refuses to render a document that fails validation ' +
        'unless --force is given.',
    )
    .requiredOption('--out <path>', 'write the HTML artifact here')
    .option('--force', 'render even when the document has validator findings', false)
    .action(async (file: string, opts: { out: string; force: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
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
      const html = renderMonthlyReport(doc);
      await writeFile(opts.out, html, 'utf8');
      if (root.json) {
        console.log(JSON.stringify({ ok: true, out: opts.out, bytes: html.length, findings }, null, 2));
      } else {
        console.log(`Rendered ${opts.out} (${html.length} bytes${findings.length ? `; ${findings.length} finding(s) overridden` : ''})`);
      }
    });
}
