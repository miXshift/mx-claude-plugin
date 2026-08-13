/**
 * Command-level tests for `mixshift report ...`, covering the red-team
 * fixes that live in this file rather than in report-contract/*.ts itself:
 *
 *   F8  `report validate` used to abort the whole file list (no output at
 *       all) the moment ONE file in the middle was unreadable. Now every
 *       file gets its own result and an unreadable file no longer erases
 *       the findings already computed for its neighbors. Exit code 2 when
 *       any file was unreadable (wins over 1 when findings ALSO exist).
 *   F9  `--json` used to let a thrown UserFacingError fall through to
 *       cli.ts's top-level catch, which always prints PLAIN TEXT regardless
 *       of --json. Every report command now emits the standard
 *       `{status:'error', error_class, message}` envelope on --json instead.
 *   F10 `--out` into a not-yet-existing directory used to throw a raw
 *       ENOENT; the parent directory is now created first, and a residual
 *       write failure is reclassified as `report_out_unwritable`.
 *   (F7 door) `report render` refuses when untagged prose carries forecast
 *       vocabulary and the document's forecast isn't provided-current
 *       (`scanForecastVocabulary`, render-report.ts), mirroring the
 *       existing validation-refusal pattern; `--force` overrides both.
 *
 * Real filesystem, real commander dispatch (no mocks) -- these are cheap,
 * pure-JSON operations with no network/credentials involved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerReportCommands } from './report.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false);
  registerReportCommands(program);
  return program;
}

async function runCli(opts: { json?: boolean }, ...args: string[]): Promise<void> {
  const globalArgs = opts.json ? ['--json'] : [];
  await buildProgram().parseAsync(['node', 'mixshift', ...globalArgs, 'report', ...args]);
}

let dir: string;
let stdoutChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  stdoutChunks = [];
  // report.ts logs via console.log (one complete string per call, always
  // JSON.stringify'd whole in --json mode), so spy there directly rather
  // than on process.stdout.write.
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdoutChunks.push(args.map(String).join(' '));
  });
  dir = await mkdtemp(join(tmpdir(), 'mx-report-cmd-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const stdoutText = (): string => stdoutChunks.join('\n');

async function writeJsonFile(name: string, data: unknown): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(data), 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// F8: per-file continuation + exit code 2 on any unreadable file
// ---------------------------------------------------------------------------

describe('report validate -- per-file continuation on an unreadable file (F8)', () => {
  it('still prints every readable file\'s result when a later file is unreadable, text mode', async () => {
    const clean = await writeJsonFile('clean.json', {});
    const withFindings = await writeJsonFile('findings.json', { figures: [{ id: 'f.a', label: 'A' }] });
    const missing = join(dir, 'does-not-exist.json');
    await runCli({}, 'validate', clean, withFindings, missing);
    const text = stdoutText();
    // Both readable files' results made it to output -- the old bug threw
    // out of the loop before EITHER printed.
    expect(text).toContain(`${clean}: CLEAN`);
    expect(text).toContain(`${withFindings}: 1 finding(s)`);
    expect(text).toContain('UNREADABLE');
    expect(process.exitCode).toBe(2); // unreadable wins over the 1 finding
  });

  it('reports each file as its own JSON result entry ({file, error}) instead of aborting, --json mode', async () => {
    const clean = await writeJsonFile('clean.json', {});
    const missing = join(dir, 'nope.json');
    await runCli({ json: true }, 'validate', clean, missing);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toMatchObject({ file: clean, findings: [] });
    expect(parsed.results[1].file).toBe(missing);
    expect(typeof parsed.results[1].error).toBe('string');
    expect(parsed.unreadable).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it('exit code 1 (not 2) when every file is readable and only findings are present', async () => {
    const withFindings = await writeJsonFile('findings.json', { figures: [{ id: 'f.a', label: 'A' }] });
    await runCli({}, 'validate', withFindings);
    expect(process.exitCode).toBe(1);
  });

  it('exit code 0 when every file is readable and clean', async () => {
    const clean = await writeJsonFile('clean.json', {});
    await runCli({}, 'validate', clean);
    expect(process.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F9: --json emits a structured error envelope on every failure path
// ---------------------------------------------------------------------------

describe('--json emits {status:"error", error_class, message} on a thrown UserFacingError (F9)', () => {
  it('report extract on an unreadable input file', async () => {
    const missing = join(dir, 'nope.json');
    await runCli({ json: true }, 'extract', missing);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_data_unreadable');
    expect(typeof parsed.message).toBe('string');
    expect(process.exitCode).toBe(1);
  });

  it('report render refuses a document with validator findings and reports report_data_invalid', async () => {
    const bad = await writeJsonFile('bad.json', { figures: [{ id: 'f.a', label: 'A' }] }); // no source_path -> TRACE-1
    const out = join(dir, 'out.html');
    await runCli({ json: true }, 'render', bad, '--out', out);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_data_invalid');
    expect(process.exitCode).toBe(1);
  });

  it('non-json mode still throws bare (cli.ts\'s own top-level catch owns text output)', async () => {
    const missing = join(dir, 'nope.json');
    await expect(runCli({}, 'extract', missing)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F10: --out mkdirs its parent; a genuine write failure is reclassified
// ---------------------------------------------------------------------------

describe('--out creates its parent directory before writing (F10)', () => {
  it('report extract --out into a not-yet-existing nested directory succeeds', async () => {
    const input = await writeJsonFile('envelope.json', { envelope: { bridgeDomain: 'ops', metrics: [], insights: [] } });
    const out = join(dir, 'a', 'b', 'c', 'figures.json');
    await runCli({}, 'extract', input, '--out', out);
    expect(process.exitCode).toBe(0);
    const written = await readFile(out, 'utf8');
    expect(() => JSON.parse(written)).not.toThrow();
  });

  it('report render --out into a not-yet-existing nested directory succeeds', async () => {
    const doc = await writeJsonFile('golden.json', {
      figures: [{ id: 'f.a', label: 'A', value: 10, unit: 'count', basis: 'b', source_path: 'envelope:x' }],
      sections: [{ id: 'sec.a', figure_refs: ['f.a'] }],
    });
    const out = join(dir, 'nested', 'report.html');
    await runCli({}, 'render', doc, '--out', out);
    // report.ts's render action never sets process.exitCode on success
    // (unlike validate/extract) -- absence of a nonzero code IS success.
    expect(process.exitCode).toBeUndefined();
    const html = await readFile(out, 'utf8');
    expect(html).toContain('<html');
  });

  it('a residual write failure (parent path collides with an existing FILE) is classified report_out_unwritable, --json mode', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const input = await writeJsonFile('envelope.json', { envelope: { bridgeDomain: 'ops', metrics: [], insights: [] } });
    const out = join(blocker, 'figures.json'); // dirname(out) === blocker, which is a FILE
    await runCli({ json: true }, 'extract', input, '--out', out);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_out_unwritable');
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F7 door: report render refuses untagged forecast vocabulary
// ---------------------------------------------------------------------------

describe('report render refuses untagged forecast vocabulary when the forecast is not provided-current', () => {
  function forecastDoc(extra: Record<string, unknown> = {}) {
    return {
      figures: [{ id: 'f.a', label: 'A', value: 100, unit: 'currency', basis: 'b', source_path: 'envelope:x' }],
      sections: [
        { id: 'sec.a', figure_refs: ['f.a'], display_text: 'Revenue is projected to grow next month.' },
      ],
      ...extra,
    };
  }

  it('refuses (report_forecast_vocabulary) when the document has no provided-current forecast, --json mode', async () => {
    const doc = await writeJsonFile('forecast.json', forecastDoc());
    const out = join(dir, 'out.html');
    await runCli({ json: true }, 'render', doc, '--out', out);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_forecast_vocabulary');
    expect(parsed.message).toContain('sec.a');
    expect(process.exitCode).toBe(1);
  });

  it('--force overrides the forecast-vocabulary refusal', async () => {
    const doc = await writeJsonFile('forecast.json', forecastDoc());
    const out = join(dir, 'out.html');
    await runCli({}, 'render', doc, '--out', out, '--force');
    expect(process.exitCode).toBeUndefined(); // render sets no exitCode on success
    const html = await readFile(out, 'utf8');
    expect(html).toContain('projected to grow');
  });

  it('renders cleanly when the document declares its forecast provided-current', async () => {
    const doc = await writeJsonFile('forecast.json', forecastDoc({ forecast: { state: 'provided_current' } }));
    const out = join(dir, 'out.html');
    await runCli({}, 'render', doc, '--out', out);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not refuse on a section explicitly tagged kind: "forecast" (opt-in suppression stays as-is)', async () => {
    const doc = await writeJsonFile('forecast.json', {
      figures: forecastDoc().figures,
      sections: [{ id: 'sec.fc', kind: 'forecast', figure_refs: ['f.a'], display_text: 'Ahead of forecast.' }],
    });
    const out = join(dir, 'out.html');
    await runCli({}, 'render', doc, '--out', out);
    expect(process.exitCode).toBeUndefined();
    const html = await readFile(out, 'utf8');
    // The tagged section is suppressed at render (existing behavior), and
    // the scan doesn't refuse on its account either.
    expect(html).not.toContain('Ahead of forecast');
  });
});
