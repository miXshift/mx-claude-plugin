/**
 * `mixshift version` — show installed version + check for updates.
 *
 * Used by users who want to confirm what they're running and whether an
 * update is available. The welcome flow also surfaces the same staleness
 * banner automatically; this command exists for the "I want to check
 * manually" case (e.g. when something seems wrong and you want to rule
 * out version mismatch).
 */

import type { Command } from 'commander';
import { getPluginVersion } from '../lib/plugin-version.js';
import {
  checkForUpdate,
  renderUpdateBanner,
} from '../lib/version-check.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface VersionCommandOptions {
  skipCheck?: boolean;
  forceFetch?: boolean;
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description(
      'Show the installed mixshift-ai plugin version and check for ' +
        'updates against the public marketplace.json. Cache: 24h.',
    )
    .option(
      '--skip-check',
      'skip the update check (just print current version)',
      false,
    )
    .option(
      '--force-fetch',
      'bypass the 24h cache and re-fetch from GitHub',
      false,
    )
    .action(
      async (opts: VersionCommandOptions, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const current = getPluginVersion();

        if (opts.skipCheck) {
          if (root.json) {
            process.stdout.write(
              JSON.stringify({ version: current }, null, 2) + '\n',
            );
          } else {
            process.stdout.write(`mixshift-ai v${current}\n`);
          }
          return;
        }

        const result = await checkForUpdate({
          dataDirOverride: root.dataDir,
          forceFetch: opts.forceFetch,
        });

        if (root.json) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }

        process.stdout.write(`mixshift-ai v${result.current}\n`);
        if (result.latest === null) {
          process.stdout.write(
            '  (could not check for updates; run with --force-fetch to retry)\n',
          );
          return;
        }
        if (result.isStale) {
          process.stdout.write(renderUpdateBanner(result, 'terminal'));
        } else if (result.current === result.latest) {
          process.stdout.write(`  up to date (latest is v${result.latest})\n`);
        } else {
          // current > latest — running a pre-release / dev build
          // ahead of what's published on the marketplace.
          process.stdout.write(
            `  ahead of public release (latest published is v${result.latest})\n`,
          );
        }
      },
    );
}
