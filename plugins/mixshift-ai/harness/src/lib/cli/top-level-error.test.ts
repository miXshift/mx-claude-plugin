/**
 * Tests for cli.ts's top-level catch (lib/cli/top-level-error.ts), mx-ops#86.
 *
 * cli.ts cannot be imported by a test (it parses the real argv and exits at
 * module scope), so these build the program the way cli.ts does (register
 * the commands, then applyExitOverride on the finished tree), parse, and hand
 * whatever escapes to handleTopLevelError with a recording io.
 *
 * Pinned: an option parser's error and commander's own usage errors land as
 * user-facing classes (never `unhandled_exception`), --json (flag-first too)
 * gets the `{status, error_class, message}` envelope on stdout and a non-zero
 * exit, telemetry names flags and shapes but never values, and --help /
 * --version still exit 0 with no output from the handler and no event.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { applyExitOverride, handleTopLevelError, type TopLevelErrorIo } from './top-level-error.js';
import { registerAdsCommands } from '../../commands/ads.js';
import { registerDataCommands } from '../../commands/data.js';
import type { TrackInput } from '../telemetry/events.js';

interface Recorded {
  stdout: string;
  stderr: string;
  events: TrackInput[];
  io: TopLevelErrorIo;
}

function recorder(): Recorded {
  const rec: Recorded = {
    stdout: '',
    stderr: '',
    events: [],
    io: {
      stdout: (t) => void (rec.stdout += t),
      stderr: (t) => void (rec.stderr += t),
      track: async (input) => void rec.events.push(input),
    },
  };
  return rec;
}

/** Built like cli.ts: root options, registration, then the override. */
function buildProgram(): Command {
  const program = new Command();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.name('mixshift').version('9.9.9').option('--json', 'emit machine-readable JSON to stdout', false);
  registerAdsCommands(program);
  registerDataCommands(program);
  applyExitOverride(program);
  return program;
}

/** Parse argv the way cli.ts does and run the catch on what escapes. */
async function run(...args: string[]): Promise<Recorded & { exitCode: number | undefined }> {
  const rec = recorder();
  const program = buildProgram();
  let exitCode: number | undefined;
  try {
    await program.parseAsync(['node', 'mixshift', ...args]);
  } catch (err) {
    exitCode = await handleTopLevelError(
      err,
      { json: program.opts<{ json?: boolean }>().json === true, argv: args },
      rec.io,
    );
  }
  return { ...rec, exitCode };
}

describe('option parser errors reach the top-level catch as invalid_argument', () => {
  it('flag-first --json: envelope on stdout, exit 1, nothing on stderr', async () => {
    const r = await run('--json', 'ads', 'call', 'op.synthetic', '--query', '{"maxResults":10}');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe('');
    const envelope = JSON.parse(r.stdout);
    expect(envelope).toEqual({
      status: 'error',
      error_class: 'invalid_argument',
      message: expect.stringContaining('--query key=value'),
    });
  });

  it('without --json: `error: <message>` on stderr, nothing on stdout', async () => {
    const r = await run('data', 'sample', '--table', 't', '--seller-id', 'A1SYNTHETIC0001');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: --seller-id takes the numeric warehouse SellerID/);
  });

  it('telemetry: user_facing, flag and value_shape; the value is only in the (already captured) argv', async () => {
    const r = await run('--json', 'ads', 'call', 'op.synthetic', '--query', '{"sku":"SYNTH-SKU-001"}');
    expect(r.events).toHaveLength(1);
    const event = r.events[0]!;
    expect(event.event_name).toBe('plugin.crashed');
    expect(event.error_class).toBe('invalid_argument');
    const { argv, ...rest } = event.payload as Record<string, unknown>;
    expect(rest).toEqual({
      message: 'invalid value for --query (json_object)',
      user_facing: true,
      flag: '--query',
      value_shape: 'json_object',
    });
    expect(JSON.stringify(rest)).not.toContain('SYNTH-SKU-001');
    expect(Array.isArray(argv)).toBe(true);
  });
});

describe('exitOverride routes commander usage errors through the same catch', () => {
  it('unknown option (data query --seller-id) under --json: usage_error envelope, exit 1, one event', async () => {
    const r = await run('--json', 'data', 'query', '--sql', 'select 1', '--seller-id', '5');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      status: 'error',
      error_class: 'usage_error',
      message: "unknown option '--seller-id'",
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.error_class).toBe('usage_error');
    expect(r.events[0]!.payload).toMatchObject({
      user_facing: true,
      commander_code: 'commander.unknownOption',
      message: "error: unknown option '--seller-id'",
    });
  });

  it('--json after the subcommand is honoured too', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--seller-id', '5', '--json');
    expect(JSON.parse(r.stdout).error_class).toBe('usage_error');
  });

  it('without --json the handler prints nothing: commander already wrote its own error line', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--seller-id', '5');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.events).toHaveLength(1);
  });

  it('missing required option is a usage_error', async () => {
    const r = await run('--json', 'data', 'query');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error_class).toBe('usage_error');
    expect(r.events[0]!.payload).toMatchObject({ commander_code: 'commander.missingMandatoryOptionValue' });
  });

  it('an unknown option given as --flag=value keeps the flag and drops the value in telemetry', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--seller-id=SYNTH-VALUE');
    const { message } = r.events[0]!.payload as { message: string };
    expect(message).toBe("error: unknown option '--seller-id'");
  });
});

describe('help and version still exit 0 with no error event', () => {
  it.each([['--help'], ['--version'], ['--json', '--version'], ['data', 'query', '--help'], ['help', 'data']])(
    '%s',
    async (...args) => {
      const r = await run(...args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      expect(r.events).toEqual([]);
    },
  );

  it('a command group run without a subcommand keeps its exit 1 and stays silent', async () => {
    const r = await run('data');
    expect(r.exitCode).toBe(1);
    expect(r.events).toEqual([]);
  });
});

describe('other errors are unchanged apart from the --json envelope', () => {
  it('a plain Error is unhandled_exception, without user_facing', async () => {
    const rec = recorder();
    const code = await handleTopLevelError(new Error('boom'), { json: false, argv: [] }, rec.io);
    expect(code).toBe(1);
    expect(rec.stderr).toBe('error: boom\n');
    expect(rec.events[0]!.error_class).toBe('unhandled_exception');
    expect(rec.events[0]!.payload).not.toHaveProperty('user_facing');
  });
});
