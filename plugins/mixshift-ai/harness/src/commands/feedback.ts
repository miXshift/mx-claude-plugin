import type { Command } from 'commander';
import { resolveActorEmail } from '../lib/auth/actor-email.js';
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
 * Discord channel server-side. No
 * Discord webhook URL ever lives in the plugin.
 *
 * If the flush fails (no network, Supabase down, …), the event stays in
 * the local queue and gets retried on the next CLI invocation — feedback
 * is never lost, just delayed.
 *
 * Identity is best-effort (see resolveActorEmail): we attach the user's email
 * when we can resolve one (profile, else the credential person_label), but a
 * missing identity NEVER blocks the send — feedback goes out anonymously
 * rather than being lost at an email gate (which used to downgrade it to a
 * bare cli.command_run row).
 *
 * Note: this command intentionally keeps its mid-handler `maybeFlush()`
 * call (unlike every other command, which lets cli.ts's finally-block
 * drain the queue). The flush *result* is what tells us whether to
 * print "✓ Sent" vs "• Queued locally" to the user — that delivery
 * confirmation UX requires inspecting the flush status synchronously
 * inside the action handler. The cli.ts finally-block still runs after
 * us; it's just a no-op because we've already drained the queue.
 */
export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback <message>')
    .description(
      'Send feedback to MixShift ops (bug reports, feature requests, comments, capability gaps).',
    )
    .option(
      '--category <cat>',
      // capability_gap: the user needed something MixShift has no operation for,
      // so the work went somewhere else (usually hand-keying in Amazon's
      // console). It is its own category because nothing else records it: the
      // CLI refuses an uncataloged operation id BEFORE issuing a request, so a
      // gap the agent correctly routes around emits no event at all. The better
      // the agent behaves, the more invisible the gap -- twice in Aug 2026 the
      // only reason we learned of one was a human choosing to type it out.
      'bug | feature_request | comment | capability_gap | other',
      'comment',
    )
    .option('--skill <id>', 'which skill triggered this (context)')
    .option('--command <cmd>', 'which command triggered this (context)')
    .option('--brand <slug>', 'which brand was involved (context)')
    .action(
      async (
        message: string,
        opts: {
          category: 'bug' | 'feature_request' | 'comment' | 'capability_gap' | 'other';
          skill?: string;
          command?: string;
          brand?: string;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          // Resolve the best-known identity, but NEVER block on it: feedback is
          // a solicited send, so a missing email must not drop the message. (It
          // used to throw here, downgrading feedback to a generic
          // cli.command_run row.) Falls back profile -> credential
          // person_label -> anonymous.
          const userEmail = await resolveActorEmail(root.dataDir);

          await track(
            {
              event_name: EventName.FeedbackSubmitted,
              // Do NOT set email here. track() auto-stamps email = the TENANT
              // login (from the token) and person_label = the actor. Passing the
              // resolved actor address as `email` would collapse email ==
              // person_label for feedback.submitted (which fans out to Discord)
              // AND re-introduce the shared-login collapse this fix removes,
              // because resolveActorEmail() reads the person-mirrored
              // profile.user.email. `userEmail` is still used below for the
              // `attributed` flag.
              payload: {
                category: opts.category,
                // Feedback is a primary evidence channel. Preserve the complete
                // report for telemetry storage and downstream triage; any
                // presentation-specific bound belongs in the Discord fan-out,
                // not at capture time.
                message,
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
                  attributed: Boolean(userEmail),
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
              `\n✓ Feedback sent to MixShift ops. Thanks!\n` +
                (userEmail
                  ? ''
                  : `  (Sent without an account identity. Run \`mixshift auth login\` so we can follow up.)\n`),
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
          // No exitCode set — "queued" isn't a failure (the event is on
          // disk and will retry on the next mixshift invocation), so the
          // command always succeeds with exit 0.
        } catch (err) {
          const message_ = err instanceof Error ? err.message : String(err);
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ status: 'error', message: message_ }, null, 2) + '\n',
            );
          } else {
            process.stderr.write(`error: ${message_}\n`);
          }
          process.exitCode = 1;
        }
      },
    );
}
