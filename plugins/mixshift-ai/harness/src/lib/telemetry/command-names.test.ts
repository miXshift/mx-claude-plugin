import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

import { commandToken, subcommandToken } from './command-names.js';
import { registerShelfCommands } from '../../commands/shelf.js';

// A small tree with an alias, plus the real `shelf` registration.
function program(): Command {
  const p = new Command();
  const data = p.command('data');
  data.command('list-tables').alias('tables');
  data.command('sample');
  p.command('feedback').argument('<message>');
  registerShelfCommands(p);
  return p;
}

describe('cli.command_run cmd and subcmd: names only', () => {
  const p = program();

  it('a well-formed line keeps what it always captured', () => {
    expect(commandToken(p, 'shelf')).toBe('shelf');
    expect(subcommandToken(p, 'shelf', 'tracking')).toBe('tracking');
    expect(subcommandToken(p, 'shelf', 'rank-history')).toBe('rank-history');
    expect(commandToken(p, 'data')).toBe('data');
    expect(subcommandToken(p, 'data', 'tables')).toBe('list-tables'); // an alias counts under its command
    expect(subcommandToken(p, 'data', 'list-tables')).toBe('list-tables');
    expect(commandToken(p, '--json')).toBe('--json');
    expect(subcommandToken(p, '--json', 'shelf')).toBe('shelf'); // `mixshift --json shelf ...`
    expect(subcommandToken(p, 'shelf', '--json')).toBe('--json');
    expect(commandToken(p, 'help')).toBe('help');
    expect(subcommandToken(p, 'help', 'shelf')).toBe('shelf');
    expect(commandToken(p, undefined)).toBe('(none)');
    expect(subcommandToken(p, 'shelf', undefined)).toBe('(none)');
  });

  it('anything that is not a name is (other): an operand, a set id, a path, a flag with its value', () => {
    expect(subcommandToken(p, 'shelf', 'trail-snacks')).toBe('(other)');
    expect(subcommandToken(p, 'feedback', 'the trail mix rank looks wrong')).toBe('(other)');
    expect(commandToken(p, 'trail-snacks')).toBe('(other)');
    expect(commandToken(p, '--data-dir=C:/Users/someone/mixshift')).toBe('(other)');
    expect(subcommandToken(p, '--data-dir', 'C:/Users/someone/mixshift')).toBe('(other)');
    expect(subcommandToken(p, 'shelf', '--keyword=trail mix')).toBe('(other)');
    expect(subcommandToken(p, 'help', 'trail mix')).toBe('(other)');
  });

  it('a command name in the second slot counts only after `help` or a boolean root flag; `help` itself counts anywhere', () => {
    expect(subcommandToken(p, '--verbose', 'data')).toBe('data');
    expect(subcommandToken(p, 'feedback', 'data')).toBe('(other)'); // `feedback report`: the message happens to be a command's name
    expect(subcommandToken(p, 'feedback', 'shelf')).toBe('(other)');
    expect(subcommandToken(p, '--data-dir', 'data')).toBe('(other)'); // a path that happens to be a command's name
    expect(subcommandToken(p, '--surface', 'shelf')).toBe('(other)');
    expect(subcommandToken(p, 'shelf', 'help')).toBe('help');
    expect(subcommandToken(p, 'data', 'help')).toBe('help');
    expect(subcommandToken(p, 'feedback', 'help')).toBe('help');
  });
});
