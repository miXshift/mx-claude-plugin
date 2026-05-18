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
  track,
  EventName,
} from '../lib/telemetry/index.js';
import type { Outcome } from '../lib/telemetry/events.js';
import { telemetryQueuePath } from '../lib/paths/resolve.js';
import { queueSizeBytes } from '../lib/telemetry/queue.js';
import { loadDotenvIfPresent, candidatePaths } from '../lib/env/load-dotenv.js';

const VALID_OUTCOMES = new Set(['ok', 'failed', 'timeout', 'deferred', 'skipped']);

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
          process.exitCode = 1;
          return;
      }
    });

  telemetry
    .command('emit <event-name>')
    .description(
      'Emit a telemetry event from the chat surface. Used by SKILL.md to ' +
        'fire detection events the harness CLI itself can\'t observe ' +
        '(feedback.detected_implicit, warm_start.served, etc.). Event name ' +
        'must be one of the values in the EventName enum — invalid names ' +
        'are rejected with a list of valid ones.',
    )
    .option('--payload-json <json>', 'Free-form JSON object payload')
    .option('--skill <id>', 'Skill ID context (e.g. data-explore, feedback)')
    .option('--trigger-phrase <text>', 'User phrase that triggered this event')
    .option('--outcome <s>', 'ok | failed | timeout | deferred | skipped')
    .option('--duration-ms <n>', 'Duration in milliseconds')
    .option('--brand <slug>', 'Brand slug context (added to payload.brand_slug)')
    .option('--message <text>', 'Free-form message text (added to payload.message)')
    .option('--email <email>', 'Override email (default: from profile.yaml)')
    .action(
      async (
        eventName: string,
        opts: {
          payloadJson?: string;
          skill?: string;
          triggerPhrase?: string;
          outcome?: string;
          durationMs?: string;
          brand?: string;
          message?: string;
          email?: string;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();

        // Validate event_name against the catalog so SKILL.md can't fire
        // typo'd events that silently land in Supabase as orphan rows.
        const validEvents = Object.values(EventName) as string[];
        if (!validEvents.includes(eventName)) {
          const message =
            `Unknown event name "${eventName}". Valid events:\n` +
            validEvents.map((e) => `  - ${e}`).join('\n');
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message}\n`);
          }
          process.exitCode = 2;
          return;
        }

        // Parse + validate optional payload JSON.
        let payload: Record<string, unknown> = {};
        if (opts.payloadJson) {
          try {
            const parsed: unknown = JSON.parse(opts.payloadJson);
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              throw new Error('payload must be a JSON object (not array / primitive)');
            }
            payload = parsed as Record<string, unknown>;
          } catch (err) {
            const message =
              err instanceof Error ? err.message : String(err);
            if (root.json) {
              process.stdout.write(
                JSON.stringify(
                  { status: 'error', message: `--payload-json: ${message}` },
                  null,
                  2,
                ) + '\n',
              );
            } else {
              process.stderr.write(`error: --payload-json: ${message}\n`);
            }
            process.exitCode = 2;
            return;
          }
        }

        // Convenience lift: --brand and --message go into payload for the
        // Edge Function's Discord embed to render directly.
        if (opts.brand) payload.brand_slug = opts.brand;
        if (opts.message) payload.message = opts.message;

        // Validate outcome enum if provided.
        let outcome: Outcome | undefined;
        if (opts.outcome) {
          if (!VALID_OUTCOMES.has(opts.outcome)) {
            const message =
              `Invalid --outcome "${opts.outcome}". Must be one of: ${[...VALID_OUTCOMES].join(', ')}`;
            if (root.json) {
              process.stdout.write(
                JSON.stringify({ status: 'error', message }, null, 2) + '\n',
              );
            } else {
              process.stderr.write(`error: ${message}\n`);
            }
            process.exitCode = 2;
            return;
          }
          outcome = opts.outcome as Outcome;
        }

        // Parse --duration-ms if provided.
        let durationMs: number | undefined;
        if (opts.durationMs !== undefined) {
          const n = Number.parseInt(opts.durationMs, 10);
          if (!Number.isFinite(n) || n < 0) {
            const message = `Invalid --duration-ms "${opts.durationMs}". Must be a non-negative integer.`;
            if (root.json) {
              process.stdout.write(
                JSON.stringify({ status: 'error', message }, null, 2) + '\n',
              );
            } else {
              process.stderr.write(`error: ${message}\n`);
            }
            process.exitCode = 2;
            return;
          }
          durationMs = n;
        }

        await track(
          {
            event_name: eventName,
            payload,
            skill_id: opts.skill,
            trigger_phrase: opts.triggerPhrase,
            outcome,
            duration_ms: durationMs,
            email: opts.email,
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify({ status: 'ok', event_name: eventName }, null, 2) + '\n',
          );
        } else {
          process.stderr.write(`✓ Emitted ${eventName}\n`);
        }
      },
    );
}
