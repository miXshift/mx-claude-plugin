/**
 * usage-hints: the right command or flag for a wrong guess. Builds the real
 * data / amazon / ads / auth command trees (cli.ts itself cannot be imported)
 * so every alias target is checked against commands that actually exist.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { COMMAND_ALIASES, commandExists, usageHint } from './usage-hints.js';
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

  it('--seller-id on other commands, and other unknown flags, get no hint', () => {
    expect(usageHint('commander.unknownOption', "unknown option '--seller-id'", ['amazon', 'merchants', '--seller-id', '5'], program)).toBeUndefined();
    expect(usageHint('commander.unknownOption', "unknown option '--bogus'", ['data', 'query', '--bogus'], program)).toBeUndefined();
  });

  it.each([
    [['data', 'tables'], 'mixshift data list-tables'],
    [['amazon', 'list'], 'mixshift amazon list-reports'],
    [['amazon', 'ops'], 'mixshift amazon operations'],
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
