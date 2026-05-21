/**
 * `mixshift brand enrich <slug>` — Phase 1.5 enrichment runner.
 *
 * Reads prefetch artifact from CS-28/29/30/31 and runs three analyses:
 *   1. Daily attribution settlement curve (CS-28)
 *   2. Stockout window stitching (CS-29 + CS-30)
 *   3. Brand-name typo clustering (CS-31)
 *
 * Writes the combined artifact to `runs/account-cold-start/<date>/<date>.
 * enrichment.json`.
 *
 * Current state (0.5.0): SHELL ONLY. The three enrichers are stubs that
 * write empty results with `partial: true` + reason. Phase C.2/C.3/C.4
 * fill them in.
 */

import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import {
  emptyArtifact,
  writeEnrichmentArtifact,
} from '../lib/enrichment/storage.js';
import { brandDir } from '../lib/paths/resolve.js';
import { track } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandEnrichCommand(brandCmd: Command): void {
  brandCmd
    .command('enrich <slug>')
    .description(
      'Run Phase 1.5 enrichment: settlement curve + stockout windows + ' +
        'brand-typo clusters. Writes runs/account-cold-start/<date>/<date>.' +
        'enrichment.json. Read by the cold-start renderer + delta-mode ' +
        'merge. CURRENT STATE: shell only — sub-analyses land in Phase C.2-C.4.',
    )
    .option('--date <date>', 'run date (YYYY-MM-DD). Defaults to today.')
    .action(
      async (
        slug: string,
        opts: { date?: string },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const brand = await resolveBrand(slug, root.dataDir);
          if (!brand) {
            return emitError(root.json, `Brand "${slug}" not found in the registry.`);
          }
          const runDate = opts.date ?? new Date().toISOString().slice(0, 10);

          // Look for the prefetch artifact. Without prefetch, we can't enrich.
          const prefetchPath = join(
            brandDir(brand.slug, root.dataDir),
            'runs',
            'account-cold-start',
            runDate,
            'data.json',
          );
          let prefetch: unknown = null;
          try {
            const raw = await readFile(prefetchPath, 'utf-8');
            prefetch = JSON.parse(raw);
          } catch {
            return emitError(
              root.json,
              `No prefetch artifact at ${prefetchPath}. Run \`mixshift prefetch --skill account-cold-start --brand ${brand.slug} --date ${runDate}\` first.`,
            );
          }

          // Account count for the artifact metadata (read from index registry)
          const { index } = await readIndex(root.dataDir);
          const row = index.brands.find((b) => b.slug === brand.slug);
          const accountCount = row?.accounts.length ?? 0;

          // Skeleton artifact + flag partial until each sub-analysis is implemented.
          const artifact = emptyArtifact(brand.slug, runDate, accountCount);
          artifact.partial = true;
          artifact.partial_reasons = [
            'C.2 settlement-curve enricher not yet implemented',
            'C.3 stockout-window stitcher not yet implemented',
            'C.4 brand-typo clusterer not yet implemented',
          ];

          // TODO Phase C.2: compute daily_settlement_curve from prefetch.CS-28
          // TODO Phase C.3: compute stockout_candidates from prefetch.CS-29 + CS-30
          // TODO Phase C.4: compute brand_term_typo_candidates from prefetch.CS-31

          const { path } = await writeEnrichmentArtifact(
            brand.slug,
            runDate,
            artifact,
            root.dataDir,
          );

          await track(
            {
              event_name: 'brand.enrichment_run',
              payload: {
                brand_slug: brand.slug,
                run_date: runDate,
                partial: artifact.partial,
                settlement_computed: artifact.daily_settlement_curve !== null,
                stockout_count: artifact.stockout_candidates.length,
                typo_cluster_count: artifact.brand_term_typo_candidates.length,
              },
            },
            root.dataDir,
          );

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  enrichment_path: path,
                  partial: artifact.partial,
                  partial_reasons: artifact.partial_reasons,
                },
                null,
                2,
              ) + '\n',
            );
            // Mark prefetch result reachable so it's not "unused"
            void prefetch;
            return;
          }
          process.stdout.write(
            `\n✓ Enrichment artifact written to ${path}\n` +
              (artifact.partial
                ? `  (partial — ${artifact.partial_reasons.length} sub-analyses pending)\n\n`
                : `\n`),
          );
          void prefetch;
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return emitError(root.json, message);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveBrand(
  input: string,
  dataDir?: string,
): Promise<{ slug: string; display_name: string } | null> {
  const { index } = await readIndex(dataDir);
  const exact = index.brands.find((b) => b.slug === input);
  if (exact) return { slug: exact.slug, display_name: exact.display_name };
  const resolved = resolveBrandName(input, index);
  if (resolved.status === 'found') {
    return { slug: resolved.brand.slug, display_name: resolved.brand.display_name };
  }
  if (resolved.status === 'ambiguous') {
    const candidates = resolved.candidates
      .slice(0, 5)
      .map((c) => `  - ${c.display_name} (slug: ${c.slug})`)
      .join('\n');
    throw new Error(
      `Brand input "${input}" matches ${resolved.candidates.length} brands. Disambiguate by slug:\n${candidates}`,
    );
  }
  return null;
}

function emitError(json: boolean | undefined, message: string): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({ status: 'error', message }, null, 2) + '\n',
    );
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
