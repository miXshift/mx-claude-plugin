/**
 * Targeted "you probably meant..." hints for the wrong guesses agents make,
 * layered on top of commander's own usage errors (the `usage_error` class in
 * top-level-error.ts). commander already names the bad flag or command (and
 * adds its built-in "Did you mean" when a name is close in edit distance);
 * this adds what it cannot know: that a guessed command or flag lives
 * somewhere else, and where.
 *
 * Pure: no I/O. The hint never echoes the user's operands back, so it is as
 * safe to print as commander's own message.
 */

import type { Command } from 'commander';

export interface UsageHint {
  /** Stable id, recorded in telemetry so a hint's reach can be counted. */
  id: string;
  text: string;
}

/**
 * Guessed command path (as typed, space-separated) -> the real one(s). Keys
 * are matched on the resolved parent path plus the unknown token, or on the
 * unknown top-level token alone. usage-hints.test.ts checks that every
 * `target` still resolves in the real command tree, so a rename cannot leave
 * a hint pointing nowhere.
 */
export const COMMAND_ALIASES: Record<string, { targets: string[]; note?: string; then?: string }> = {
  'data tables': { targets: ['data list-tables'], then: '`mixshift data describe <table>` for one table' },
  'data list': { targets: ['data list-tables'] },
  'amazon list': { targets: ['amazon list-reports', 'amazon merchants'] },
  'amazon ops': { targets: ['amazon operations'] },
  retail: {
    targets: ['amazon merchants', 'amazon operations', 'amazon call'],
    note: 'there is no `retail` command; Amazon retail data is under `amazon`, and warehouse tables are under `data`',
  },
};

/** Options that take a value at the root, so the walk skips their operand. */
const ROOT_VALUE_OPTIONS = new Set(['--data-dir', '--surface']);

interface Resolved {
  /** Command names resolved so far, e.g. ['data', 'query']. */
  path: string[];
  cmd: Command;
  /** First token that matched no subcommand of `cmd`, when cmd has subcommands. */
  unknown?: string;
}

/** Walk argv down the registered command tree. Never throws. */
function resolve(program: Command, argv: readonly string[]): Resolved {
  let cmd = program;
  const path: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') break;
    if (tok.startsWith('-')) {
      if (ROOT_VALUE_OPTIONS.has(tok)) i++;
      continue;
    }
    const next = cmd.commands.find((c) => c.name() === tok || c.aliases().includes(tok));
    if (next) {
      cmd = next;
      path.push(next.name());
      continue;
    }
    // A leaf's positionals (a table name, an operation) are not unknown commands.
    if (cmd.commands.length === 0) break;
    return { path, cmd, unknown: tok };
  }
  return { path, cmd };
}

/** True when a space-separated command path exists in the tree. */
export function commandExists(program: Command, target: string): boolean {
  let cmd = program;
  for (const part of target.split(' ')) {
    const next = cmd.commands.find((c) => c.name() === part);
    if (!next) return false;
    cmd = next;
  }
  return true;
}

/** Subcommand names of a group, for "valid commands here". */
function listSubcommands(cmd: Command): string {
  return cmd.commands
    .filter((c) => c.name() !== 'help')
    .map((c) => c.name())
    .join(', ');
}

/**
 * Pick the hint for a commander usage error, or undefined when commander's
 * own message is already enough.
 */
export function usageHint(
  code: string,
  message: string,
  argv: readonly string[],
  program: Command,
): UsageHint | undefined {
  const r = resolve(program, argv);

  if (code === 'commander.unknownOption') {
    const flag = /unknown option '(--[^'=\s]+)/.exec(message)?.[1];
    if (flag === '--seller-id' && r.path.join(' ') === 'data query') {
      return {
        id: 'data_query_seller_id',
        text:
          '`data query` takes SQL and has no --seller-id. Filter in the SQL instead: ' +
          'WHERE SellerID = <numeric warehouse SellerID> (on the `seller` table itself the key is `ID`). ' +
          '(`data sample` and `data export` do take --seller-id.)',
      };
    }
    return undefined;
  }

  if (code === 'commander.unknownCommand' && r.unknown !== undefined) {
    const key = r.path.length ? `${r.path.join(' ')} ${r.unknown}` : r.unknown;
    // A top-level guess matches on the token alone (`retail anything`).
    const alias = COMMAND_ALIASES[key];
    if (alias) {
      const targets = alias.targets
        .filter((t) => commandExists(program, t))
        .map((t) => `\`mixshift ${t}\``);
      const list = targets.length > 1 ? `${targets.slice(0, -1).join(', ')} or ${targets.at(-1)}` : targets[0];
      if (targets.length) {
        return {
          id: 'command_alias',
          text: `${alias.note ? `${alias.note}. ` : ''}Try ${list}${alias.then ? ` (then ${alias.then})` : ''}.`,
        };
      }
    }
    const where = r.path.length ? `mixshift ${r.path.join(' ')}` : 'mixshift';
    const subs = listSubcommands(r.cmd);
    if (subs) {
      return {
        id: 'command_list',
        text: `Commands under \`${where}\`: ${subs}. Run \`${where} --help\` for details.`,
      };
    }
  }
  return undefined;
}
