/**
 * `mixshift telemetry status | opt-in | opt-out | flush`
 *
 * User-facing controls for the telemetry pipeline. The primary use cases:
 *
 *   - `status`       Show whether telemetry is going to fire and why.
 *   - `opt-out`      Persistently disable telemetry for this install.
 *   - `opt-in`       Re-enable after an earlier opt-out.
 *   - `flush`        Force a drain of the local queue (debugging / CI).
 */

import type { Command } from 'commander';
import {
  getTelemetryStatus,
  setOptedOut,
  maybeFlush,
} from '../lib/telemetry/index.js';
import { telemetryQueuePath } from '../lib/paths/resolve.js';
import { queueSizeBytes } from '../lib/telemetry/queue.js';
import { loadDotenvIfPresent, candidatePaths } from '../lib/env/load-dotenv.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerTelemetryCommands(program: Command): void {
  const telemetry = program
    .command('telemetry')
    .description(
      'View / control telemetry state for this install. See docs/privacy.md for what we collect.',
    );

  telemetry
    .command('status')
    .description('Show current telemetry state (enabled / disabled, install ID, queue size).')
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const status = await getTelemetryStatus(root.dataDir);
      const queueBytes = await queueSizeBytes(root.dataDir);
      // Re-run the loader so we know which .env.local (if any) was picked
      // up. The CLI ran it at startup already; this re-run is idempotent
      // (existing process.env vars win) and lets us report the source path.
      const envLoad = await loadDotenvIfPresent();
      const envCandidates = candidatePaths();

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ...status,
              queue_path: telemetryQueuePath(root.dataDir),
              queue_size_bytes: queueBytes,
              env_file: envLoad.source_path ?? null,
              env_applied_count: envLoad.applied_count,
              env_skipped_existing: envLoad.skipped_existing,
              env_candidates: envCandidates,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const indicator = status.enabled ? '✓' : '✗';
      const envLine = envLoad.source_path
        ? `loaded from ${envLoad.source_path} (${envLoad.applied_count} vars applied, ${envLoad.skipped_existing.length} skipped — shell wins)`
        : `no .env.local found. Checked: ${envCandidates.join(', ')}`;
      process.stdout.write(
        `\n${indicator} Telemetry ${status.enabled ? 'enabled' : 'disabled'}\n` +
          `  - reason:           ${status.reason}\n` +
          `  - install_id:       ${status.install_id ?? '(none yet — will be created on first event)'}\n` +
          `  - acknowledged_at:  ${status.acknowledged_at ?? '(not yet shown)'}\n` +
          `  - opted_out:        ${status.opted_out}\n` +
          `  - env_override:     ${status.env_override} (MIXSHIFT_TELEMETRY)\n` +
          `  - configured:       ${status.configured} (endpoint + apikey in defaults)\n` +
          `  - env_file:         ${envLine}\n` +
          `  - queue path:       ${telemetryQueuePath(root.dataDir)}\n` +
          `  - queue size:       ${queueBytes} bytes\n` +
          '\nSee docs/privacy.md for what we collect and why.\n',
      );
    });

  telemetry
    .command('opt-out')
    .description('Persistently disable telemetry for this install.')
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await setOptedOut(true, root.dataDir);
      if (root.json) {
        process.stdout.write(JSON.stringify({ status: 'ok', opted_out: true }) + '\n');
      } else {
        process.stdout.write(
          '\n✓ Telemetry opted out.\n' +
            '  No further events will be queued or sent.\n' +
            '  To re-enable later: `mixshift telemetry opt-in`.\n\n',
        );
      }
    });

  telemetry
    .command('opt-in')
    .description('Re-enable telemetry after a previous opt-out.')
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      await setOptedOut(false, root.dataDir);
      if (root.json) {
        process.stdout.write(JSON.stringify({ status: 'ok', opted_out: false }) + '\n');
      } else {
        process.stdout.write(
          '\n✓ Telemetry opted in.\n' +
            '  Events will queue and flush going forward.\n' +
            '  See docs/privacy.md for what we collect.\n\n',
        );
      }
    });

  telemetry
    .command('flush')
    .description('Force a drain of the local queue (debug / CI).')
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await maybeFlush(root.dataDir);
      if (root.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      switch (result.status) {
        case 'sent':
          process.stdout.write(
            `\n✓ Flushed ${result.events_sent} event(s) to telemetry endpoint.\n\n`,
          );
          break;
        case 'no_events':
          process.stdout.write('\n  No queued events to flush.\n\n');
          break;
        case 'no_endpoint':
          process.stdout.write(
            '\n  Telemetry endpoint not configured. Events stay queued.\n\n',
          );
          break;
        case 'failed':
          process.stderr.write(
            `\n✗ Flush failed: ${result.error ?? 'unknown'}\n` +
              `  Sent ${result.events_sent} event(s) before failure.\n` +
              '  Remaining events stay in the queue and will retry next time.\n\n',
          );
          process.exit(1);
      }
    });
}
