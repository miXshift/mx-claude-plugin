/**
 * mixshift — internal CLI for the mixshift-ai plugin.
 *
 * Not user-facing. Claude invokes this via the Bash tool during skill
 * execution. End users interact through slash commands and natural language.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Exit / telemetry-flush contract (read before adding a new command!)
 * ──────────────────────────────────────────────────────────────────────
 *
 *   Command action handlers MUST NOT call `process.exit(N)` directly.
 *
 *   To signal a non-zero exit, set `process.exitCode = N` and `return`.
 *   To signal success, just `return` (exitCode defaults to 0).
 *
 *   This file is the only place `process.exit()` is called. It wraps
 *   `parseAsync` in a try/catch/finally so that:
 *     1. The `finally` block awaits `maybeFlush()` — draining any
 *        telemetry events queued during the command's execution.
 *     2. The final `process.exit(process.exitCode ?? 0)` happens AFTER
 *        the flush completes.
 *
 *   Why this matters: every `track()` call only appends to a local
 *   JSONL queue. The HTTP POST to Supabase happens in `maybeFlush()`.
 *   For a one-shot user (e.g. `mixshift welcome` invoked once from the
 *   Cowork first-run flow and never again), there's no "next CLI
 *   invocation" to drain the queue — so we MUST flush before exit, or
 *   the events are lost. A command that calls `process.exit(N)` directly
 *   bypasses this drain.
 *
 *   Helpers that previously called `process.exit()` (`emitError` in
 *   data.ts/profile.ts, `notYetImplemented` in lib/stub.ts) now set
 *   `process.exitCode` and return `void`. Callers naturally fall through
 *   to the end of the action handler.
 */

// Load `.env.local` FIRST — before any module reads process.env (mainly
// loadPluginDefaults which checks for MIXSHIFT_TELEMETRY_ENDPOINT and
// MIXSHIFT_TELEMETRY_APIKEY overrides).
// Best-effort: missing or unreadable file is a silent no-op, the CLI
// continues with whatever the shell already set.
import { loadDotenvIfPresent } from './lib/env/load-dotenv.js';
await loadDotenvIfPresent();

// Honor the sandbox egress proxy (Cowork / Claude Code set
// https_proxy=http://localhost:3128). Node's global fetch ignores those by
// default, so without this every fetch in a sandbox attempts a direct
// connection and fails with a murky "fetch failed". No-op outside a
// proxied environment. Must run before any fetch CALL — command actions
// (where fetch happens) run later, during parseAsync. See lib/net/proxy.ts.
import { installProxyDispatcherIfConfigured } from './lib/net/proxy.js';
installProxyDispatcherIfConfigured();

import { Command } from 'commander';
import { getPluginVersion } from './lib/plugin-version.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerBrandCommands } from './commands/brand.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerBootstrapCommand } from './commands/bootstrap.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerPrefetchCommand } from './commands/prefetch.js';
import { registerRenderCommand } from './commands/render.js';
import { registerSidecarCommands } from './commands/sidecar.js';
import { registerUiCommand } from './commands/ui.js';
import { registerDataCommands } from './commands/data.js';
import { registerFeedbackCommand } from './commands/feedback.js';
import { registerWelcomeCommand } from './commands/welcome.js';
import { registerVersionCommand } from './commands/version.js';
import { registerTelemetryCommands } from './commands/telemetry.js';
import { registerSkillCommands } from './commands/skill.js';
import { registerAmazonCommands } from './commands/amazon.js';
import { registerAdsCommands } from './commands/ads.js';
import { registerDoctorCommand } from './commands/doctor.js';
import {
  hasAcknowledgedConsent,
  markConsentAcknowledged,
  maybeFlush,
  track,
  readInstallId,
  EventName,
} from './lib/telemetry/index.js';
import { loadProfile } from './lib/profile/load.js';
import { saveProfile } from './lib/profile/save.js';

const program = new Command();

program
  .name('mixshift')
  .description(
    'Internal harness for the mixshift-ai plugin.\n' +
      'Invoked by Claude during skill execution. Not user-facing.',
  )
  .version(getPluginVersion())
  .option('--json', 'emit machine-readable JSON to stdout', false)
  .option('--verbose', 'verbose logging to stderr', false)
  .option(
    '--data-dir <path>',
    'override MIXSHIFT_DATA_DIR (default: ~/.mixshift)',
  )
  .option(
    '--surface <surface>',
    'force surface detection: claude_code | cowork | chat',
  );

// Register all command groups. Each module is responsible for its own
// subcommands and option parsing — cli.ts stays a registry.
registerProfileCommands(program);
registerAuthCommands(program);
registerBrandCommands(program);
registerBootstrapCommand(program);
registerValidateCommand(program);
registerPrefetchCommand(program);
registerRenderCommand(program);
registerSidecarCommands(program);
registerUiCommand(program);
registerDataCommands(program);
registerFeedbackCommand(program);
registerWelcomeCommand(program);
registerVersionCommand(program);
registerTelemetryCommands(program);
registerSkillCommands(program);
registerAmazonCommands(program);
registerAdsCommands(program);
registerDoctorCommand(program);

// First-run cross-cutting telemetry chore: show the consent notice once
// per install. Idempotent on subsequent runs. Skipped silently when
// telemetry is configured-off or the user has opted out, and skipped for
// the `telemetry` subcommand itself (so `mixshift telemetry status`
// doesn't print the notice while you're trying to inspect state).
//
// We no longer drain the queue here — the `finally` block at the bottom
// of this file flushes whatever's in the queue (including events emitted
// during this very invocation) before `process.exit`. One round trip
// instead of two, and it covers retries from prior failed flushes too.
const isTelemetryCommand = process.argv[2] === 'telemetry';
if (!isTelemetryCommand) {
  await showFirstRunNoticeIfNeeded();
  await trackLifecycleEvents();
}

/**
 * Fire harness-side lifecycle events: plugin.installed (first run on this
 * machine), plugin.updated (version differs from last observation),
 * cli.command_run (every invocation). Best-effort — wrapped in a single
 * try/catch and silenced on failure, so a busted telemetry path can't
 * break the CLI.
 *
 * Skipped for the `telemetry` subcommand itself (consistent with the
 * consent-notice gating above — `mixshift telemetry status` shouldn't
 * pollute its own diagnostic output).
 */
async function trackLifecycleEvents(): Promise<void> {
  try {
    // plugin.installed firing is now handled inside track() itself —
    // any first track() call where install_id was just created
    // enqueues a synthetic plugin.installed alongside the triggering
    // event. That decouples plugin.installed from "which command ran
    // first" (previously a SKILL.md emit would create install_id and
    // suppress this event for the subsequent `welcome` invocation).
    //
    // We just need plugin.updated + cli.command_run from this fn.
    const existingId = await readInstallId();
    const isFirstRun = !existingId;
    const currentVersion = getPluginVersion();

    // plugin.updated — fires when the running version differs from the
    // last version we recorded for this machine. Skipped on first run
    // (the synthetic plugin.installed covers that). For installs that
    // pre-date the last_plugin_version field, we capture the version
    // silently on first observation and start firing plugin.updated
    // next time.
    if (!isFirstRun) {
      const { profile, source } = await loadProfile();
      const lastVersion = profile.telemetry?.last_plugin_version;

      if (lastVersion && lastVersion !== currentVersion) {
        await track({
          event_name: EventName.PluginUpdated,
          payload: { from: lastVersion, to: currentVersion },
        });
      }

      // Always bump the last-seen version so the next upgrade is observable.
      if (lastVersion !== currentVersion) {
        const next = source === 'file' ? { ...profile } : profile;
        next.telemetry = {
          ...(next.telemetry ?? { opted_out: false }),
          last_plugin_version: currentVersion,
        };
        await saveProfile(next);
      }
    }

    // cli.command_run — every invocation. We log the command + subcommand
    // names ONLY, not the full argv. argv can contain SQL fragments,
    // file paths, or other values that would leak query content — the
    // privacy guarantee in `docs/privacy.md` explicitly excludes "query
    // results, credentials, chat content."
    //
    // This is the FIRST track() call in any harness invocation that
    // matters for plugin.installed semantics — if install_id was
    // freshly created (i.e. this IS the first run), the synthetic
    // plugin.installed will be enqueued just before this cli.command_run.
    await track({
      event_name: EventName.CliCommandRun,
      payload: {
        cmd: process.argv[2] ?? '(none)',
        subcmd: process.argv[3] ?? '(none)',
      },
    });
  } catch {
    // Telemetry can never break the CLI.
  }
}

async function showFirstRunNoticeIfNeeded(): Promise<void> {
  try {
    const acknowledged = await hasAcknowledgedConsent();
    if (acknowledged) return;

    const { isTelemetryEnabled } = await import('./lib/telemetry/consent.js');
    if (!(await isTelemetryEnabled())) return;

    printFirstRunNotice();
    await markConsentAcknowledged();
    await track({ event_name: EventName.ConsentAcknowledged });
  } catch {
    // Telemetry can never break the CLI.
  }
}

function printFirstRunNotice(): void {
  // Goes to stderr so it doesn't pollute --json output on stdout. Customers
  // see it once; --json scripts get clean output.
  process.stderr.write(
    '\n' +
      '━━ MixShift plugin — beta usage tracking ━━\n' +
      'During the beta, this plugin sends anonymized usage events to MixShift\n' +
      '(which skills run, query timings, onboarding funnel — not query results,\n' +
      'not credentials, not chat content). This lets us iterate on the plugin.\n' +
      '\n' +
      'Full disclosure + opt-out:\n' +
      '  https://github.com/miXshift/mx-claude-plugin/blob/main/docs/privacy.md\n' +
      '\n' +
      'Opt out anytime:  mixshift telemetry opt-out\n' +
      'Check status:     mixshift telemetry status\n' +
      'By continuing, you agree to this collection.\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '\n',
  );
}

// The one-and-only place `process.exit()` is allowed. See the
// "Exit / telemetry-flush contract" block at the top of this file.
try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  // Best-effort: fire a crash event so we see this in telemetry. We
  // await `track()` (not `void track(...)`) so the event is on disk
  // before the `finally` block flushes — otherwise the queue write
  // races the flush and we lose the crash.
  await track({
    event_name: EventName.PluginCrashed,
    outcome: 'failed',
    error_class: 'unhandled_exception',
    payload: { message, argv: process.argv.slice(2) },
  });
  process.exitCode = 1;
} finally {
  // Drain every event queued during this run before we exit. Adds
  // ~100-500ms when the queue has events; near-zero when empty
  // (single stat() call). Best-effort — `maybeFlush` swallows errors
  // and returns a status object.
  const flushResult = await maybeFlush();

  // Diagnostic logging — every flush attempt writes a one-line entry
  // to ~/.mixshift/telemetry/flush.log so "events ran but didn't reach
  // Supabase" debugging has a trail. View via:
  //   cat ~/.mixshift/telemetry/flush.log
  //   mixshift telemetry status   (last 5 lines surface inline)
  const { appendFlushLog } = await import('./lib/telemetry/flush-log.js');
  await appendFlushLog(flushResult);

  // Visible-to-the-user diagnostics:
  // - status='failed' always — flush errors should never be silent.
  // - MIXSHIFT_TELEMETRY_DEBUG=1 → log every flush (incl. sent/no_events)
  //   so we can see exactly what happened in Cowork transcripts.
  // - sent/no_events without the debug flag stays silent (no noise on
  //   the happy path).
  const debugFlag = process.env.MIXSHIFT_TELEMETRY_DEBUG === '1';
  if (flushResult.status === 'failed') {
    process.stderr.write(
      `[mixshift telemetry] flush failed: ${flushResult.error ?? 'unknown'} (sent ${flushResult.events_sent} before failure; remaining events stay queued)\n`,
    );
  } else if (debugFlag && flushResult.status === 'sent') {
    process.stderr.write(
      `[mixshift telemetry] flush sent ${flushResult.events_sent} event(s)\n`,
    );
  } else if (debugFlag && flushResult.status === 'no_events') {
    process.stderr.write('[mixshift telemetry] flush: no events queued\n');
  } else if (debugFlag && flushResult.status === 'no_endpoint') {
    process.stderr.write(
      '[mixshift telemetry] flush: endpoint not configured (events stay queued)\n',
    );
  }
}
process.exit(process.exitCode ?? 0);
