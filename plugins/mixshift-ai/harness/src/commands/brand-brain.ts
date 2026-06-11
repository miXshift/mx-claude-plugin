/**
 * `mixshift brand brain ...` — Tier-2 Brand Brain pipeline commands.
 *
 *   fetch <slug>    Run the background-discovery pull for one brand
 *                   (no-op inside the 30-day freshness window).
 *   refresh <slug>  Same as fetch --refresh (bypasses the gate).
 *   status <slug>   Read .brain-status.json + the brain summary; the
 *                   chat surface polls this after `brand key add`.
 *
 * The normal trigger is automatic: `brand key add` spawns fetch in a
 * detached background process. These commands exist for retries,
 * scripting, and the chat polling surface.
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import {
  fetchBrandBrain,
  BRAIN_TTL_DAYS,
  type BrainFetchResult,
  type BrainStatusFile,
} from '../lib/brain/fetch.js';
import { loadBrain } from '../lib/brain/read.js';
import { brainStatusPath } from '../lib/paths/resolve.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandBrainCommands(brand: Command): void {
  const brain = brand
    .command('brain')
    .description(
      'Tier-2 Brand Brain: auto-discovered brand facts (identity, targets, ' +
        'data freshness) that analytical skills consume as pre-fill. ' +
        'Populated automatically in the background when a brand is added ' +
        'to your key list.',
    );

  brain
    .command('fetch <slug>')
    .description(
      `Pull brain sources for one brand. Skips when fresh (<${BRAIN_TTL_DAYS}d) ` +
        'unless --refresh is passed.',
    )
    .option('--refresh', 'Bypass the freshness gate and re-fetch now.', false)
    .action(async (slug: string, opts: { refresh?: boolean }, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await fetchBrandBrain({
        slug,
        refresh: !!opts.refresh,
        dataDirOverride: root.dataDir,
      });
      renderFetchResult(slug, result, !!root.json);
      process.exitCode = exitCodeFor(result);
      return;
    });

  brain
    .command('refresh <slug>')
    .description('Re-fetch brain sources now, ignoring the freshness gate.')
    .action(async (slug: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const result = await fetchBrandBrain({
        slug,
        refresh: true,
        dataDirOverride: root.dataDir,
      });
      renderFetchResult(slug, result, !!root.json);
      process.exitCode = exitCodeFor(result);
      return;
    });

  brain
    .command('status <slug>')
    .description(
      'Show the background-fetch status file plus the stored brain ' +
        'summary. Machine-friendly with --json (the chat surface polls ' +
        'this).',
    )
    .action(async (slug: string, _opts: unknown, cmd: Command) => {
      const root = cmd.optsWithGlobals<RootOptions>();
      const statusFile = await readStatusFile(slug, root.dataDir);
      const brainResult = await loadBrain(slug, root.dataDir);

      const payload = {
        slug,
        status_file: statusFile,
        brain: brainResult.ok
          ? {
              generated_at: brainResult.brain.generated_at,
              generator: brainResult.brain.generator,
              acos_target_pct: brainResult.brain.seller?.acos_target_pct ?? null,
              merchant_alias: brainResult.brain.seller?.merchant_alias ?? null,
              seller_fetched_at:
                brainResult.brain.sources.seller?.fetched_at ?? null,
              observation_count: Object.keys(brainResult.brain.observations)
                .length,
            }
          : { missing: true, kind: brainResult.kind },
      };

      if (root.json) {
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return;
      }
      const lines = [`\nBrand brain status for ${slug}:`];
      if (statusFile) {
        lines.push(
          `  last run: ${statusFile.status} (started ${statusFile.started_at}` +
            (statusFile.finished_at ? `, finished ${statusFile.finished_at}` : '') +
            ')',
        );
        if (statusFile.error) lines.push(`  error: ${statusFile.error}`);
      } else {
        lines.push('  no fetch has run yet');
      }
      if (brainResult.ok) {
        lines.push(
          `  brain: generated ${brainResult.brain.generated_at} by ${brainResult.brain.generator}`,
          `  acos_target_pct: ${brainResult.brain.seller?.acos_target_pct ?? '(not set in platform)'}`,
        );
      } else {
        lines.push(`  brain: not populated (${brainResult.kind})`);
      }
      process.stdout.write(lines.join('\n') + '\n');
      return;
    });
}

async function readStatusFile(
  slug: string,
  dataDirOverride?: string,
): Promise<BrainStatusFile | null> {
  try {
    const raw = await readFile(brainStatusPath(slug, dataDirOverride), 'utf-8');
    return JSON.parse(raw) as BrainStatusFile;
  } catch {
    return null;
  }
}

function renderFetchResult(
  slug: string,
  result: BrainFetchResult,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(JSON.stringify({ slug, ...result }, null, 2) + '\n');
    return;
  }
  switch (result.status) {
    case 'complete': {
      const parts = [
        `${result.summary.row_count} seller row(s)`,
        `ACoS target ${result.summary.acos_target_pct ?? 'not set in platform'}`,
      ];
      if (result.summary.asin_count !== null) {
        parts.push(`${result.summary.asin_count} catalog ASIN(s)`);
      }
      if (result.summary.campaign_count !== null) {
        parts.push(`${result.summary.campaign_count} campaign(s)`);
      }
      parts.push(`${result.summary.duration_ms}ms via ${result.summary.used_dispatch}`);
      process.stdout.write(
        `\n✓ Brand brain populated for ${slug} (${parts.join(', ')}).\n` +
          `  ${result.path}\n`,
      );
      if (result.summary.failed_sources.length > 0) {
        process.stdout.write(
          `  ⚠ Source(s) failed and were skipped: ${result.summary.failed_sources.join(', ')}. ` +
            `Retry later with \`mixshift brand brain refresh ${slug}\`.\n`,
        );
      }
      break;
    }
    case 'skipped_fresh':
      process.stdout.write(
        `\n• Brain for ${slug} is fresh (fetched ${result.fetched_at}; ` +
          `TTL ${result.ttl_days}d). Use --refresh to force.\n`,
      );
      break;
    case 'brand_not_found':
      process.stderr.write(
        `\n✗ No brand "${slug}" in the registry. Run \`mixshift brand list\` ` +
          `to see slugs, or \`mixshift brand discover\` to refresh the registry.\n`,
      );
      break;
    case 'no_accounts':
      process.stderr.write(
        `\n✗ Brand "${slug}" has no seller accounts in the registry; ` +
          `nothing to fetch.\n`,
      );
      break;
    case 'failed':
      process.stderr.write(
        `\n✗ Brain fetch failed for ${slug}: ${result.error}\n` +
          `  Retry with \`mixshift brand brain refresh ${slug}\`.\n`,
      );
      break;
  }
}

function exitCodeFor(result: BrainFetchResult): number {
  switch (result.status) {
    case 'complete':
    case 'skipped_fresh':
      return 0;
    case 'brand_not_found':
    case 'no_accounts':
      return 4;
    case 'failed':
      return 1;
  }
}
