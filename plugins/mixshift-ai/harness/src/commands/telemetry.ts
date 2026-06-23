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

import { platform, release } from 'node:os';
import type { Command } from 'commander';
import {
  getTelemetryStatus,
  setOptedOut,
  maybeFlush,
  track,
  detectInstallPath,
  EventName,
} from '../lib/telemetry/index.js';
import type { Outcome } from '../lib/telemetry/events.js';
import { probeSurface } from '../lib/telemetry/surface.js';
import { telemetryQueuePath } from '../lib/paths/resolve.js';
import { queueSizeBytes } from '../lib/telemetry/queue.js';
import { tailFlushLog, flushLogPath } from '../lib/telemetry/flush-log.js';
import { loadDotenvIfPresent, candidatePaths } from '../lib/env/load-dotenv.js';
import { getPluginVersion } from '../lib/plugin-version.js';

const VALID_OUTCOMES = new Set(['ok', 'failed', 'timeout', 'deferred', 'skipped']);

interface RootOptions {
  json?: boolean;
  dataDir?: string;
  /** Global `--surface` flag — forwarded so the probe mirrors detection. */
  surface?: string;
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
      const recentFlushes = await tailFlushLog(5, root.dataDir);
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
              flush_log_path: flushLogPath(root.dataDir),
              recent_flushes: recentFlushes.map((l) => {
                const [ts, st, n, err] = l.split('\t');
                return { ts, status: st, events_sent: Number(n), error: err || null };
              }),
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

      let flushSection = '';
      if (recentFlushes.length > 0) {
        flushSection =
          `\nRecent flushes (last ${recentFlushes.length}):\n` +
          recentFlushes
            .map((l) => {
              const [ts, st, n, err] = l.split('\t');
              const errSuffix = err ? `   ${err}` : '';
              return `  ${ts}  ${st.padEnd(12)}  sent=${n}${errSuffix}`;
            })
            .join('\n') +
          `\n  log: ${flushLogPath(root.dataDir)}\n`;
      } else {
        flushSection = `\nNo flushes logged yet (or log file at ${flushLogPath(root.dataDir)} doesn't exist).\n`;
      }

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
          flushSection +
          '\nSee docs/privacy.md for what we collect and why.\n',
      );
    });

  telemetry
    .command('surface')
    .description(
      'Diagnose surface detection. Prints the resolved surface, which rule ' +
        'decided it, and every raw host signal it read. Run this INSIDE a real ' +
        'Claude Code session AND a real Cowork session to capture ground truth ' +
        'on which markers actually reach the harness at emit time.',
    )
    .action(async (_opts, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      // probeSurface() IS the detector detectSurface() delegates to, so this
      // reports exactly what a telemetry event emitted from this process would
      // carry. install_path is the companion field that also collapses to
      // 'cli' when CLAUDE_PLUGIN_ROOT is absent.
      const probe = probeSurface(root.surface);
      const installPath = detectInstallPath();

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            {
              ...probe,
              install_path: installPath,
              plugin_version: getPluginVersion(),
              node_version: process.version,
              platform: `${platform()}-${release()}`,
              argv: process.argv,
              cwd: process.cwd(),
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }

      const show = (v: string | undefined): string => (v === undefined ? '(unset)' : v);
      const envLines = Object.entries(probe.env)
        .map(([k, v]) => `    ${k.padEnd(22)} = ${show(v)}`)
        .join('\n');
      const pathLines =
        probe.runtimePaths.length > 0
          ? probe.runtimePaths.map((p) => `      - ${p}`).join('\n')
          : '      (none)';

      const verdict =
        probe.decidedBy === 'fallback'
          ? `→ No host marker matched — resolved to the \`${probe.result}\` fallback ` +
            `(${probe.result === 'cli_headless' ? 'headless: CI env or no TTY' : 'interactive terminal'}).\n` +
            '  If you ran this inside a real Claude Code / Cowork session and still\n' +
            '  see a fallback, the host did not propagate any marker to this process\n' +
            '  — paste this whole block back.\n'
          : `→ Resolved to \`${probe.result}\` via ${probe.decidedBy}.\n`;

      process.stdout.write(
        '\nSurface detection probe\n' +
          '=======================\n\n' +
          `  Resolved surface:  ${probe.result}\n` +
          `  Decided by:        ${probe.decidedBy}\n` +
          `  install_path:      ${installPath}\n` +
          `  --surface flag:    ${show(probe.flag)}\n` +
          `  interactive TTY:   ${probe.tty}\n` +
          `  CI environment:    ${probe.ci}\n\n` +
          'Host env signals (undefined = not set by the runtime):\n' +
          `${envLines}\n\n` +
          `Cowork payload marker ("${probe.coworkMarker}"): ` +
          `${probe.coworkMarkerPresent ? 'FOUND' : 'NOT FOUND'}\n` +
          '  runtime paths checked:\n' +
          `${pathLines}\n\n` +
          'Context:\n' +
          `    plugin_version = ${getPluginVersion()}\n` +
          `    node           = ${process.version}\n` +
          `    platform       = ${platform()}-${release()}\n` +
          `    cwd            = ${process.cwd()}\n\n` +
          verdict +
          '\n',
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
    .option('--skill <id>', 'Skill ID context (e.g. mx-data-explore, feedback)')
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
