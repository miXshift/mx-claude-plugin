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
import { readCachedLatestVersion } from '../lib/version-check.js';
import {
  loadUpdateNoticeState,
  saveUpdateNoticeState,
} from '../lib/update-notice-state.js';
import { track, EventName } from '../lib/telemetry/index.js';
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
    .option(
      '--dismiss',
      'stop the proactive session-start update notice until a newer version ships',
      false,
    )
    .action(
      async (
        opts: {
          format?: string;
          since?: string;
          all?: boolean;
          forceFetch?: boolean;
          dismiss?: boolean;
        },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        const current = getPluginVersion();

        if (opts.dismiss) {
          await dismissUpdateNotice(root, current);
          return;
        }

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

/**
 * `mixshift whatsnew --dismiss` — stop the SessionStart hook's proactive
 * update notice (see hooks/session-start.mjs stage 2 + lib/update-notice-
 * state.ts) from repeating.
 *
 * "Latest known version" comes from the version-check cache the hook itself
 * maintains (~/.mixshift/version-check.json) when present, so dismissing
 * matches whatever version the notice actually named; falling back to the
 * currently-installed version means a dismiss still does something sane on a
 * data dir that has never run a version check (nothing to suppress yet, but
 * the command still succeeds instead of erroring).
 */
async function dismissUpdateNotice(root: RootOptions, current: string): Promise<void> {
  const latest = (await readCachedLatestVersion(root.dataDir)) ?? current;

  const state = await loadUpdateNoticeState(root.dataDir);
  state.dismissed_version = latest;
  try {
    await saveUpdateNoticeState(state, root.dataDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (root.json) {
      process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
    } else {
      process.stderr.write(`error: could not save dismiss state: ${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  await track({
    event_name: EventName.UpdateDismissed,
    payload: { latest },
  });

  const message = `Got it. You will not be notified again about version ${latest} until a newer version ships.`;
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'ok', dismissed_version: latest }, null, 2) + '\n');
    return;
  }
  process.stdout.write(message + '\n');
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
