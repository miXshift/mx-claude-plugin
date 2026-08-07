/**
 * `mixshift version` — show installed version + check for updates.
 *
 * Used by users who want to confirm what they're running and whether an
 * update is available. The welcome flow also surfaces the same staleness
 * banner automatically; this command exists for the "I want to check
 * manually" case (e.g. when something seems wrong and you want to rule
 * out version mismatch).
 *
 * FEEDBACK 36645/36672/36728 (the definitive report is 36728): this command
 * used to compare the SESSION's loaded payload (`current`, from
 * getPluginVersion()) against the latest PUBLISHED version and call that
 * `isStale`. A plugin host extracts that payload once per app launch and
 * never re-reads it for a new chat/session in the same running process — so
 * when an update had already landed on disk (`claude plugin update`
 * succeeded, or the host auto-synced) but the app itself was never fully
 * quit-and-relaunched, this command told an already-updated user to update
 * again. It now also reads the host's own install record
 * (../lib/install-record.ts) and reports which of three situations the user
 * is actually in: in sync, behind the install (already updated, just needs a
 * relaunch), or install-state unreadable on this surface. `current` keeps
 * its exact old meaning for JSON back-compat; `installed` and
 * `session_behind_install` are additive.
 */

import type { Command } from 'commander';
import { getPluginVersion } from '../lib/plugin-version.js';
import { checkForUpdate, renderUpdateBanner } from '../lib/version-check.js';
import {
  readInstallRecord,
  evaluateInstallSituation,
  renderSessionBehindInstall,
  type InstallSituation,
} from '../lib/install-record.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

interface VersionCommandOptions {
  skipCheck?: boolean;
  forceFetch?: boolean;
}

/**
 * The full `mixshift version --json` shape. `current`/`latest`/`isStale`/
 * `releaseUrl`/`fetched` keep their pre-existing meanings for back-compat —
 * existing JSON consumers (the mx-update skill's Step 1) that only look at
 * those fields see no behavior change UNLESS an install record is readable,
 * in which case `isStale`/`releaseUrl` are judged against `installed`
 * instead of the stale `current` snapshot (that IS the fix — see
 * `staleBasis` for which basis actually won).
 */
export interface VersionReport {
  /** The running session's payload version. Unchanged meaning. */
  current: string;
  /** The host's on-disk install record's version, or null if it could not be
   *  read (missing file, unsupported surface, malformed, or ambiguous). */
  installed: string | null;
  /** Latest version published on the marketplace, or null if unknown. */
  latest: string | null;
  /** True iff `staleBasis`'s version is behind `latest`. */
  isStale: boolean;
  /** Which version `isStale` was judged against. 'installed' whenever the
   *  install record was readable (the fix); 'current' only as the fallback
   *  when it wasn't. */
  staleBasis: 'installed' | 'current';
  /** True iff the install is readable and newer than this session's running
   *  payload — the "you already updated, this session just hasn't reloaded"
   *  situation. Computed with no dependency on `latest` (purely local). */
  session_behind_install: boolean;
  releaseUrl: string | null;
  fetched: boolean;
}

export function buildVersionReport(opts: {
  current: string;
  installed: string | null;
  latest: string | null;
  fetched: boolean;
}): VersionReport {
  const situation: InstallSituation = evaluateInstallSituation({
    current: opts.current,
    installed: opts.installed,
    latest: opts.latest,
  });
  return {
    current: opts.current,
    installed: opts.installed,
    latest: opts.latest,
    isStale: situation.isStale,
    staleBasis: situation.staleBasis,
    session_behind_install: situation.sessionBehindInstall,
    releaseUrl: situation.releaseUrl,
    fetched: opts.fetched,
  };
}

/** The version that "today's behavior" (up to date / ahead-of-release
 *  comparisons) should be displayed against: the install record when it's
 *  readable, else the running session's payload. */
function displayVersion(report: VersionReport): string {
  return report.staleBasis === 'installed' && report.installed !== null
    ? report.installed
    : report.current;
}

const INSTALL_UNVERIFIED_LINE =
  '  (install state could not be verified on this surface)\n';

/**
 * Render the terminal (non-JSON, non-`--skip-check`) body of `mixshift
 * version`: everything written to stdout after the `mixshift-ai vX` header
 * line. Pure and exported so the two independent facts this command must
 * surface (feedback 36645/36672/36728, then the follow-up fix below) are
 * unit-testable without a real filesystem/network round trip.
 *
 * FIX: `session_behind_install` and `isStale` are independent — the install
 * record can be both newer than this session AND itself behind `latest`
 * (current < installed < latest). The old version of this function early-
 * returned on `session_behind_install` before `latest`/`isStale` were ever
 * printed, so a real available update stayed invisible and the shared
 * "the update already succeeded" copy was asserted even when it hadn't
 * (there was still a further release pending). Both facts now reach the
 * user in one pass: the behind-install notice never short-circuits the
 * latest/isStale evaluation below it.
 */
export function renderVersionOutput(report: VersionReport): string {
  const out: string[] = [];
  out.push(`mixshift-ai v${report.current}\n`);

  // Purely local, no network required. Does NOT return early: `isStale` may
  // ALSO be true (a further release beyond what's already installed), and
  // that fact still needs to print below.
  if (report.session_behind_install) {
    out.push(
      renderSessionBehindInstall({
        installed: report.installed,
        current: report.current,
        installIsStale: report.isStale,
      }),
    );
  }

  if (report.latest === null) {
    out.push('  (could not check for updates; run with --force-fetch to retry)\n');
    if (report.installed === null) {
      out.push(INSTALL_UNVERIFIED_LINE);
    }
    return out.join('');
  }

  if (report.isStale) {
    out.push(
      renderUpdateBanner(
        {
          current: displayVersion(report),
          latest: report.latest,
          isStale: true,
          releaseUrl: report.releaseUrl,
          fetched: report.fetched,
        },
        'terminal',
      ),
    );
  } else if (displayVersion(report) === report.latest) {
    out.push(`  up to date (latest is v${report.latest})\n`);
  } else {
    // displayVersion > latest — running a pre-release / dev build
    // ahead of what's published on the marketplace.
    out.push(`  ahead of public release (latest published is v${report.latest})\n`);
  }

  if (report.installed === null) {
    out.push(INSTALL_UNVERIFIED_LINE);
  }

  return out.join('');
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

        const [result, installRecord] = await Promise.all([
          checkForUpdate({
            dataDirOverride: root.dataDir,
            forceFetch: opts.forceFetch,
          }),
          readInstallRecord(),
        ]);

        const report = buildVersionReport({
          current,
          installed: installRecord?.installedVersion ?? null,
          latest: result.latest,
          fetched: result.fetched,
        });

        if (root.json) {
          process.stdout.write(JSON.stringify(report, null, 2) + '\n');
          return;
        }

        process.stdout.write(renderVersionOutput(report));
      },
    );
}
