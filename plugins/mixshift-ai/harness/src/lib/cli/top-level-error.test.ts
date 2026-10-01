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
import { Command, CommanderError } from 'commander';

import { applyExitOverride, handleTopLevelError, type TopLevelErrorIo } from './top-level-error.js';
import { registerAdsCommands } from '../../commands/ads.js';
import { registerDataCommands } from '../../commands/data.js';
import { registerAmazonCommands } from '../../commands/amazon.js';
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
  registerAmazonCommands(program);
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
      { json: program.opts<{ json?: boolean }>().json === true, argv: args, program },
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
      hint: expect.stringContaining('WHERE SellerID'),
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.error_class).toBe('usage_error');
    expect(r.events[0]!.payload).toMatchObject({
      user_facing: true,
      commander_code: 'commander.unknownOption',
      message: "unknown option '--seller-id'",
    });
  });

  it('data query --seller-id: --json envelope keeps its message and adds a hint field', async () => {
    const r = await run('--json', 'data', 'query', '--sql', 'select 1', '--seller-id', '5');
    expect(r.exitCode).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope).toMatchObject({
      status: 'error',
      error_class: 'usage_error',
      message: "unknown option '--seller-id'",
    });
    expect(envelope.hint).toContain('WHERE SellerID = <numeric warehouse SellerID>');
    expect(r.events[0]!.payload).toMatchObject({ hint_id: 'data_query_seller_id' });
  });

  it('data query --seller-id without --json: the hint goes to stderr after the error, same exit code', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--seller-id', '5');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^hint: `data query` takes SQL and has no --seller-id/);
  });

  it('data sample --seller-id is untouched: it is a real option', async () => {
    const r = await run('--json', 'data', 'sample', '--table', 't', '--seller-id', 'A1SYNTHETIC0001');
    expect(JSON.parse(r.stdout).error_class).toBe('invalid_argument');
    expect(JSON.parse(r.stdout).hint).toBeUndefined();
  });

  it.each([
    [['data', 'tables'], 'mixshift data list-tables'],
    [['amazon', 'list'], 'mixshift amazon list-reports'],
    [['amazon', 'ops'], 'mixshift amazon operations'],
    [['retail', 'list'], 'mixshift amazon merchants'],
  ])('unknown command %j: hint names %s, class and exit code unchanged', async (argv, target) => {
    const r = await run('--json', ...argv);
    expect(r.exitCode).toBe(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.error_class).toBe('usage_error');
    expect(envelope.hint).toContain(target);
    expect(r.events[0]!.payload).toMatchObject({ hint_id: 'command_alias' });
  });

  it('an unknown command with no alias lists the real subcommands in the hint', async () => {
    const r = await run('--json', 'amazon', 'report', 'frobnicate');
    expect(JSON.parse(r.stdout).hint).toContain('start, poll, get, run');
  });

  it('--json after the subcommand is honoured too', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--seller-id', '5', '--json');
    expect(JSON.parse(r.stdout).error_class).toBe('usage_error');
  });

  it('without --json the handler prints nothing: commander already wrote its own error line', async () => {
    const r = await run('data', 'query', '--sql', 'select 1', '--bogus', '5');
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
    expect(message).toBe("unknown option '--seller-id'");
  });

  it.each([
    ['a value containing a quote', ["--seller-id=it's SYNTH-VALUE"], "unknown option '--seller-id'"],
    ['a short flag with its value attached', ['-sSYNTH-VALUE'], "unknown option '-s'"],
  ])('telemetry drops %s from an unknown option', async (_label, extra, expected) => {
    const r = await run('data', 'query', '--sql', 'select 1', ...extra);
    const { message } = r.events[0]!.payload as { message: string };
    expect(message).toBe(expected);
  });

  it('an unknown command keeps its usage_error class and drops the operand from telemetry', async () => {
    const r = await run('--json', 'data', 'B0SYNTH001');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ error_class: 'usage_error' });
    expect(r.events[0]!.payload).toMatchObject({ commander_code: 'commander.unknownCommand' });
    const { message } = r.events[0]!.payload as { message: string };
    expect(message).toMatch(/^unknown command/);
    expect(message).not.toContain('B0SYNTH001');
  });

  it("commander's invalid-argument message is invalid_argument and loses the value, quotes and all", async () => {
    const rec = recorder();
    const err = new CommanderError(
      1,
      'commander.invalidArgument',
      "error: option '--mode <m>' argument 'it's SYNTH-VALUE' is invalid. Allowed choices are a, b.",
    );
    expect(await handleTopLevelError(err, { json: false, argv: [] }, rec.io)).toBe(1);
    expect(rec.events[0]!.error_class).toBe('invalid_argument');
    const { message } = rec.events[0]!.payload as { message: string };
    expect(message).toBe("option '--mode <m>' argument is invalid. Allowed choices are a, b.");
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
