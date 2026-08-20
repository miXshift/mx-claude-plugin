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
import { COMPOSITE_SELECTIONS } from '../lib/report-contract/extract.js';

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

// ---------------------------------------------------------------------------
// Composite bundle guard: `report extract` on an INS-MONTHLY-01 composite
// (extract.ts's isCompositeResponse / CompositeSelectionError / --select)
// ---------------------------------------------------------------------------

function compositeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    mom: {
      ops: {
        bridgeDomain: 'ops',
        bridgeRunId: 'run-cmd-ops-0001',
        currency: 'USD',
        caveats: [],
        metrics: [{ metricKey: 'ops', totals: { p1: 100, p2: 150, delta: 50, pctChange: 0.5 }, topDrivers: [] }],
        insights: [],
      },
      ads: {
        bridgeDomain: 'ads',
        bridgeRunId: 'run-cmd-ads-0001',
        currency: 'USD',
        caveats: [],
        metrics: [],
        insights: [],
      },
    },
    yoy: null,
    headline: {},
    limitations: [],
    meta: {},
    ...overrides,
  };
}

describe('report extract -- composite bundle guard (INS-MONTHLY-01 mom/yoy unwrapping)', () => {
  it('a composite without --select rejects with the guidance message, text mode', async () => {
    const composite = await writeJsonFile('composite.json', compositeFixture());
    await expect(runCli({}, 'extract', composite)).rejects.toThrow(/composite run bundle/i);
  });

  it('a composite without --select emits report_composite_unselected, --json mode', async () => {
    const composite = await writeJsonFile('composite.json', compositeFixture());
    await runCli({ json: true }, 'extract', composite);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_composite_unselected');
    expect(parsed.message).toContain('--select');
    for (const choice of COMPOSITE_SELECTIONS) {
      expect(parsed.message).toContain(choice);
    }
    expect(process.exitCode).toBe(1);
  });

  it('a composite with a valid --select succeeds and extracts figures, --json mode', async () => {
    const composite = await writeJsonFile('composite.json', compositeFixture());
    await runCli({ json: true }, 'extract', composite, '--select', 'mom.ops');
    const parsed = JSON.parse(stdoutText());
    expect(parsed.ok).toBe(true);
    expect(parsed.figures).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });

  it('an unknown --select value fails with report_bad_selection, --json mode', async () => {
    const anyFile = await writeJsonFile('whatever.json', {});
    await runCli({ json: true }, 'extract', anyFile, '--select', 'bogus.selection');
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.error_class).toBe('report_bad_selection');
    expect(process.exitCode).toBe(1);
  });

  it('CLI end to end: report extract <composite> --select yoy.ops --check succeeds and its ids are yoy-prefixed', async () => {
    const composite = await writeJsonFile(
      'composite-yoy.json',
      compositeFixture({
        yoy: {
          ops: {
            bridgeDomain: 'ops',
            bridgeRunId: 'run-cmd-yoy-0001',
            currency: 'USD',
            caveats: [],
            metrics: [{ metricKey: 'ops', totals: { p1: 90, p2: 150, delta: 60, pctChange: 0.667 }, topDrivers: [] }],
            insights: [],
          },
        },
      }),
    );
    const out = join(dir, 'figures.yoy.ops.json');
    await runCli({}, 'extract', composite, '--select', 'yoy.ops', '--check', '--out', out);
    expect(process.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(out, 'utf8'));
    expect(doc.source.selection).toBe('yoy.ops');
    const ids: string[] = doc.figures.map((fg: { id: string }) => fg.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('yoy.')).toBe(true);
    expect(ids).toContain('yoy.ops.ops.p1');
    expect(ids).toContain('yoy.ops.ops.delta');
    // never the bare, unprefixed shape a single-response extraction would emit
    expect(ids).not.toContain('ops.ops.p1');
  });
});

// ---------------------------------------------------------------------------
// Served-unit sidecar discovery (fix round 2). `report validate` / `render`
// read `report extract` output beside the document so UNIT-2's contract arm
// survives the model-authored assembly seam. Auto-discovery is implicit
// filesystem behaviour on a user-facing command, so its failure modes are the
// point of these tests: a stray or stale file must not be able to block a
// correct render, and a typo must not silently switch the check off.
// ---------------------------------------------------------------------------

describe('report validate -- served-unit sidecar discovery', () => {
  /** A minimal document whose one figure carries NO served_unit, exactly as a
   *  model-composed report-data.json does. */
  const docWith = (unit: string) => ({
    figures: [
      {
        id: 'mom.ops.ops.p2',
        label: 'Revenue',
        value: 1000,
        unit,
        basis: 'ordered_revenue',
        source_path: 'envelope:metrics[0].totals.p2',
      },
    ],
  });
  const sidecar = (servedUnit: string) => ({
    figures: [{ id: 'mom.ops.ops.p2', served_unit: servedUnit }],
  });

  it('catches a relabelled unit that the document alone cannot reveal', async () => {
    const doc = await writeJsonFile('report-data.json', docWith('count'));
    await writeJsonFile('figures.mom.ops.json', sidecar('currency'));
    await runCli({}, 'validate', doc);
    expect(stdoutText()).toContain("contradicts the served contract 'currency'");
    expect(process.exitCode).toBe(1);
  });

  it('names the sidecar in the finding, so the operator is not sent to debug a correct file', async () => {
    const doc = await writeJsonFile('report-data.json', docWith('count'));
    const side = await writeJsonFile('figures.mom.ops.json', sidecar('currency'));
    await runCli({}, 'validate', doc);
    // The contradicting value appears NOWHERE in report-data.json.
    expect(stdoutText()).toContain(side);
  });

  it('drops a figure whose sidecars DISAGREE instead of letting filename sort order decide', async () => {
    // One of these is from another run/brand/month. Neither is trustworthy,
    // and last-alphabetical-wins would silently block a correct document.
    const doc = await writeJsonFile('report-data.json', docWith('currency'));
    await writeJsonFile('figures.aaa.json', sidecar('currency'));
    await writeJsonFile('figures.zzz.json', sidecar('count'));
    await runCli({}, 'validate', doc);
    expect(stdoutText()).not.toContain('contradicts the served contract');
    expect(process.exitCode).toBe(0);
  });

  it('--no-figures ignores the directory entirely', async () => {
    const doc = await writeJsonFile('report-data.json', docWith('count'));
    await writeJsonFile('figures.mom.ops.json', sidecar('currency'));
    await runCli({}, 'validate', doc, '--no-figures');
    expect(stdoutText()).not.toContain('contradicts the served contract');
    expect(process.exitCode).toBe(0);
  });

  it('ERRORS on an unreadable --figures path rather than silently switching the check off', async () => {
    // Failing open here means one typo voids the served-unit check and the
    // run reports CLEAN -- on the exact check that exists to catch a wrong unit.
    const doc = await writeJsonFile('report-data.json', docWith('count'));
    await runCli({}, 'validate', doc, '--figures', join(dir, 'typo.json'));
    expect(stdoutText()).not.toContain(': CLEAN');
    expect(process.exitCode).not.toBe(0);
  });

  it('ignores a well-formed stray file that carries no served units at all', async () => {
    const doc = await writeJsonFile('report-data.json', docWith('currency'));
    await writeJsonFile('figures-notes.json', { figures: [{ id: 'mom.ops.ops.p2' }] });
    await runCli({}, 'validate', doc);
    expect(process.exitCode).toBe(0);
  });
});
