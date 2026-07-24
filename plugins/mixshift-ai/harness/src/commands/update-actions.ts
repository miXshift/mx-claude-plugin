/**
 * `mixshift update-actions` — guided catch-up actions after an update.
 *
 * Default (no subcommand): READ-ONLY compute. Resolves which actions from
 * the fetched `releases/actions.yaml` are still pending for this install
 * and emits them as data for the mx-update skill to present. This command
 * (and lib/update-actions.ts underneath it) WRITES NOTHING except this
 * command's own ledger via the `record` / `catch-up` subcommands below — it
 * never executes an action itself. Running the actual change always goes
 * through the NAMED skill in `run.skill`, which carries its own confirm
 * flow. See lib/update-actions.ts's module header for the full threat
 * model: `releases/actions.yaml` is fetched from GitHub raw, the same
 * untrusted-source class as the version strings that produced two red-team
 * HIGHs in the update-notice feature (P1).
 *
 * `record <id> --status <completed|skipped|dismissed|later>` — the
 * mx-update skill calls this AFTER an offered action has actually been
 * resolved (accepted-and-completed, declined, or the user asked to stop
 * being reminded), so the ledger and the automatic telemetry stay in
 * lockstep with what really happened. The harness fires the telemetry here,
 * not the model, so it can't be skipped or mis-reported.
 *
 * `catch-up --to <version>` — marks the user caught up through a version
 * once the skill has walked every pending action for this update. Actions
 * introduced at or before that version never resurface.
 */

import type { Command } from 'commander';
import { getPluginVersion } from '../lib/plugin-version.js';
import { isValidVersion } from '../lib/update-notice-state.js';
import {
  loadActionsLedger,
  saveActionsLedger,
  setActionStatus,
  setCaughtUpTo,
  isValidActionStatus,
  ACTION_STATUSES,
  type ActionStatus,
} from '../lib/update-actions-state.js';
import { loadActions, computePending, type PendingAction } from '../lib/update-actions.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerUpdateActionsCommand(program: Command): void {
  const updateActions = program
    .command('update-actions')
    .description(
      'Guided catch-up actions after an update. Read-only by default (lists ' +
        "what's pending for this install from releases/actions.yaml); `record` " +
        'and `catch-up` update the local ledger. The engine never executes an ' +
        'action itself — that always goes through the named skill.',
    )
    .option(
      '--format <type>',
      'output format for the list: `terminal` (default) | `chat` (markdown for Claude/Cowork)',
      'terminal',
    )
    .option('--force-fetch', 'bypass the 24h actions.yaml cache and re-fetch', false)
    .action(async (opts: { format?: string; forceFetch?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await runList(root, opts);
    });

  registerRecord(updateActions);
  registerCatchUp(updateActions);
}

async function runList(
  root: RootOptions,
  opts: { format?: string; forceFetch?: boolean },
): Promise<void> {
  const installed = getPluginVersion();
  const ledger = await loadActionsLedger(root.dataDir);
  // caught_up_to is null on a brand-new ledger (never run before). Treating
  // that as `installed` (rather than, say, "0.0.0") means a fresh install
  // is never offered a backlog of every historical catch-up action — only a
  // REAL gap between a previously-recorded watermark and the current
  // version surfaces anything. The watermark only ever moves forward via
  // an explicit `catch-up --to <version>` call from the mx-update skill.
  const caughtUpTo = ledger.caught_up_to ?? installed;

  const { actions, source, error } = await loadActions({
    dataDirOverride: root.dataDir,
    forceFetch: opts.forceFetch,
  });

  const pending = await computePending({
    installed,
    caughtUpTo,
    ledger,
    actions,
    dataDirOverride: root.dataDir,
  });

  await track(
    {
      event_name: EventName.UpdateActionsListed,
      payload: {
        pending_count: pending.length,
        installed,
        source,
        ...(error ? { fetch_error: error } : {}),
      },
    },
    root.dataDir,
  );

  // A total fetch failure (no network AND no usable cache) returns an empty
  // list that is indistinguishable from "genuinely nothing pending" unless we
  // say so. Surface it, so the skill (and a --json consumer) can tell "you are
  // current" apart from "could not check right now".
  const checked = source !== 'none';

  if (root.json) {
    process.stdout.write(
      JSON.stringify(
        { status: 'ok', installed, caught_up_to: caughtUpTo, checked, source, pending },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const format = opts.format === 'chat' ? 'chat' : 'terminal';
  process.stdout.write(render(pending, checked, format) + '\n');
}

function render(pending: PendingAction[], checked: boolean, format: 'terminal' | 'chat'): string {
  if (pending.length === 0) {
    if (!checked) {
      const msg =
        'Could not check for catch-up actions right now (the update service was unreachable). Try again later.';
      return format === 'chat' ? msg : `\n${msg}\n`;
    }
    return format === 'chat'
      ? 'No catch-up actions pending. You are current.'
      : '\nNo catch-up actions pending. You are current.\n';
  }
  if (format === 'chat') {
    const out: string[] = ['**Catch-up actions for this update:**', ''];
    for (const a of pending) {
      out.push(`### ${a.title}`, '');
      out.push(...a.teach.split('\n').map((line) => `> ${line}`));
      out.push('');
      out.push(`_Runs: ${a.run.skill}${a.run.args_hint ? ` (${a.run.args_hint})` : ''}_`, '');
    }
    return out.join('\n').trimEnd();
  }
  const out: string[] = ['', 'Catch-up actions for this update:'];
  for (const a of pending) {
    out.push('', `-- ${a.title} --`, '', a.teach, `(runs: ${a.run.skill}${a.run.args_hint ? ` ${a.run.args_hint}` : ''})`);
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// update-actions record <id> --status <...>
// ---------------------------------------------------------------------------

function registerRecord(parent: Command): void {
  parent
    .command('record <id>')
    .description('Record the outcome of one catch-up action in the local ledger.')
    .requiredOption('--status <status>', `outcome: ${ACTION_STATUSES.join(' | ')}`)
    .action(async (id: string, opts: { status?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();

      if (!isValidActionStatus(opts.status)) {
        emitError(
          `--status must be one of: ${ACTION_STATUSES.join(', ')} (got '${opts.status}').`,
          root,
        );
        return;
      }
      const status: ActionStatus = opts.status;
      const installed = getPluginVersion();

      const ledger = setActionStatus(await loadActionsLedger(root.dataDir), id, status, installed);
      try {
        await saveActionsLedger(ledger, root.dataDir);
      } catch (err) {
        emitError(
          `could not save the actions ledger: ${err instanceof Error ? err.message : String(err)}`,
          root,
        );
        return;
      }

      await track(
        {
          event_name: EventName.UpdateActionApplied,
          payload: { action_id: id, status, installed },
        },
        root.dataDir,
      );

      if (root.json) {
        process.stdout.write(
          JSON.stringify({ status: 'ok', action_id: id, recorded_status: status }, null, 2) + '\n',
        );
        return;
      }
      process.stdout.write(`Recorded ${id} as ${status}.\n`);
    });
}

// ---------------------------------------------------------------------------
// update-actions catch-up --to <version>
// ---------------------------------------------------------------------------

function registerCatchUp(parent: Command): void {
  parent
    .command('catch-up')
    .description(
      'Mark the user caught up through a version: actions introduced at or ' +
        'before it never surface as pending again.',
    )
    .requiredOption('--to <version>', 'the version to mark as caught up to')
    .action(async (opts: { to?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();

      if (!isValidVersion(opts.to)) {
        emitError(`--to must be a valid version string (got '${opts.to}').`, root);
        return;
      }
      const to = opts.to;

      const ledger = setCaughtUpTo(await loadActionsLedger(root.dataDir), to);
      try {
        await saveActionsLedger(ledger, root.dataDir);
      } catch (err) {
        emitError(
          `could not save the actions ledger: ${err instanceof Error ? err.message : String(err)}`,
          root,
        );
        return;
      }

      if (root.json) {
        process.stdout.write(JSON.stringify({ status: 'ok', caught_up_to: to }, null, 2) + '\n');
        return;
      }
      process.stdout.write(`Caught up through ${to}.\n`);
    });
}

function emitError(message: string, root: RootOptions): void {
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
