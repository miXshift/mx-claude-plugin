/**
 * `mixshift whatsnew` — render recent release notes from the CHANGELOG.
 *
 * The in-plugin release-notes surface: instead of sending users to a web page,
 * we fetch the canonical CHANGELOG (24h cache, offline-graceful) and render the
 * notes relevant to them. The update banner points here, so the flow is
 * "update available -> `mixshift whatsnew` -> see what changed -> update".
 *
 * Default selection is "what's new for you": entries newer than your installed
 * version (what you'd gain by updating), or your own version's notes when you
 * are current. `--since <v>` and `--all` widen it.
 */

import type { Command } from 'commander';
import { getPluginVersion } from '../lib/plugin-version.js';
import {
  loadChangelog,
  entriesSince,
  whatsNewFor,
  CHANGELOG_RELEASES_URL,
  type ChangelogEntry,
} from '../lib/changelog.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerWhatsnewCommand(program: Command): void {
  program
    .command('whatsnew')
    .description(
      'Show recent mixshift-ai release notes (from the CHANGELOG). Cache: 24h.',
    )
    .option(
      '--format <type>',
      'output format: `terminal` (default) | `chat` (markdown for Claude/Cowork)',
      'terminal',
    )
    .option('--since <version>', 'show every release newer than this version (e.g. 0.5.39)')
    .option('--all', 'show the entire changelog', false)
    .option('--force-fetch', 'bypass the 24h cache and re-fetch', false)
    .action(
      async (
        opts: { format?: string; since?: string; all?: boolean; forceFetch?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const current = getPluginVersion();
        const { entries, source, error } = await loadChangelog({
          dataDirOverride: root.dataDir,
          forceFetch: opts.forceFetch,
        });

        const selected = opts.all
          ? entries
          : opts.since
            ? entriesSince(entries, opts.since)
            : whatsNewFor(entries, current);

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: entries.length ? 'ok' : 'unavailable',
                current,
                latest: entries[0]?.version ?? null,
                source,
                ...(error ? { error } : {}),
                entries: selected,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        if (entries.length === 0) {
          process.stderr.write(
            `\nCouldn't load release notes right now${error ? ` (${error})` : ''}.\n` +
              `  See ${CHANGELOG_RELEASES_URL}, or try again with --force-fetch.\n`,
          );
          return;
        }

        const format = opts.format === 'chat' ? 'chat' : 'terminal';
        process.stdout.write(render(selected, current, format) + '\n');
      },
    );
}

function render(
  entries: ChangelogEntry[],
  current: string,
  format: 'terminal' | 'chat',
): string {
  if (entries.length === 0) {
    return format === 'chat'
      ? `You're on **${current}**. No newer release notes.`
      : `You're on ${current}. No newer release notes.`;
  }
  if (format === 'chat') {
    const out: string[] = [`**What's new in mixshift-ai** (you're on ${current}):`, ''];
    for (const e of entries) out.push(`## ${e.version}`, '', e.notes, '');
    return out.join('\n').trimEnd();
  }
  const out: string[] = ['', `What's new in mixshift-ai (you're on ${current}):`];
  for (const e of entries) out.push('', `-- ${e.version} --`, '', e.notes);
  return out.join('\n');
}
