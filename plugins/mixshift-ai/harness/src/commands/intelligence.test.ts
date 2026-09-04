/**
 * Command-level tests for `mixshift intelligence ...`.
 *
 * The Intelligence CLIENT functions (catalog/run/pollRun/getRunResult) are
 * mocked (no network, no credentials); commander parsing, the action
 * handlers, the local run ledger (lib/intelligence/ledger.ts), and the
 * artifact-write two-tier output run for real against an isolated
 * --data-dir. Telemetry's track() is stubbed so nothing touches the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { registerIntelligenceCommands } from './intelligence.js';
import {
  catalog,
  run,
  pollRun,
  getRunResult,
  type InsightResult,
  type RunAcceptedResult,
} from '../lib/intelligence/client.js';
import { listIntelligenceRuns } from '../lib/intelligence/ledger.js';

vi.mock('../lib/intelligence/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/intelligence/client.js')>();
  return {
    ...actual, // keep isAccepted / isIntelligenceFailure / exitCodeForKind real
    catalog: vi.fn(),
    run: vi.fn(),
    pollRun: vi.fn(),
    getRunResult: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function insightResult(overrides: Partial<InsightResult> = {}): InsightResult {
  return {
    ok: true,
    momOpsDelta: 1234.5,
    momOpsDeltaPct: 4.2,
    limitations: ['partial ads coverage'],
    meta: {
      insightId: 'INS-OPS-BRIDGE-01',
      revision: 'r7',
      engineSha: 'abc123',
      methodologyVersion: '1.0',
      computedAt: '2026-07-27T10:00:00Z',
      cache: { hit: false },
    },
    ...overrides,
  };
}

function acceptedResult(overrides: Partial<RunAcceptedResult> = {}): RunAcceptedResult {
  return { ok: true, accepted: true, runId: 'run-9', status: 'IN_QUEUE', ...overrides };
}

/** Mirror the cli.ts wiring: intelligence is a TOP-level command group. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw CommanderError instead of process.exit
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerIntelligenceCommands(program);
  return program;
}

async function runCli(
  opts: { dataDir: string; json?: boolean },
  ...args: string[]
): Promise<void> {
  const globalArgs = ['--data-dir', opts.dataDir, ...(opts.json ? ['--json'] : [])];
  await buildProgram().parseAsync(['node', 'mixshift', ...globalArgs, 'intelligence', ...args]);
}

let dataDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
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
  dataDir = await mkdtemp(join(tmpdir(), 'mx-intelligence-cmd-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

describe('command registration', () => {
  it('registers catalog, run, poll, get, runs as intelligence subcommands', () => {
    const program = buildProgram();
    const intelligence = program.commands.find((c) => c.name() === 'intelligence');
    expect(intelligence).toBeDefined();
    const names = intelligence!.commands.map((c) => c.name());
    expect(names).toEqual(['catalog', 'run', 'poll', 'get', 'runs']);
  });
});

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

describe('intelligence catalog', () => {
  it('renders entries in human mode', async () => {
    vi.mocked(catalog).mockResolvedValue({
      ok: true,
      entries: [
        { id: 'INS-MONTHLY-01', version: '2.0.0', revision: 'r5', purpose: 'Monthly bundle', status: 'active' },
      ],
    });
    await runCli({ dataDir }, 'catalog');
    expect(stdoutText()).toContain('INS-MONTHLY-01');
    expect(stdoutText()).toContain('Monthly bundle');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('emits raw entries under --json', async () => {
    vi.mocked(catalog).mockResolvedValue({
      ok: true,
      entries: [{ id: 'INS-DUO-01', version: '1.0.0', revision: 'r1', purpose: 'p', status: 'active' }],
    });
    await runCli({ dataDir, json: true }, 'catalog');
    const parsed = JSON.parse(stdoutText());
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toHaveLength(1);
  });

  it('maps a catalog failure to a non-zero exit with the friendly message', async () => {
    vi.mocked(catalog).mockResolvedValue({
      ok: false,
      kind: 'not_enrolled',
      friendly: "This account isn't enrolled.",
    });
    await runCli({ dataDir }, 'catalog');
    expect(process.exitCode).toBe(3);
    expect(stderrText()).toContain("isn't enrolled");
    expect(stderrText()).toContain('switched off for this account');
  });
});

// ---------------------------------------------------------------------------
// run — params flag wiring
// ---------------------------------------------------------------------------

describe('intelligence run — params flags', () => {
  it('fails through the action guard when neither --params nor --params-file is given', async () => {
    await runCli({ dataDir }, 'run', 'INS-OPS-BRIDGE-01');
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('No params supplied');
  });

  it('rejects --params combined with --params-file', async () => {
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      '{}',
      '--params-file',
      join(dataDir, 'nope.json'),
    );
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('not both');
  });

  it('rejects malformed JSON in --params', async () => {
    await runCli({ dataDir }, 'run', 'INS-OPS-BRIDGE-01', '--params', '{not json');
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('valid JSON');
  });

  it('parses inline --params and forwards {id, params} verbatim to the client', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      JSON.stringify({ merchant: { brand: 'acme' }, period: { preset: 'last_complete_month' } }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.mocked(run).mock.calls[0]![0]).toEqual({
      id: 'INS-OPS-BRIDGE-01',
      params: { merchant: { brand: 'acme' }, period: { preset: 'last_complete_month' } },
    });
  });
});

// ---------------------------------------------------------------------------
// run — sync two-tier output
// ---------------------------------------------------------------------------

describe('intelligence run — sync two-tier output', () => {
  it('never dumps the full payload inline in human mode; writes it to an artifact file instead', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      JSON.stringify({ merchant: { brand: 'acme' } }),
    );
    expect(process.exitCode).toBe(exitCodeBefore);
    const out = stdoutText();
    expect(out).toContain('INS-OPS-BRIDGE-01');
    expect(out).toContain('Full result:');
    // The raw envelope's JSON key syntax must never land on stdout unquoted
    // in human mode — only the compact headline does.
    expect(out).not.toContain('"limitations"');
    expect(out).not.toContain('"meta"');

    const pathLine = out.split('\n').find((l) => l.startsWith('Full result:'))!;
    const artifactPath = pathLine.replace('Full result:', '').trim();
    // Brand context was present (merchant.brand: 'acme') -> the brand-scoped
    // runs/intelligence/ path, not the flat fallback.
    expect(artifactPath).toContain(join('clients', 'acme', 'runs', 'intelligence'));
    const written = JSON.parse(await readFile(artifactPath, 'utf8'));
    expect(written.momOpsDelta).toBe(1234.5);
    expect(written.meta.insightId).toBe('INS-OPS-BRIDGE-01');
  });

  it('falls back to the flat <dataDir>/intelligence/ path when no brand is resolvable', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      JSON.stringify({ merchant: { sellerId: 'A1', marketplaceId: 'ATVPDKIKX0DER' } }),
    );
    const out = stdoutText();
    const pathLine = out.split('\n').find((l) => l.startsWith('Full result:'))!;
    const artifactPath = pathLine.replace('Full result:', '').trim();
    expect(artifactPath).toContain(join(dataDir, 'intelligence'));
    expect(artifactPath).not.toContain('clients');
  });

  it('honors --out for the artifact path', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    const outPath = join(dataDir, 'custom.json');
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      '{}',
      '--out',
      outPath,
    );
    const out = stdoutText();
    expect(out).toContain(`Full result: ${outPath}`);
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    expect(written.ok).toBe(true);
  });

  it('dumps the full envelope inline (plus artifact_path) under --json, and still writes the file', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli({ dataDir, json: true }, 'run', 'INS-OPS-BRIDGE-01', '--params', '{}');
    const parsed = JSON.parse(stdoutText());
    expect(parsed.momOpsDelta).toBe(1234.5);
    expect(parsed.meta.insightId).toBe('INS-OPS-BRIDGE-01');
    expect(typeof parsed.artifact_path).toBe('string');
    const written = JSON.parse(await readFile(parsed.artifact_path, 'utf8'));
    expect(written.momOpsDelta).toBe(1234.5);
  });
});

// ---------------------------------------------------------------------------
// run / get — brand slug sanitization (path traversal defense)
//
// params.merchant.brand is caller-supplied and feeds both the local ledger
// and intelligenceOutputPath's brand-scoped artifact directory
// (clients/<brand>/runs/intelligence/...). A value that isn't a real brand
// slug — a traversal attempt, an embedded separator — must never reach
// path.join(); it should just fall back to the flat (no-brand) artifact
// path instead of erroring the run.
// ---------------------------------------------------------------------------

describe('intelligence run/get — brand slug sanitization', () => {
  it('falls back to the flat path when merchant.brand is a path-traversal attempt', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      JSON.stringify({ merchant: { brand: '../../evil' } }),
    );
    const out = stdoutText();
    const pathLine = out.split('\n').find((l) => l.startsWith('Full result:'))!;
    const artifactPath = resolve(pathLine.replace('Full result:', '').trim());
    expect(artifactPath.startsWith(resolve(dataDir))).toBe(true);
    expect(artifactPath).not.toContain('clients');
    const written = JSON.parse(await readFile(artifactPath, 'utf8'));
    expect(written.ok).toBe(true);
  });

  it('falls back to the flat path when merchant.brand contains a path separator', async () => {
    vi.mocked(run).mockResolvedValue(insightResult());
    await runCli(
      { dataDir },
      'run',
      'INS-OPS-BRIDGE-01',
      '--params',
      JSON.stringify({ merchant: { brand: 'a/b' } }),
    );
    const out = stdoutText();
    const pathLine = out.split('\n').find((l) => l.startsWith('Full result:'))!;
    const artifactPath = resolve(pathLine.replace('Full result:', '').trim());
    expect(artifactPath.startsWith(resolve(dataDir))).toBe(true);
    expect(artifactPath).not.toContain('clients');
  });

  it('drops an unsafe brand from the async ledger handle too, instead of recording it', async () => {
    vi.mocked(run).mockResolvedValue(acceptedResult({ runId: 'run-evil' }));
    await runCli(
      { dataDir },
      'run',
      'INS-MONTHLY-01',
      '--params',
      JSON.stringify({ merchant: { brand: '../../evil' } }),
      '--async',
    );
    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.brand).toBeUndefined();
  });

  it('get falls back to the flat path even if the ledger file itself carries an unsafe brand', async () => {
    // Simulates a hand-edited / pre-fix ledger entry — brandForRunId must
    // not trust the ledger's `brand` field verbatim.
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'intelligence-runs.json'),
      JSON.stringify([
        {
          run_id: 'run-legacy',
          insight_id: 'INS-OPS-BRIDGE-01',
          status: 'IN_QUEUE',
          brand: '../../evil',
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]),
      'utf8',
    );
    vi.mocked(getRunResult).mockResolvedValue(insightResult());
    await runCli({ dataDir }, 'get', 'run-legacy');
    const out = stdoutText();
    const pathLine = out.split('\n').find((l) => l.startsWith('Full result:'))!;
    const artifactPath = resolve(pathLine.replace('Full result:', '').trim());
    expect(artifactPath.startsWith(resolve(dataDir))).toBe(true);
    expect(artifactPath).not.toContain('clients');
  });
});

// ---------------------------------------------------------------------------
// run — async
// ---------------------------------------------------------------------------

describe('intelligence run --async', () => {
  it('merges async:true into params, records the ledger handle, and prints next steps', async () => {
    vi.mocked(run).mockResolvedValue(acceptedResult());
    await runCli(
      { dataDir },
      'run',
      'INS-MONTHLY-01',
      '--params',
      JSON.stringify({ merchant: { brand: 'acme' } }),
      '--async',
    );
    expect(vi.mocked(run).mock.calls[0]![0]).toEqual({
      id: 'INS-MONTHLY-01',
      params: { merchant: { brand: 'acme' }, async: true },
    });
    const out = stdoutText();
    expect(out).toContain('runId: run-9');
    expect(out).toContain('status: IN_QUEUE');
    expect(out).toContain('mixshift intelligence poll run-9');
    expect(out).toContain('mixshift intelligence get run-9');

    const { runs } = await listIntelligenceRuns(dataDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]!).toMatchObject({
      run_id: 'run-9',
      insight_id: 'INS-MONTHLY-01',
      status: 'IN_QUEUE',
      brand: 'acme',
    });
  });
});

// ---------------------------------------------------------------------------
// run — failure-kind mapping
// ---------------------------------------------------------------------------

describe('intelligence run — failure kinds', () => {
  it('account_too_large_use_async hints --async and exits 7', async () => {
    vi.mocked(run).mockResolvedValue({
      ok: false,
      kind: 'account_too_large_use_async',
      friendly: 'Too large to compute inline.',
    });
    await runCli({ dataDir }, 'run', 'INS-MONTHLY-01', '--params', '{}');
    expect(process.exitCode).toBe(7);
    expect(stderrText()).toContain('Too large to compute inline.');
    expect(stderrText()).toContain('--async');
  });

  it('busy hints a retry and exits 8', async () => {
    vi.mocked(run).mockResolvedValue({ ok: false, kind: 'busy', friendly: 'Engine is busy.' });
    await runCli({ dataDir }, 'run', 'INS-OPS-BRIDGE-01', '--params', '{}');
    expect(process.exitCode).toBe(8);
    expect(stderrText()).toContain('retry');
  });

  it('a JSON failure envelope carries kind + hint and no artifact is written', async () => {
    vi.mocked(run).mockResolvedValue({ ok: false, kind: 'not_enrolled', friendly: 'Switched off.' });
    await runCli({ dataDir, json: true }, 'run', 'INS-OPS-BRIDGE-01', '--params', '{}');
    const parsed = JSON.parse(stdoutText());
    expect(parsed.ok).toBe(false);
    expect(parsed.kind).toBe('not_enrolled');
    expect(parsed.hint).toContain('switched off for this account');
    expect(process.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

describe('intelligence poll', () => {
  it('reports ready:false while a run is still going, with a poll-again hint', async () => {
    vi.mocked(pollRun).mockResolvedValue({
      ok: false,
      kind: 'not_ready',
      friendly: 'Still running.',
    });
    await runCli({ dataDir }, 'poll', 'run-1');
    expect(stdoutText()).toBe(''); // failures go to stderr, not stdout
    expect(stderrText()).toContain('Still running.');
    expect(process.exitCode).toBe(10);
  });

  it('reports ready:true with a fetch hint once done', async () => {
    vi.mocked(pollRun).mockResolvedValue({ ok: true, ready: true, status: 'DONE' });
    await runCli({ dataDir }, 'poll', 'run-1');
    expect(stdoutText()).toContain('done');
    expect(stdoutText()).toContain('mixshift intelligence get run-1');
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  it('run_not_found exits 11', async () => {
    vi.mocked(pollRun).mockResolvedValue({ ok: false, kind: 'run_not_found', friendly: 'No such run.' });
    await runCli({ dataDir }, 'poll', 'run-zzz');
    expect(process.exitCode).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('intelligence get', () => {
  it('fetches a finished run and applies the same two-tier output as sync run', async () => {
    vi.mocked(getRunResult).mockResolvedValue(insightResult({ meta: { ...insightResult().meta, insightId: 'INS-ADS-BRIDGE-01' } }));
    await runCli({ dataDir }, 'get', 'run-1');
    const out = stdoutText();
    expect(out).toContain('INS-ADS-BRIDGE-01');
    expect(out).toContain('Full result:');
    expect(out).not.toContain('"meta"');
  });

  it('surfaces a not_ready failure with a poll-first hint', async () => {
    vi.mocked(getRunResult).mockResolvedValue({ ok: false, kind: 'not_ready', friendly: 'Still running.' });
    await runCli({ dataDir }, 'get', 'run-1');
    expect(stderrText()).toContain('hint:');
    expect(process.exitCode).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// runs (ledger listing)
// ---------------------------------------------------------------------------

describe('intelligence runs', () => {
  it('lists nothing recorded yet with a helpful hint', async () => {
    await runCli({ dataDir }, 'runs');
    expect(stdoutText()).toContain('No recorded Intelligence runs');
  });

  it('lists a handle recorded by a prior async run', async () => {
    vi.mocked(run).mockResolvedValue(acceptedResult({ runId: 'run-42' }));
    await runCli({ dataDir }, 'run', 'INS-LOSTSALES-01', '--params', '{}', '--async');
    await runCli({ dataDir }, 'runs');
    const out = stdoutText();
    expect(out).toContain('run-42');
    expect(out).toContain('INS-LOSTSALES-01');
  });
});
