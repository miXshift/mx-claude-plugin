/**
 * The `cmd` and `subcmd` fields of `cli.command_run`: the first two tokens of the command line, by name only.
 *
 * They are taken from argv before parsing, so on a misordered or mistyped line they can be anything the user typed:
 * a path after `--data-dir`, a set id, a keyword. They do not go through redactArgs (the `args` field does), so a token
 * is kept only when it is a name: a registered command or alias, commander's `help`, a registered subcommand or alias
 * of the first token (counted under its canonical name, so `data tables` and `data list-tables` share one bucket), any
 * registered command name (after a root flag or `help`), or a bare flag name with no `=value`. Anything else is
 * `(other)`. A command-and-subcommand line captures what it always did; an operand in the second slot (a feedback
 * message, a demo name) is now `(other)` here, and still reaches telemetry through `args`, redacted.
 */

import type { Command } from 'commander';

export const OTHER_TOKEN = '(other)';

const BARE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/;

function find(commands: readonly Command[], token: string): Command | undefined {
  return commands.find((c) => c.name() === token || c.aliases().includes(token));
}

/** The first token, as typed, when it is a name; else `(other)`. */
export function commandToken(program: Command, token: string | undefined): string {
  if (!token) return '(none)';
  try {
    if (BARE_FLAG.test(token) || token === 'help' || find(program.commands, token)) return token;
  } catch {
    // fall through: never throw from telemetry
  }
  return OTHER_TOKEN;
}

/** The second token: the canonical name of a registered subcommand of the first, a registered command name, or a bare flag; else `(other)`. */
export function subcommandToken(program: Command, group: string | undefined, token: string | undefined): string {
  if (!token) return '(none)';
  try {
    if (BARE_FLAG.test(token)) return token;
    const g = group ? find(program.commands, group) : undefined;
    const sub = g ? find(g.commands, token) : undefined;
    if (sub) return sub.name();
    // A command name after a root flag (`--json shelf`) or after `help`: a name, as typed.
    if (find(program.commands, token)) return token;
  } catch {
    // fall through
  }
  return OTHER_TOKEN;
}
