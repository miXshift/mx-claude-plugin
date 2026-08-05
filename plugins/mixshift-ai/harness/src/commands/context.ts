/**
 * `mixshift context <status|pull|push|sync|migrate>` — org-shared brand
 * context sync. The server (/api/context on mx-legacy-auth) is the source
 * of truth; the local files under ~/.mixshift/clients/<brand>/ are the
 * cache the skills read. All logic lives in lib/context-sync/; this file
 * only parses options and formats the structured results.
 */

import type { Command } from 'commander';
import { createContextSyncClient } from '../lib/context-sync/client.js';
import {
  computeStatus,
  migrate,
  pull,
  push,
  sync,
  type BrandActionResult,
  type EngineOptions,
} from '../lib/context-sync/engine.js';
import {
  maybeAutoSync,
  AUTOSYNC_ENV,
  AUTOSYNC_THROTTLE_MS,
} from '../lib/context-sync/autosync.js';
import { brandDirExists, listLocalBrands } from '../lib/context-sync/local.js';
import type { DocActionReport, DocStatusReport, WireManifestBrand } from '../lib/context-sync/types.js';
import { syncStakes, type StakeSyncResult } from '../lib/timeline/stake-sync.js';
import { track, EventName, type EventNameValue } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description(
      'Org-shared brand context sync. The MixShift service is the source of ' +
        'truth; the local files under ~/.mixshift/clients/ are the cache the ' +
        'skills read.',
    );

  context
    .command('status')
    .description(
      'Compare local brand context docs against the org store: per doc, ' +
        'whether it is in sync, locally edited, moved server-side, or diverged.',
    )
    .option('--brand <slug>', 'limit to one brand (default: all local brands)')
    .action(async (opts: { brand?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      try {
        const setup = await resolveBrandsAndManifest(opts.brand, root);
        if (!setup) return;
        const { brands, engineOptions } = setup;

        const results: Array<{ ok: true; brand: string; docs: DocStatusReport[] }> = [];
        for (const brand of brands) {
          const r = await computeStatus(brand, engineOptions);
          if (!r.ok) {
            emitError(r.message, root);
            return;
          }
          results.push(r);
        }

        const conflicts = results.reduce(
          (n, r) => n + r.docs.filter((d) => d.verdict === 'diverged').length,
          0,
        );
        const serverDeleted = results.reduce(
          (n, r) => n + r.docs.filter((d) => d.verdict === 'server-deleted').length,
          0,
        );
        // 'local-only' = a doc that exists here but was never seen on the
        // server: local work not yet accruing to the team. Distinct from
        // 'local-ahead' (already shared, just edited since) — that one IS in
        // the org store and pushes on the next sync, so it is not "unshared".
        const unshared = results.reduce(
          (n, r) => n + r.docs.filter((d) => d.verdict === 'local-only').length,
          0,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                brands: results.map((r) => ({ brand: r.brand, docs: r.docs })),
                conflicts,
                unshared,
              },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        const lines: string[] = [];
        for (const r of results) {
          for (const d of r.docs) {
            lines.push(
              [
                r.brand.padEnd(20),
                d.key.padEnd(24),
                d.verdict.padEnd(14),
                (d.locallyModified ? 'modified' : '-').padEnd(9),
                `rev ${d.serverRevision ?? '-'} (synced ${d.syncedRevision ?? '-'})`,
              ].join('  '),
            );
          }
          if (r.docs.length === 0) {
            lines.push(`${r.brand.padEnd(20)}  (no syncable docs locally or on the server)`);
          }
        }
        lines.push('');
        if (conflicts > 0) {
          lines.push(
            `${conflicts} conflict(s): resolve with \`mixshift context pull --brand <slug> --force\` ` +
              '(take the server version) or `mixshift context push --brand <slug> --force` (overwrite it).',
          );
          lines.push('');
        }
        if (serverDeleted > 0) {
          lines.push(
            `${serverDeleted} doc(s) deleted from the org store: delete the local file to accept ` +
              'the deletion, or recreate it with `mixshift context push --brand <slug> --force`.',
          );
          lines.push('');
        }
        // Unshared work gets a per-brand CTA (the push command is brand-scoped,
        // so name the slug) so "am I accruing to the team?" is answerable at a
        // glance and the commit path is always in reach.
        for (const r of results) {
          const localOnly = r.docs.filter((d) => d.verdict === 'local-only').length;
          if (localOnly > 0) {
            lines.push(
              `${localOnly} doc(s) not yet shared with your team: run ` +
                `\`mixshift context push --brand ${r.brand}\` to commit them.`,
            );
            lines.push('');
          }
        }
        process.stdout.write(lines.join('\n') + '\n');
        return;
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), root);
        return;
      }
    });

  registerActionSubcommand(context, {
    name: 'pull',
    description:
      'Fetch server-side changes into the local cache. Only touches docs the ' +
        'server moved; local edits are skipped (push them instead). --force ' +
        'overwrites diverged docs with the server version.',
    hasForce: true,
    run: (brand, opts) => pull(brand, opts),
    eventName: EventName.ContextPullCompleted,
  });

  registerActionSubcommand(context, {
    name: 'push',
    description:
      'Upload local changes to the org store. Only touches docs edited ' +
        'locally; server-side moves are skipped (pull them instead). --force ' +
        'overwrites diverged docs with the local version. Also publishes the ' +
        "brand's structural_events to the timeline as declared stakes " +
        '(idempotent).',
    hasForce: true,
    run: (brand, opts) => push(brand, opts),
    eventName: EventName.ContextPushCompleted,
    syncStakesAfter: true,
  });

  registerActionSubcommand(context, {
    name: 'sync',
    description:
      'Two-way non-destructive sync: pull every non-conflicting server ' +
        'change, push every non-conflicting local change, and list diverged ' +
        'docs as conflicts. Never merges content. --quiet is the ' +
        'machine-friendly post-run form for skill flows (the preflight ' +
        'auto-sync is pull-only; pushing local changes stays an explicit ' +
        'opt-in via this command): silent unless something was pulled, ' +
        'pushed, created, conflicted, or errored, or a structural event was ' +
        'recorded on the timeline or failed to reach it. Conflicts still ' +
        "exit 0 (only per-doc errors are non-zero). Also publishes the brand's " +
        'structural_events to the timeline as declared stakes (idempotent).',
    hasForce: false,
    hasQuiet: true,
    run: (brand, opts) => sync(brand, opts),
    eventName: EventName.ContextSyncCompleted,
    syncStakesAfter: true,
  });

  registerAutosyncSubcommand(context);

  context
    .command('migrate')
    .description(
      'First-push flow: seed the org store from the local brand dirs. ' +
        'Validates context.yaml, uploads every doc (identical server content ' +
        'dedupes as noop; differing content surfaces as a conflict), and ' +
        'writes the sync state so status/pull/push/sync take over.',
    )
    .option('--brand <slug>', 'limit to one brand (default: all local brands)')
    .action(async (opts: { brand?: string }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        // Migrate seeds the org store FROM local brand dirs, so an explicit
        // --brand must exist locally — a typo is an error, not a no-op.
        if (opts.brand && !(await brandDirExists(opts.brand, root.dataDir))) {
          emitError(
            `brand '${opts.brand}' has no local directory under ` +
              '~/.mixshift/clients/ — migrate seeds the org store from local brand dirs',
            root,
          );
          return;
        }
        const brands = opts.brand
          ? [opts.brand]
          : await listLocalBrands(root.dataDir);
        if (brands.length === 0) {
          emitNoBrands(root);
          return;
        }

        const result = await migrate({
          brands,
          dataDirOverride: root.dataDir,
          client: createContextSyncClient({ dataDirOverride: root.dataDir }),
        });
        if (!result.ok) {
          emitError(result.message, root);
          return;
        }

        // Migrate is the FIRST-publish flow, so it is exactly where a brand's
        // curated structural_events first reach the timeline (#37499).
        const stakeRuns: Array<{ brand: string; result: StakeSyncResult }> = [];
        for (const b of result.brands) {
          stakeRuns.push({
            brand: b.brand,
            result: await syncStakes(b.brand, { dataDirOverride: root.dataDir }),
          });
        }

        const allReports = result.brands.flatMap((b) => b.reports);
        const counts = countActions(allReports);
        await track(
          {
            event_name: EventName.ContextMigrateCompleted,
            outcome: counts.error > 0 ? 'failed' : 'ok',
            duration_ms: Date.now() - t0,
            payload: {
              brands: result.brands.length,
              ...counts,
              stake_created: stakeRuns.reduce((n, s) => n + s.result.created, 0),
              stake_duplicates: stakeRuns.reduce((n, s) => n + s.result.duplicates, 0),
              stake_failed: stakeRuns.reduce((n, s) => n + s.result.failed, 0),
            },
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                brands: result.brands,
                counts,
                stake_events: stakeRuns.map((s) => s.result),
              },
              null,
              2,
            ) + '\n',
          );
        } else {
          const lines: string[] = [];
          for (const b of result.brands) {
            if (b.reports.length === 0) {
              lines.push(`${b.brand.padEnd(20)}  (no syncable docs)`);
              continue;
            }
            for (const r of b.reports) {
              lines.push(formatReportLine(b.brand, r));
            }
          }
          for (const line of stakeLines(stakeRuns)) lines.push(line);
          lines.push('');
          lines.push(summaryLine(counts));
          process.stdout.write(lines.join('\n') + '\n');
        }
        process.exitCode = counts.error > 0 ? 1 : 0;
        return;
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), root);
        return;
      }
    });
}

// ---------------------------------------------------------------------------
// Shared pull/push/sync wiring
// ---------------------------------------------------------------------------

interface ActionSpec {
  name: 'pull' | 'push' | 'sync';
  description: string;
  hasForce: boolean;
  /** sync only: --quiet suppresses human output when nothing happened. */
  hasQuiet?: boolean;
  run: (
    brand: string,
    opts: EngineOptions & { force?: boolean },
  ) => Promise<BrandActionResult>;
  eventName: EventNameValue;
  /** push/sync only (#37499): after the doc run, publish each brand's
   *  structural_events to the timeline as declared stakes. Idempotent and
   *  advisory — stake failures are reported but never change the exit code
   *  (the doc contract stays exactly what it was). */
  syncStakesAfter?: boolean;
}

/** The report actions --quiet considers "something happened": content moved
 *  or needs attention. up-to-date/noop/skipped are standing conditions. */
const QUIET_NOISY_ACTIONS: ReadonlySet<DocActionReport['action']> = new Set([
  'pushed',
  'pulled',
  'created',
  'conflict',
  'error',
]);

function registerActionSubcommand(context: Command, spec: ActionSpec): void {
  const sub = context
    .command(spec.name)
    .description(spec.description)
    .option('--brand <slug>', 'limit to one brand (default: all local brands)');
  if (spec.hasForce) {
    sub.option('--force', 'resolve diverged docs in this direction', false);
  }
  if (spec.hasQuiet) {
    sub.option(
      '--quiet',
      'machine-friendly: print nothing unless a doc was pulled/pushed/' +
        'created, conflicted, or errored, or a structural event was recorded ' +
        'or failed (--json output is unaffected)',
      false,
    );
  }
  sub.action(async (opts: { brand?: string; force?: boolean; quiet?: boolean }, cmd: Command) => {
    const root = cmd.optsWithGlobals<RootOptions>();
    const t0 = Date.now();
    try {
      // --force overwrites diverged docs wholesale; unscoped it would sweep
      // EVERY local brand in one command. Require an explicit blast radius.
      if (spec.hasForce && opts.force && !opts.brand) {
        emitError(
          `--force requires --brand <slug>: forced ${spec.name} resolution is ` +
            'scoped to one brand at a time.',
          root,
        );
        return;
      }
      const setup = await resolveBrandsAndManifest(opts.brand, root);
      if (!setup) return;
      const { brands, engineOptions } = setup;

      const results: Array<{ brand: string; reports: DocActionReport[] }> = [];
      for (const brand of brands) {
        const r = await spec.run(brand, {
          ...engineOptions,
          ...(spec.hasForce ? { force: opts.force ?? false } : {}),
        });
        if (!r.ok) {
          emitError(r.message, root);
          return;
        }
        results.push({ brand: r.brand, reports: r.reports });
      }

      // Stake sync (#37499): after the doc run, publish each brand's
      // structural_events as declared stakes. Runs before track/output so
      // both can carry the counts. Idempotent server-side, so re-running the
      // command is always safe.
      const stakeRuns: Array<{ brand: string; result: StakeSyncResult }> = [];
      if (spec.syncStakesAfter) {
        for (const r of results) {
          stakeRuns.push({
            brand: r.brand,
            result: await syncStakes(r.brand, { dataDirOverride: root.dataDir }),
          });
        }
      }
      const stakeCounts = {
        stake_created: stakeRuns.reduce((n, s) => n + s.result.created, 0),
        stake_duplicates: stakeRuns.reduce((n, s) => n + s.result.duplicates, 0),
        stake_failed: stakeRuns.reduce((n, s) => n + s.result.failed, 0),
      };

      const allReports = results.flatMap((r) => r.reports);
      const counts = countActions(allReports);
      await track(
        {
          event_name: spec.eventName,
          outcome: counts.error > 0 ? 'failed' : 'ok',
          duration_ms: Date.now() - t0,
          payload: {
            brands: results.length,
            force: opts.force ?? false,
            ...counts,
            ...(spec.syncStakesAfter ? stakeCounts : {}),
          },
        },
        root.dataDir,
      );

      if (root.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: 'ok',
              action: spec.name,
              force: opts.force ?? false,
              brands: results,
              counts,
              ...(spec.syncStakesAfter
                ? { stake_events: stakeRuns.map((s) => s.result) }
                : {}),
            },
            null,
            2,
          ) + '\n',
        );
      } else if (
        !(
          spec.hasQuiet &&
          opts.quiet &&
          !allReports.some((r) => QUIET_NOISY_ACTIONS.has(r.action)) &&
          stakeCounts.stake_created === 0 &&
          stakeCounts.stake_failed === 0
        )
      ) {
        const lines: string[] = [];
        for (const r of results) {
          if (r.reports.length === 0) {
            lines.push(`${r.brand.padEnd(20)}  (no syncable docs locally or on the server)`);
            continue;
          }
          for (const report of r.reports) {
            lines.push(formatReportLine(r.brand, report));
          }
        }
        for (const line of stakeLines(stakeRuns)) lines.push(line);
        lines.push('');
        lines.push(summaryLine(counts));
        process.stdout.write(lines.join('\n') + '\n');
      }
      // Per-doc errors are a non-zero exit; conflicts are a report, not an
      // error (a push that only hits conflicts still exits 0).
      process.exitCode = counts.error > 0 ? 1 : 0;
      return;
    } catch (err) {
      emitError(err instanceof Error ? err.message : String(err), root);
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// autosync — manual/testing entry to the preflight hook
// ---------------------------------------------------------------------------

function registerAutosyncSubcommand(context: Command): void {
  context
    .command('autosync <brand>')
    .description(
      'Run the throttled preflight auto-sync for one brand (the same code ' +
        'path skills trigger implicitly when they read brand context). ' +
        'Pull-only and conservative: fetches conflict-free server-side ' +
        `changes within a ~2s budget, at most once per brand per ` +
        `${AUTOSYNC_THROTTLE_MS / 60_000} minutes (--force bypasses the ` +
        `throttle). Serves brands that already exist locally; diverged docs ` +
        'are never touched and nothing is pushed. Push local changes ' +
        'explicitly with `mixshift context sync [--quiet]`. Disable the ' +
        `implicit hook entirely with ${AUTOSYNC_ENV}=off.`,
    )
    .option('--force', 'bypass the per-brand throttle window', false)
    .action(async (brand: string, opts: { force?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const t0 = Date.now();
      try {
        const result = await maybeAutoSync(brand, {
          dataDirOverride: root.dataDir,
          force: opts.force ?? false,
        });

        await track(
          {
            event_name: EventName.ContextAutosyncCompleted,
            outcome: result.ran
              ? result.errors > 0
                ? 'failed'
                : 'ok'
              : result.reason === 'failed'
                ? 'failed'
                : 'skipped',
            duration_ms: Date.now() - t0,
            payload: {
              brand,
              force: opts.force ?? false,
              ran: result.ran,
              ...(result.ran
                ? {
                    pulled: result.pulled,
                    conflicts: result.conflicts,
                    errors: result.errors,
                  }
                : { reason: result.reason }),
            },
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              result.ran
                ? {
                    status: 'ok',
                    ran: true,
                    pulled: result.pulled,
                    conflicts: result.conflicts,
                    errors: result.errors,
                    reports: result.reports,
                  }
                : {
                    status: 'ok',
                    ran: false,
                    reason: result.reason,
                    ...(result.reason === 'failed' || result.reason === 'skipped'
                      ? { detail: result.detail }
                      : {}),
                  },
              null,
              2,
            ) + '\n',
          );
          return;
        }

        if (!result.ran) {
          let detail: string;
          if (result.reason === 'failed' || result.reason === 'skipped') {
            detail = result.detail;
          } else if (result.reason === 'throttled') {
            detail = `attempted within the last ${AUTOSYNC_THROTTLE_MS / 60_000} minutes; re-run with --force`;
          } else {
            detail = `disabled via ${AUTOSYNC_ENV}`;
          }
          process.stdout.write(`autosync skipped (${result.reason}): ${detail}\n`);
          return;
        }
        const lines = result.reports.map((r) => formatReportLine(brand, r));
        lines.push('');
        lines.push(
          `Autosync: ${result.pulled} pulled, ${result.conflicts} conflict(s) left ` +
            `untouched, ${result.errors} error(s).`,
        );
        process.stdout.write(lines.join('\n') + '\n');
        return;
      } catch (err) {
        emitError(err instanceof Error ? err.message : String(err), root);
        return;
      }
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the brand list (explicit --brand, else all local brands) and
 * pre-fetch the manifest ONCE so a multi-brand loop doesn't refetch it per
 * brand. Returns null after emitting output when there's nothing to do or
 * the manifest fetch failed.
 */
async function resolveBrandsAndManifest(
  brandOpt: string | undefined,
  root: RootOptions,
): Promise<{ brands: string[]; engineOptions: EngineOptions } | null> {
  const brands = brandOpt ? [brandOpt] : await listLocalBrands(root.dataDir);
  if (brands.length === 0) {
    emitNoBrands(root);
    return null;
  }

  const client = createContextSyncClient({ dataDirOverride: root.dataDir });
  const manifest = await client.fetchManifest();
  if (!manifest.ok) {
    emitError(manifest.friendly, root);
    return null;
  }

  // A --brand slug that exists neither locally nor in the manifest is a
  // typo, not an empty brand — error out instead of printing "(no syncable
  // docs)" and exiting 0.
  if (brandOpt) {
    const knownLocally = await brandDirExists(brandOpt, root.dataDir);
    const knownOnServer = manifest.brands.some((b) => b.brand_slug === brandOpt);
    if (!knownLocally && !knownOnServer) {
      emitError(
        `brand '${brandOpt}' not found locally or in the org store — check the ` +
          'slug (run `mixshift context status` for the known brands)',
        root,
      );
      return null;
    }
  }

  const engineOptions: EngineOptions = {
    client,
    manifest: manifest.brands satisfies WireManifestBrand[],
    ...(root.dataDir !== undefined ? { dataDirOverride: root.dataDir } : {}),
  };
  return { brands, engineOptions };
}

interface ActionCounts {
  pushed: number;
  pulled: number;
  created: number;
  noop: number;
  'up-to-date': number;
  conflict: number;
  skipped: number;
  error: number;
}

function countActions(reports: DocActionReport[]): ActionCounts {
  const counts: ActionCounts = {
    pushed: 0,
    pulled: 0,
    created: 0,
    noop: 0,
    'up-to-date': 0,
    conflict: 0,
    skipped: 0,
    error: 0,
  };
  for (const r of reports) counts[r.action] += 1;
  return counts;
}

function summaryLine(counts: ActionCounts): string {
  const parts = (Object.entries(counts) as Array<[keyof ActionCounts, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length > 0 ? `Summary: ${parts.join(', ')}.` : 'Summary: nothing to do.';
}

function formatReportLine(brand: string, r: DocActionReport): string {
  return [
    brand.padEnd(20),
    r.key.padEnd(24),
    r.action.padEnd(11),
    r.detail ?? '',
  ]
    .join('  ')
    .trimEnd();
}

/** Human lines for the post-run stake sync (#37499). One line per brand that
 *  HAS structural events; a whole-run error (unreadable context) reports as
 *  such, and an all-duplicates run says so rather than staying silent (the
 *  user asked for a push; "already on the timeline" is the answer). */
function stakeLines(runs: Array<{ brand: string; result: StakeSyncResult }>): string[] {
  const lines: string[] = [];
  for (const { brand, result } of runs) {
    if (result.error !== undefined) {
      lines.push(`${brand.padEnd(20)}  structural events          error  ${result.error}`);
      continue;
    }
    if (result.total === 0) continue;
    const bits: string[] = [];
    if (result.created > 0) bits.push(`${result.created} recorded on the timeline`);
    if (result.duplicates > 0) bits.push(`${result.duplicates} already on the timeline`);
    if (result.failed > 0) bits.push(`${result.failed} FAILED`);
    lines.push(`${brand.padEnd(20)}  structural events  ${bits.join(', ')}`);
  }
  return lines;
}

function emitNoBrands(root: RootOptions): void {
  if (root.json) {
    process.stdout.write(
      JSON.stringify({ status: 'ok', brands: [], message: 'no local brands' }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(
      'No local brands found under ~/.mixshift/clients/. ' +
        'Use --brand <slug> to target a server-side brand, or run ' +
        '`mixshift brand discover` first.\n',
    );
  }
}

function emitError(message: string, root: RootOptions): void {
  if (root.json) {
    process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
