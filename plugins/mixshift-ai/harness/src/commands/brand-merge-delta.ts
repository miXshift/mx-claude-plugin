/**
 * `mixshift brand merge-delta <slug>` — delta-mode context patcher.
 *
 * Merges the settlement curve from `runs/mx-brand-context/<date>/<date>.
 * enrichment.json` into the brand's context.yaml without touching AM-edited
 * fields. See lib/enrichment/delta-merge.ts for the field-level rules.
 *
 * Idempotent: running twice with the same enrichment produces identical
 * output (modulo last_updated).
 */

import type { Command } from 'commander';
import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import { mergeEnrichmentIntoContext } from '../lib/enrichment/delta-merge.js';
import { track } from '../lib/telemetry/index.js';

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandMergeDeltaCommand(brandCmd: Command): void {
  brandCmd
    .command('merge-delta <slug>')
    .description(
      "Merge the settlement curve from the brand brain into the brand's " +
        'context.yaml. Preserves AM-edited fields (negation, structural_events, ' +
        'brand_terms, posture, etc.) and comments. Idempotent.',
    )
    .option('--date <date>', 'run date (YYYY-MM-DD). Defaults to today.')
    .action(
      async (slug: string, opts: { date?: string }, cmd: Command) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const brand = await resolveBrand(slug, root.dataDir);
          if (!brand) {
            return emitError(root.json, `Brand "${slug}" not found in the registry.`);
          }
          const runDate = opts.date ?? new Date().toISOString().slice(0, 10);

          const result = await mergeEnrichmentIntoContext(
            brand.slug,
            root.dataDir,
          );

          await track(
            {
              event_name: 'brand.delta_merged',
              payload: {
                brand_slug: brand.slug,
                run_date: runDate,
                status: result.status,
                fields_updated: result.fields_updated,
              },
            },
            root.dataDir,
          );

          if (root.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            if (result.status !== 'ok') process.exitCode = 4;
            return;
          }

          switch (result.status) {
            case 'no_brain':
              process.stderr.write(
                `\nNo brand brain at ${result.brain_path}.\n` +
                  `Run \`mixshift brand brain fetch ${brand.slug}\` (or \`refresh\`) first.\n\n`,
              );
              process.exitCode = 4;
              return;
            case 'no_curve':
              process.stderr.write(
                `\nThe brand brain has no settlement curve yet. ` +
                  `Run \`mixshift brand brain refresh ${brand.slug}\` (CS-28 may have returned no rows).\n\n`,
              );
              process.exitCode = 4;
              return;
            case 'context_missing':
              process.stderr.write(
                `\nNo context.yaml for "${brand.slug}". Run /mx-brand-context first.\n\n`,
              );
              process.exitCode = 5;
              return;
            case 'ok':
              process.stdout.write(
                `\n✓ Merged settlement curve into ${result.context_path}\n` +
                  `  Fields updated:\n` +
                  result.fields_updated.map((f) => `    - ${f}`).join('\n') +
                  `\n  AM-edited fields (negation, structural_events, brand_terms,\n` +
                  `  posture, accounts, sources, management) preserved.\n\n`,
              );
              return;
          }
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
    process.stdout.write(JSON.stringify({ status: 'error', message }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}
