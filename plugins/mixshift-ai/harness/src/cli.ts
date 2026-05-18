/**
 * mixshift — internal CLI for the mixshift-ai plugin.
 *
 * Not user-facing. Claude invokes this via the Bash tool during skill
 * execution. End users interact through slash commands and natural language.
 *
 * Architecture: see docs/productization/HARNESS-REWRITE.md
 */

// Load `.env.local` FIRST — before any module reads process.env (mainly
// loadPluginDefaults which checks for MIXSHIFT_TELEMETRY_ENDPOINT and
// MIXSHIFT_TELEMETRY_APIKEY overrides).
// Best-effort: missing or unreadable file is a silent no-op, the CLI
// continues with whatever the shell already set.
import { loadDotenvIfPresent } from './lib/env/load-dotenv.js';
await loadDotenvIfPresent();

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
import { registerTelemetryCommands } from './commands/telemetry.js';
import {
  hasAcknowledgedConsent,
  markConsentAcknowledged,
  maybeFlush,
  track,
  EventName,
} from './lib/telemetry/index.js';

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
registerTelemetryCommands(program);

// Before commander parses, do two cross-cutting telemetry chores:
//   1. Show the first-run consent notice (once per install) so the user
//      knows what's collected during beta. Idempotent; subsequent runs
//      skip silently.
//   2. Drain the local telemetry queue from prior invocations. Fire-and-
//      forget — we don't await it; it'll race against process exit and
//      either complete (small queue, fast network) or leave events in
//      the queue for next time. Best-effort by design.
//
// Both are skipped silently when telemetry is configured-off (no Supabase
// endpoint) or when the user has opted out. The `telemetry` subcommand
// itself is also skipped (so `mixshift telemetry status` doesn't drain or
// notice-print — predictable for users debugging telemetry state).
const isTelemetryCommand = process.argv[2] === 'telemetry';
if (!isTelemetryCommand) {
  await runCrossCuttingTelemetry();
}

async function runCrossCuttingTelemetry(): Promise<void> {
  try {
    // First-run notice. Only print if telemetry is actually going to fire
    // (no point telling the user about collection that won't happen).
    const acknowledged = await hasAcknowledgedConsent();
    if (!acknowledged) {
      const { isTelemetryEnabled } = await import('./lib/telemetry/consent.js');
      if (await isTelemetryEnabled()) {
        printFirstRunNotice();
        await markConsentAcknowledged();
        await track({ event_name: EventName.ConsentAcknowledged });
      }
    }
    // Drain queued events synchronously. We used to fire-and-forget here,
    // but for a one-shot first-run user (e.g. `mixshift welcome` from a
    // fresh Cowork install) the harness exits via `process.exit()` before
    // the in-flight HTTP request can complete — and there's no "next CLI
    // invocation" to retry on. Awaiting adds ~100-500ms on startup (the
    // POST to Supabase), but for empty queues this returns "no_events"
    // almost instantly.
    await maybeFlush();
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

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  // Best-effort: fire a crash event so we see this in telemetry.
  void track({
    event_name: EventName.PluginCrashed,
    outcome: 'failed',
    error_class: 'unhandled_exception',
    payload: { message, argv: process.argv.slice(2) },
  });
  process.exit(1);
});
