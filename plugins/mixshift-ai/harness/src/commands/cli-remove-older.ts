/**
 * `mixshift cli remove-older` - put older installed copies of the plugin out of use.
 *
 * Job: as someone whose machine still has older MixShift plugin copies, I need
 * one safe step to put them out of use, so nothing on my machine keeps running
 * months-old code (mx-ops#274). Removal is OPT-IN: the plugin never does this
 * on its own, on update or otherwise.
 *
 *   mixshift cli remove-older                 PREVIEW: lists what would move and where; changes nothing
 *   mixshift cli remove-older --yes           moves each older copy's folder into a .trash folder (a rename, never a delete)
 *   mixshift cli remove-older --yes --allow-partial   also act when the search stopped early
 *   mixshift --json cli remove-older [--yes]  the same as one compact JSON line, last on stdout
 *
 * Same contract as the other write commands (labels commit, ads writes): the
 * default shows and sends nothing, only the explicit flag acts, and the person
 * must have seen the preview and said yes first. Exit codes: 0 done (or
 * nothing to do, or a preview), 1 refused or invalid, 17 some copy could not be
 * moved (never a success; the per-copy results say which). Human output goes to
 * stdout for the person; with --json stdout is exactly one line.
 *
 * Which copies may move, and why a copy is left alone, is lib/cli-remove.ts.
 * Telemetry (cli.remove_older) carries counts and versions only, never a path.
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { resolvePluginRoot } from '../lib/prefetch/plugin-root.js';
import { scanCliCopies, type CliCopyScan } from '../lib/cli-copies.js';
import {
  SCHEDULED_TASK_WARNING,
  SKIP_TEXT,
  applyRemoveOlder,
  describeMovedLaunchers,
  explainError,
  launchersAfterMove,
  launchersInto,
  planRemoveOlder,
  restoreCommand,
  versionsOf,
  type ApplyDeps,
  type MoveResult,
  type PlanOptions,
  type RemovePlan,
} from '../lib/cli-remove.js';
import type { ShimScanOptions } from '../lib/cli-shim.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface RemoveOlderOptions {
  yes?: boolean;
  allowPartial?: boolean;
}

export const APPLY_COMMAND = 'mixshift cli remove-older --yes';
export const TRUNCATED_REFUSAL =
  'The search for plugin copies stopped early, so there may be other copies it did not see. ' +
  'Nothing was moved. Run it again with --allow-partial to move only what was found.';

export interface RemoveOlderRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Counts and versions only. Safe for telemetry. */
  summary: {
    mode: 'preview' | 'apply';
    status: 'preview' | 'nothing_to_do' | 'refused' | 'applied' | 'partial' | 'failed';
    copies_found: number;
    would_move: number;
    moved: number;
    failed: number;
    skipped: number;
    truncated: boolean;
    newest_version: string | null;
    versions_moved: string[];
    versions_failed: string[];
  };
}

export interface RunOptions extends RemoveOlderOptions {
  json?: boolean;
  platform?: NodeJS.Platform;
  plan?: PlanOptions;
  deps?: ApplyDeps;
  /** Where to look for launcher links (tests point this at a temp folder). */
  shims?: ShimScanOptions;
}

function hasRunning(scan: CliCopyScan): string | null {
  return scan.running?.version ?? null;
}

/** The whole command, with no process or console access: tests call this with a scan built in a temp tree. */
export function runRemoveOlder(scan: CliCopyScan, opts: RunOptions = {}): RemoveOlderRun {
  const platform = opts.platform ?? process.platform;
  const plan: RemovePlan = planRemoveOlder(scan, opts.plan);
  const newestLauncher = scan.newest ? join(scan.newest.path, '..', '..', 'bin', 'mixshift') : null;
  const base = {
    copies_found: scan.copies.length,
    would_move: plan.moves.length,
    skipped: plan.skipped.length,
    truncated: scan.truncated,
    newest_version: plan.newestVersion,
  };
  const empty = { moved: 0, failed: 0, versions_moved: [] as string[], versions_failed: [] as string[] };

  const skippedJson = plan.skipped.map((s) => ({ version: s.version, path: s.path, reason: s.reason, text: SKIP_TEXT[s.reason] }));
  const movesJson = plan.moves.map((m) => ({ version: m.version, from: m.from, to: m.to }));

  // ---- preview -----------------------------------------------------------
  if (!opts.yes) {
    const status = plan.moves.length === 0 ? 'nothing_to_do' : 'preview';
    const summary = { mode: 'preview' as const, status: status as 'preview' | 'nothing_to_do', ...base, ...empty };
    if (opts.json) {
      return {
        stdout:
          JSON.stringify({
            status,
            mode: 'preview',
            changed: false,
            newest_version: plan.newestVersion,
            running_version: hasRunning(scan),
            truncated: scan.truncated,
            would_move: movesJson,
            skipped: skippedJson,
            apply_command: plan.moves.length > 0 ? APPLY_COMMAND : null,
            apply_requires: scan.truncated && plan.moves.length > 0 ? '--allow-partial' : null,
          }) + '\n',
        stderr: '',
        exitCode: 0,
        summary,
      };
    }
    const out: string[] = [];
    if (plan.newestVersion === null) {
      out.push('No MixShift plugin copy with a readable version was found, so there is nothing to compare against. Nothing was changed.');
    } else if (plan.moves.length === 0) {
      out.push(`No older plugin copies to move. The newest installed copy is ${plan.newestVersion}. Nothing was changed.`);
    } else {
      out.push(`The newest installed plugin copy is ${plan.newestVersion}. These ${plan.moves.length === 1 ? 'copy is' : 'copies are'} older and would be moved into a .trash folder (moved, not deleted):`);
      for (const m of plan.moves) out.push(`  ${m.version.padEnd(10)} ${m.from}\n  ${' '.repeat(10)} -> ${m.to}`);
    }
    for (const s of plan.skipped) out.push(`  ${(s.version ?? '(unreadable)').padEnd(10)} ${s.path}  [${SKIP_TEXT[s.reason]}]`);
    if (scan.truncated) out.push('Search stopped early; there may be other copies.');
    if (plan.moves.length > 0) {
      out.push('Nothing has been changed.');
      out.push(
        scan.truncated
          ? `To move them, run: ${APPLY_COMMAND} --allow-partial (the search stopped early, so --allow-partial is required)`
          : `To move them, run: ${APPLY_COMMAND}`,
      );
    }
    return { stdout: out.join('\n') + '\n', stderr: '', exitCode: 0, summary };
  }

  // ---- refuse: truncated scan without --allow-partial ---------------------
  if (scan.truncated && !opts.allowPartial) {
    const summary = { mode: 'apply' as const, status: 'refused' as const, ...base, ...empty };
    if (opts.json) {
      return {
        stdout:
          JSON.stringify({
            status: 'refused',
            mode: 'apply',
            changed: false,
            reason: 'search_truncated',
            message: TRUNCATED_REFUSAL,
            truncated: true,
            would_move: movesJson,
            skipped: skippedJson,
          }) + '\n',
        stderr: '',
        exitCode: 1,
        summary,
      };
    }
    return { stdout: '', stderr: `error: ${TRUNCATED_REFUSAL}\n`, exitCode: 1, summary };
  }

  // ---- apply -------------------------------------------------------------
  const launchersBefore = launchersInto(plan, plan.newestVersion, opts.shims);
  const results: MoveResult[] = applyRemoveOlder(plan, opts.deps);
  const moved = results.filter((r) => r.moved);
  const failed = results.filter((r) => !r.moved);
  const links = launchersAfterMove(launchersBefore, results);
  const restore = moved.map((r) => ({ version: r.version, from: r.from, to: r.to, command: restoreCommand(r, platform) }));
  const status: 'applied' | 'partial' | 'failed' | 'nothing_to_do' =
    results.length === 0 ? 'nothing_to_do' : failed.length === 0 ? 'applied' : moved.length === 0 ? 'failed' : 'partial';
  const summary = {
    mode: 'apply' as const,
    status,
    ...base,
    moved: moved.length,
    failed: failed.length,
    versions_moved: versionsOf(moved),
    versions_failed: versionsOf(failed),
  };
  const exitCode = failed.length > 0 ? 17 : 0;
  const warning = moved.length > 0 ? SCHEDULED_TASK_WARNING : null;
  const linkLines = describeMovedLaunchers(links, newestLauncher, plan.newestVersion);

  if (opts.json) {
    return {
      stdout:
        JSON.stringify({
          status,
          mode: 'apply',
          changed: moved.length > 0,
          newest_version: plan.newestVersion,
          truncated: scan.truncated,
          results: results.map((r) => ({
            version: r.version,
            from: r.from,
            to: r.to,
            moved: r.moved,
            ...(r.error ? { error: r.error } : {}),
          })),
          skipped: skippedJson,
          restore,
          launcher_links: links.map((l) => ({ path: l.path, target: l.target })),
          launcher_help: linkLines,
          warning,
        }) + '\n',
      stderr: '',
      exitCode,
      summary,
    };
  }

  const out: string[] = [];
  if (results.length === 0) {
    out.push('No older plugin copies to move. Nothing was changed.');
  }
  for (const r of moved) out.push(`Moved ${r.version.padEnd(10)} ${r.from}\n  ${' '.repeat(10)} -> ${r.to}`);
  for (const r of failed) out.push(`Could not move ${r.version}: ${r.from}\n  ${explainError(r.error ?? 'unknown error')}. Nothing was changed for this copy.`);
  for (const s of plan.skipped) out.push(`  ${(s.version ?? '(unreadable)').padEnd(10)} ${s.path}  [${SKIP_TEXT[s.reason]}]`);
  if (scan.truncated) out.push('Search stopped early; there may be other copies.');
  if (restore.length > 0) {
    out.push('To put a copy back:');
    for (const r of restore) out.push(`  ${r.version}: ${r.command}`);
  }
  if (linkLines.length > 0) {
    out.push('Launcher links that pointed at a moved copy:');
    for (const l of linkLines) out.push(`  ${l}`);
  }
  if (warning) out.push(`Warning: ${warning}`);
  if (failed.length > 0) out.push(`${failed.length} of ${results.length} copies could not be moved; the others were.`);
  return { stdout: out.join('\n') + '\n', stderr: '', exitCode, summary };
}

export function registerCliRemoveOlderCommand(program: Command): void {
  const cli = program.commands.find((c) => c.name() === 'cli');
  if (!cli) throw new Error('registerCliLocateCommand must run before registerCliRemoveOlderCommand');

  cli
    .command('remove-older')
    .description(
      'Put older installed copies of the plugin out of use. Default is a PREVIEW that lists each older copy and where it ' +
        'would be moved, and changes nothing. With --yes each older copy is MOVED (renamed, never deleted) into a .trash ' +
        'folder, where it can be put back. Skips the running copy, the newest copy, any copy with an unreadable version, ' +
        'and anything under .trash or marketplaces. Run --yes only after the person has seen the preview and agreed. ' +
        'Exit 17 when some copy could not be moved.',
    )
    .option('--yes', 'actually move the older copies (default: preview only). Use only after the person confirmed the preview')
    .option('--allow-partial', 'with --yes, act even when the search for copies stopped early and may have missed some')
    .action(async (opts: RemoveOlderOptions, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const startedAt = Date.now();
      let running: string | undefined;
      try {
        running = resolvePluginRoot();
      } catch {
        running = undefined;
      }
      const scan = scanCliCopies({ runningPluginRoot: running });
      const run = runRemoveOlder(scan, { ...opts, json: root.json });
      if (run.stderr) process.stderr.write(run.stderr);
      if (run.stdout) process.stdout.write(run.stdout);
      process.exitCode = run.exitCode;
      await track(
        {
          event_name: EventName.CliRemoveOlder,
          outcome: run.exitCode === 0 ? 'ok' : 'failed',
          duration_ms: Date.now() - startedAt,
          payload: { ...run.summary },
        },
        root.dataDir,
      );
    });
}
