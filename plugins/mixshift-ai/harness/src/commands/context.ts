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
import { listLocalBrands } from '../lib/context-sync/local.js';
import type { DocActionReport, WireManifestBrand } from '../lib/context-sync/types.js';
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

        const results = [];
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

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              {
                status: 'ok',
                brands: results.map((r) => ({ brand: r.brand, docs: r.docs })),
                conflicts,
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
                d.verdict.padEnd(13),
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
        'overwrites diverged docs with the local version.',
    hasForce: true,
    run: (brand, opts) => push(brand, opts),
    eventName: EventName.ContextPushCompleted,
  });

  registerActionSubcommand(context, {
    name: 'sync',
    description:
      'Two-way non-destructive sync: pull every non-conflicting server ' +
        'change, push every non-conflicting local change, and list diverged ' +
        'docs as conflicts. Never merges content.',
    hasForce: false,
    run: (brand, opts) => sync(brand, opts),
    eventName: EventName.ContextSyncCompleted,
  });

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

        const allReports = result.brands.flatMap((b) => b.reports);
        const counts = countActions(allReports);
        await track(
          {
            event_name: EventName.ContextMigrateCompleted,
            outcome: counts.error > 0 ? 'failed' : 'ok',
            duration_ms: Date.now() - t0,
            payload: { brands: result.brands.length, ...counts },
          },
          root.dataDir,
        );

        if (root.json) {
          process.stdout.write(
            JSON.stringify(
              { status: 'ok', brands: result.brands, counts },
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
  run: (
    brand: string,
    opts: EngineOptions & { force?: boolean },
  ) => Promise<BrandActionResult>;
  eventName: EventNameValue;
}

function registerActionSubcommand(context: Command, spec: ActionSpec): void {
  const sub = context
    .command(spec.name)
    .description(spec.description)
    .option('--brand <slug>', 'limit to one brand (default: all local brands)');
  if (spec.hasForce) {
    sub.option('--force', 'resolve diverged docs in this direction', false);
  }
  sub.action(async (opts: { brand?: string; force?: boolean }, cmd: Command) => {
    const root = cmd.optsWithGlobals<RootOptions>();
    const t0 = Date.now();
    try {
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
            },
            null,
            2,
          ) + '\n',
        );
      } else {
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
