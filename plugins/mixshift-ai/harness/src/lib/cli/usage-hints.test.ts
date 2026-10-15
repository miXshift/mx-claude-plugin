/**
 * usage-hints: the right command or flag for a wrong guess. Builds the real
 * data / amazon / ads / auth command trees (cli.ts itself cannot be imported)
 * so every alias target is checked against commands that actually exist.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { COMMAND_ALIASES, OPTION_HINTS, commandExists, usageHint } from './usage-hints.js';
import { registerDataCommands } from '../../commands/data.js';
import { registerAmazonCommands } from '../../commands/amazon.js';
import { registerAdsCommands } from '../../commands/ads.js';
import { registerAuthCommands } from '../../commands/auth.js';

function tree(): Command {
  const program = new Command();
  program.option('--json').option('--data-dir <path>');
  registerDataCommands(program);
  registerAmazonCommands(program);
  registerAdsCommands(program);
  registerAuthCommands(program);
  return program;
}

describe('COMMAND_ALIASES', () => {
  it('every target is a real command', () => {
    const program = tree();
    for (const [guess, { targets }] of Object.entries(COMMAND_ALIASES)) {
      for (const t of targets) {
        expect(commandExists(program, t), `${guess} -> ${t}`).toBe(true);
      }
    }
  });

  it('no guess is itself a real command (a hint must never shadow one)', () => {
    const program = tree();
    for (const guess of Object.keys(COMMAND_ALIASES)) {
      expect(commandExists(program, guess), guess).toBe(false);
    }
  });

  it('`auth status` is real now, so it is not an alias', () => {
    expect(commandExists(tree(), 'auth status')).toBe(true);
  });

  it('the most-guessed names are real aliases now, so they resolve and are not hints', () => {
    const program = tree();
    for (const real of ['data tables', 'ads ops', 'ads catalog', 'amazon ops']) {
      expect(commandExists(program, real), real).toBe(true);
      expect(COMMAND_ALIASES[real], real).toBeUndefined();
    }
  });
});

describe('OPTION_HINTS', () => {
  it('every command path is real', () => {
    const program = tree();
    for (const path of Object.keys(OPTION_HINTS)) expect(commandExists(program, path), path).toBe(true);
  });

  it('no hinted flag is a real option of that command (a hint must never shadow one)', () => {
    const program = tree();
    for (const [path, flags] of Object.entries(OPTION_HINTS)) {
      let cmd = program;
      for (const part of path.split(' ')) cmd = cmd.commands.find((c) => c.name() === part)!;
      const real = new Set(cmd.options.map((o) => o.long));
      for (const flag of Object.keys(flags)) expect(real.has(flag), `${path} ${flag}`).toBe(false);
    }
  });
});

describe('usageHint', () => {
  const program = tree();
  const unknownCmd = (argv: string[]) =>
    usageHint('commander.unknownCommand', "unknown command 'x'", argv, program);

  it('data query --seller-id: filter in the SQL', () => {
    const h = usageHint('commander.unknownOption', "unknown option '--seller-id'", ['data', 'query', '--sql', 'select 1', '--seller-id', '5'], program);
    expect(h?.id).toBe('data_query_seller_id');
    expect(h?.text).toContain('WHERE SellerID = <numeric warehouse SellerID>');
    expect(h?.text).toContain('`data sample` and `data export`');
  });

  it('finds data query past root flags with values', () => {
    const h = usageHint('commander.unknownOption', "unknown option '--seller-id'", ['--data-dir', 'dir', '--json', 'data', 'query', '--seller-id=5'], program);
    expect(h?.id).toBe('data_query_seller_id');
  });

  it.each([
    [['data', 'query', '--format', 'csv', '--sql', 'select 1'], "unknown option '--format'", 'data_query_format', '--out <file.csv>'],
    [['--json', 'data', 'query', '--legacy-seller-id', '5', '--sql', 'select 1'], "unknown option '--legacy-seller-id'", 'data_query_seller_id', 'WHERE SellerID'],
    [['amazon', 'call', 'catalog.search_items', '--param', 'a=b'], "unknown option '--param'", 'amazon_call_params', '--query key=value'],
    [['--json', 'amazon', 'call', 'x.y', '--path-params', 'a=b'], "unknown option '--path-params'", 'amazon_call_params', '--path key=value'],
    [['amazon', 'call', 'x.y', '--out', 'f.json'], "unknown option '--out'", 'amazon_call_out', 'amazon report get'],
    [['amazon', 'report', 'get', '--run-id', 'abc'], "unknown option '--run-id'", 'amazon_report_run_id', 'amazon report get <runId>'],
    [['amazon', 'report', 'poll', '--run-id', 'abc'], "unknown option '--run-id'", 'amazon_report_run_id', 'amazon report poll <runId>'],
  ])('%j: %s -> hint', (argv, message, id, text) => {
    const h = usageHint('commander.unknownOption', message, argv, program);
    expect(h?.id).toBe(id);
    expect(h?.text).toContain(text);
  });

  it('a real alias resolves for option hints too', () => {
    const h = usageHint('commander.unknownOption', "unknown option '--format'", ['data', 'tables', '--format', 'csv'], program);
    expect(h).toBeUndefined();
  });

  it('--seller-id on other commands, and other unknown flags, get no hint', () => {
    expect(usageHint('commander.unknownOption', "unknown option '--seller-id'", ['amazon', 'merchants', '--seller-id', '5'], program)).toBeUndefined();
    expect(usageHint('commander.unknownOption', "unknown option '--bogus'", ['data', 'query', '--bogus'], program)).toBeUndefined();
  });

  it.each([
    [['data', 'list'], 'mixshift data list-tables'],
    [['data', 'catalog'], 'mixshift data list-tables'],
    [['amazon', 'list'], 'mixshift amazon list-reports'],
    [['amazon', 'catalog'], 'mixshift amazon list-reports'],
    [['amazon', 'reports', 'catalog'], 'mixshift amazon report'],
    [['amazon', 'report', 'types'], 'mixshift amazon list-reports'],
    [['amazon', 'report', 'catalog'], 'mixshift amazon list-reports'],
    [['ads', 'list'], 'mixshift ads profiles'],
    [['report', 'catalog'], 'mixshift amazon list-reports'],
    [['spapi', 'operations'], 'mixshift amazon operations'],
    [['sp-api', 'operations'], 'mixshift amazon operations'],
    [['retail', 'list'], 'mixshift amazon merchants'],
    [['--json', 'retail'], 'mixshift amazon operations'],
  ])('%j points at %s', (argv, target) => {
    const h = unknownCmd(argv);
    expect(h?.id).toBe('command_alias');
    expect(h?.text).toContain(target);
  });

  it('an unmapped unknown subcommand lists the real ones under its parent', () => {
    const h = unknownCmd(['amazon', 'report', 'frobnicate']);
    expect(h?.id).toBe('command_list');
    expect(h?.text).toContain('mixshift amazon report');
    for (const real of ['start', 'poll', 'get', 'run']) expect(h?.text).toContain(real);
  });

  it('does not echo the operand', () => {
    const h = unknownCmd(['data', 'B0SYNTH001']);
    expect(h?.text).not.toContain('B0SYNTH001');
    expect(h?.text).toContain('list-tables');
  });

  it('a leaf command given extra operands is not an unknown command', () => {
    expect(unknownCmd(['data', 'describe', 'sometable', 'extra'])).toBeUndefined();
  });
});
