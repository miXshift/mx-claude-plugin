import type { Command } from 'commander';
import { platform, release } from 'node:os';
import { loadProfile } from '../lib/profile/load.js';
import { loadPluginDefaults } from '../lib/defaults/load.js';
import { postWebhook } from '../lib/webhook/discord.js';
import { track, EventName } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

const PLUGIN_VERSION = '0.0.1';

export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback <message>')
    .description(
      'Send feedback to MixShift ops via the Discord webhook (bug reports, feature requests, comments).',
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
          const defaults = await loadPluginDefaults();
          const userEmail = profile.user?.email;
          if (!userEmail) {
            throw new Error(
              'No user email on file. Run `mixshift auth setup` first so we can attach an identity to your feedback.',
            );
          }

          const result = await postWebhook(
            defaults.auth.ip_whitelist_webhook,
            {
              kind: 'user_feedback',
              user_email: userEmail,
              plugin_version: PLUGIN_VERSION,
              os: `${platform()} ${release()}`,
              message,
              category: opts.category,
              ...(opts.skill || opts.command || opts.brand
                ? {
                    context: {
                      ...(opts.skill ? { skill_id: opts.skill } : {}),
                      ...(opts.command ? { command: opts.command } : {}),
                      ...(opts.brand ? { brand_slug: opts.brand } : {}),
                    },
                  }
                : {}),
            },
          );

          // Telemetry: also log feedback to Supabase (in addition to
          // Discord). Discord routes for real-time human attention;
          // Supabase routes for analyzable feedback firehose.
          await track(
            {
              event_name: EventName.FeedbackSubmitted,
              email: userEmail,
              outcome: result.ok ? 'ok' : 'failed',
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

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: result.ok ? 'ok' : 'error',
                  ...(result.ok ? {} : { message: result.error }),
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            if (result.ok) {
              process.stderr.write(
                `\n✓ Feedback sent to MixShift ops. Thanks!\n`,
              );
            } else {
              process.stderr.write(
                `\n✗ Could not send feedback: ${result.error ?? 'unknown error'}\n` +
                  `  Save your message locally and email it to MixShift if you want to be sure it gets to us.\n`,
              );
              process.exit(1);
            }
          }
          process.exit(result.ok ? 0 : 1);
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
