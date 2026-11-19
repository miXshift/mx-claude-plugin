/**
 * `mixshift cli locate` — print the newest installed copy of this CLI.
 *
 * Job: as someone (or an agent) running a scheduled task on a machine that
 * keeps every plugin version it ever installed, I need ONE answer to "which
 * cli.js is the current one", so I do not run an older copy by taking the
 * first line of a `find` (feedback 3070886; mx-ops#274 item 2).
 *
 *   mixshift cli locate            prints the newest copy's cli.js path (one line)
 *   mixshift cli locate --list     every copy with its version, newest first
 *   mixshift --json cli locate     the same as a JSON document
 *
 * It reuses the rule the skills' invocation note already states (highest
 * version from each copy's plugin.json, `.trash` skipped); see
 * lib/cli-copies.ts. A copy that predates this command cannot answer it, so
 * the skills keep their `find` fallback for locating the first copy to ask.
 */

import type { Command } from 'commander';
import { resolvePluginRoot } from '../lib/prefetch/plugin-root.js';
import {
  scanCliCopies,
  sortCopiesNewestFirst,
  type CliCopy,
  type CliCopyScan,
} from '../lib/cli-copies.js';

interface RootOptions {
  json?: boolean;
}

interface LocateOptions {
  list?: boolean;
  root: string[];
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function runningRootOrUndefined(): string | undefined {
  try {
    return resolvePluginRoot();
  } catch {
    return undefined;
  }
}

function copyJson(c: CliCopy) {
  return {
    path: c.path,
    version: c.version,
    running: c.isRunning,
    newest: c.isNewest,
  };
}

export function buildLocateJson(scan: CliCopyScan) {
  return {
    newest: scan.newest ? copyJson(scan.newest) : null,
    running: scan.running ? copyJson(scan.running) : null,
    copies: sortCopiesNewestFirst(scan.copies).map(copyJson),
    scanned_roots: scan.scannedRoots,
    truncated: scan.truncated,
  };
}

/** One line per copy, newest first. Pure: unit-tested without a filesystem. */
export const TRUNCATED_LINE = 'Search stopped early; there may be other copies.';

export function renderCopiesList(scan: CliCopyScan): string {
  const out: string[] = [];
  for (const c of sortCopiesNewestFirst(scan.copies)) {
    const tags = [c.isNewest ? 'newest' : null, c.isRunning ? 'running' : null].filter(
      Boolean,
    );
    out.push(
      `${(c.version ?? '(version unreadable)').padEnd(10)} ${c.path}` +
        (tags.length ? `  [${tags.join(', ')}]` : ''),
    );
  }
  if (scan.truncated) out.push(TRUNCATED_LINE);
  return out.join('\n') + (out.length ? '\n' : '');
}

export function registerCliLocateCommand(program: Command): void {
  const cli = program
    .command('cli')
    .description('Find installed copies of this CLI (a machine keeps every version it installed).');

  cli
    .command('locate')
    .description(
      'Print the path of the newest installed cli.js (highest version from each ' +
        "copy's plugin.json; .trash skipped). --list shows every copy found.",
    )
    .option('--list', 'list every copy with its version instead of only the newest')
    .option(
      '--root <dir>',
      'scan this folder instead of the default host plugin folders (repeatable); the running copy is always included',
      collect,
      [] as string[],
    )
    .action((opts: LocateOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const scan = scanCliCopies({
        runningPluginRoot: runningRootOrUndefined(),
        extraRoots: opts.root,
        onlyExtraRoots: opts.root.length > 0,
      });

      if (root.json) {
        process.stdout.write(JSON.stringify(buildLocateJson(scan), null, 2) + '\n');
        process.exitCode = scan.newest ? 0 : 1;
        return;
      }
      if (!scan.newest) {
        process.stderr.write(
          'No MixShift CLI copy with a readable version was found in the host plugin folders.\n' +
            'Fall back to: find / -maxdepth 9 -type f -path \'*/harness/dist/cli.js\' 2>/dev/null ' +
            '(skip .trash, take the highest version from each copy\'s .claude-plugin/plugin.json).\n',
        );
        if (scan.truncated) process.stderr.write(TRUNCATED_LINE + '\n');
        process.exitCode = 1;
        return;
      }
      if (opts.list) {
        process.stdout.write(renderCopiesList(scan));
        return;
      }
      process.stdout.write(scan.newest.path + '\n');
      // stdout stays one line (callers use it as a path); the caveat goes to stderr.
      if (scan.truncated) process.stderr.write(TRUNCATED_LINE + '\n');
    });
}
