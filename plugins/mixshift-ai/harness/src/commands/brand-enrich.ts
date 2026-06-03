/**
 * `mixshift brand enrich <slug>` — Phase 1.5 enrichment runner.
 *
 * Reads prefetch artifact from CS-28/29/30/31 and runs three analyses:
 *   1. Daily attribution settlement curve (CS-28)
 *   2. Stockout window stitching (CS-29 + CS-30)
 *   3. Brand-name typo clustering (CS-31)
 *
 * Writes the combined artifact to `runs/mx-account-cold-start/<date>/<date>.
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
import {
  computeSettlementCurve,
  type CS28Row,
} from '../lib/enrichment/settlement-curve.js';
import {
  detectStockoutWindows,
  type CS29Row,
  type CS30Row,
} from '../lib/enrichment/stockout-windows.js';
import {
  detectBrandTermTypos,
  type CS31Row,
  type BrandTermsBlock,
} from '../lib/enrichment/brand-typos.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { contextPath } from '../lib/paths/resolve.js';
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
      'Run Phase 1.5 enrichment: settlement curve from CS-28, stockout ' +
        'windows from CS-29+CS-30, brand-name typo clusters from CS-31. ' +
        'Writes runs/mx-account-cold-start/<date>/<date>.enrichment.json. Read ' +
        "by the cold-start renderer (Detected Anomalies section) + the " +
        '`brand merge-delta` patcher.',
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
            'mx-account-cold-start',
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
              `No prefetch artifact at ${prefetchPath}. Run \`mixshift prefetch --skill mx-account-cold-start --brand ${brand.slug} --date ${runDate}\` first.`,
            );
          }

          // Account count for the artifact metadata (read from index registry)
          const { index } = await readIndex(root.dataDir);
          const row = index.brands.find((b) => b.slug === brand.slug);
          const accountCount = row?.accounts.length ?? 0;

          const artifact = emptyArtifact(brand.slug, runDate, accountCount);
          const partial_reasons: string[] = [];

          // ─── C.2 — Settlement curve from CS-28 ─────────────────────────────
          const cs28Rows = extractQueryRows(prefetch, 'CS-28') as CS28Row[];
          if (cs28Rows.length === 0) {
            partial_reasons.push('CS-28 returned no rows — settlement curve unavailable');
          } else {
            artifact.daily_settlement_curve = computeSettlementCurve(cs28Rows);
            if (artifact.daily_settlement_curve === null) {
              partial_reasons.push('Settlement curve computation returned null');
            }
          }

          // ─── C.3 — Stockout windows from CS-29 + CS-30 ─────────────────────
          const cs29Rows = extractQueryRows(prefetch, 'CS-29') as CS29Row[];
          const cs30Rows = extractQueryRows(prefetch, 'CS-30') as CS30Row[];
          if (cs29Rows.length === 0) {
            partial_reasons.push('CS-29 returned no rows — stockout detection skipped');
          } else {
            artifact.stockout_candidates = detectStockoutWindows(cs29Rows, cs30Rows);
          }

          // ─── C.4 — Brand-name typo clusters from CS-31 ─────────────────────
          const cs31Rows = extractQueryRows(prefetch, 'CS-31') as CS31Row[];
          if (cs31Rows.length === 0) {
            partial_reasons.push('CS-31 returned no rows — brand-typo clustering skipped');
          } else {
            // Read context.yaml for brand_terms + negation.competitor_brands.
            // Without these we can't do typo detection — drop gracefully.
            const ctx = await tryReadContextForTypos(brand.slug, root.dataDir);
            if (!ctx || !ctx.brand_terms) {
              partial_reasons.push(
                'context.yaml::brand_terms missing — brand-typo clustering needs canonicals to match against',
              );
            } else {
              artifact.brand_term_typo_candidates = detectBrandTermTypos(
                cs31Rows,
                ctx.brand_terms,
                {
                  competitor_brands: ctx.negation?.competitor_brands ?? [],
                },
              );
            }
          }

          artifact.partial_reasons = partial_reasons;
          artifact.partial = partial_reasons.length > 0;

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
            return;
          }
          process.stdout.write(
            `\n✓ Enrichment artifact written to ${path}\n` +
              `  Settlement curve: ${artifact.daily_settlement_curve ? `computed (stability: ${artifact.daily_settlement_curve.stability_score})` : 'unavailable'}\n` +
              `  Stockout candidates: ${artifact.stockout_candidates.length}\n` +
              `  Brand-typo clusters: ${artifact.brand_term_typo_candidates.length}\n` +
              (artifact.partial
                ? `  Partial — ${artifact.partial_reasons.length} pending: ${artifact.partial_reasons.join('; ')}\n\n`
                : `\n`),
          );
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

/**
 * Read context.yaml just for the typo-detection inputs (brand_terms +
 * negation.competitor_brands). Returns null when context is missing or
 * malformed — caller treats that as "skip typo detection".
 */
async function tryReadContextForTypos(
  brandSlug: string,
  dataDir?: string,
): Promise<{
  brand_terms?: BrandTermsBlock;
  negation?: { competitor_brands?: string[] };
} | null> {
  try {
    const raw = await fsReadFile(contextPath(brandSlug, dataDir), 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as {
      brand_terms?: BrandTermsBlock;
      negation?: { competitor_brands?: string[] };
    };
  } catch {
    return null;
  }
}

/**
 * Extract rows for a specific CS-* query from the prefetch artifact.
 * The prefetch artifact's shape is `{ queries: { "CS-XX": { rows: [...] } } }`.
 * Returns [] when the query isn't present or has no rows.
 */
function extractQueryRows(prefetch: unknown, queryId: string): Array<Record<string, unknown>> {
  if (prefetch === null || typeof prefetch !== 'object') return [];
  const queries = (prefetch as { queries?: Record<string, unknown> }).queries;
  if (!queries || typeof queries !== 'object') return [];
  const q = queries[queryId];
  if (!q || typeof q !== 'object') return [];
  const rows = (q as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object');
}

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
