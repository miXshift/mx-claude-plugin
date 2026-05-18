import type { Command } from 'commander';
import { loadProfile } from '../lib/profile/load.js';
import { track, maybeFlush, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

/**
 * `mixshift feedback` — user-facing channel for bug reports, feature
 * requests, and comments.
 *
 * Delivery model: emit a `feedback.submitted` telemetry event and force
 * a synchronous flush so the user gets an immediate "delivered" signal.
 * The Supabase database trigger fans the event out to the MixShift ops
 * Discord channel server-side (see internal/SUPABASE-SETUP.md §10). No
 * Discord webhook URL ever lives in the plugin.
 *
 * If the flush fails (no network, Supabase down, …), the event stays in
 * the local queue and gets retried on the next CLI invocation — feedback
 * is never lost, just delayed.
 */
export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback <message>')
    .description(
      'Send feedback to MixShift ops (bug reports, feature requests, comments).',
    )
    .option(
      '--category <cat>',
      'bug | feature_request | comment | other',
      'comment',
    )
    .option('--skill <id>', 'which skill triggered this (context)')
    .option('--command <cmd>', 'which command triggered this (context)')
    .option('--brand <slug>', 'which brand was involved (context)')
    .action(
      async (
        message: string,
        opts: {
          category: 'bug' | 'feature_request' | 'comment' | 'other';
          skill?: string;
          command?: string;
          brand?: string;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const { profile } = await loadProfile(root.dataDir);
          const userEmail = profile.user?.email;
          if (!userEmail) {
            throw new Error(
              'No user email on file. Run `mixshift auth setup` first so we can attach an identity to your feedback.',
            );
          }

          await track(
            {
              event_name: EventName.FeedbackSubmitted,
              email: userEmail,
              payload: {
                category: opts.category,
                message: message.slice(0, 2000),
                skill_id: opts.skill,
                command: opts.command,
                brand_slug: opts.brand,
              },
            },
            root.dataDir,
          );

          // Force a synchronous flush so the user gets immediate
          // delivery confirmation. The standard background flush would
          // pick this up on the next CLI invocation, but feedback
          // benefits from "press Enter, see ✓ Sent" UX.
          const flush = await maybeFlush(root.dataDir);
          const delivered = flush.status === 'sent';

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: delivered ? 'ok' : 'queued',
                  flush_status: flush.status,
                  events_sent: flush.events_sent,
                  ...(flush.error ? { error: flush.error } : {}),
                },
                null,
                2,
              ) + '\n',
            );
          } else if (delivered) {
            process.stderr.write(
              `\n✓ Feedback sent to MixShift ops. Thanks!\n`,
            );
          } else {
            // Event is on disk in the queue; will retry on the next CLI
            // invocation. Use stderr but with a soft warning shape, not
            // an error — the feedback isn't lost.
            process.stderr.write(
              `\n• Feedback queued locally (couldn't reach the telemetry endpoint right now).\n` +
                `  It will be sent automatically on your next mixshift command.\n` +
                (flush.error ? `  Reason: ${flush.error}\n` : ''),
            );
          }
          process.exit(delivered ? 0 : 0);
          // Note: exit 0 in both cases. "Queued" isn't a failure — the
          // feedback is captured locally and will retry.
        } catch (err) {
          const message_ = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message: message_ }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message_}\n`);
          }
          process.exit(1);
        }
      },
    );
}
