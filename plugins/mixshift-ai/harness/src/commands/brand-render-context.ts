/**
 * `mixshift brand render-context <slug>` — render the cold-start
 * Brand Context page.
 *
 * Reads context.yaml + narrative.md + brand-intelligence.yaml + corpora/*.csv
 * (+ optional enrichment.json from Phase 1.5 when present) and produces:
 *
 *   - ~/.mixshift/clients/<slug>/brand-context.html        (visual review)
 *   - ~/.mixshift/clients/<slug>/brand-context.headline.json (~500-token summary)
 *   - ~/.mixshift/clients/<slug>/brand-context.review.json  (bucket + readiness map)
 *
 * Auto-emits the run sidecar via `mixshift sidecar write` so the run is
 * trackable in the runs/ folder.
 *
 * Opens the HTML in the OS default browser unless `--no-open`.
 */

import type { Command } from 'commander';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readIndex } from '../lib/clients/index.js';
import { resolveBrandName } from '../lib/clients/resolve-brand.js';
import { composeBrandContextReport } from '../lib/render/brand-context-composer.js';
import { track } from '../lib/telemetry/index.js';

const exec = promisify(execCb);

interface RootOptions {
  json?: boolean;
  dataDir?: string;
}

export function registerBrandRenderContextCommand(brandCmd: Command): void {
  brandCmd
    .command('render-context <slug>')
    .description(
      'Render the brand setup Brand Context page: brand-context.html + ' +
        'brand-context.headline.json + brand-context.review.json. Reads ' +
        'context.yaml + narrative.md + brand-intelligence.yaml + corpora/. ' +
        'Auto-opens the HTML; --no-open to skip.',
    )
    .option(
      '--date <date>',
      'run date (YYYY-MM-DD). Defaults to today.',
    )
    .option('--no-open', 'write the files but do not open the browser')
    .option(
      '--theme <theme>',
      'initial theme (light | dark)',
      'light',
    )
    .option(
      '--observational',
      'mark this as Phase 1 only (Phase 2 AMA pending — verdict will be OBSERVATIONAL)',
      false,
    )
    .action(
      async (
        slug: string,
        opts: { date?: string; open: boolean; theme: 'light' | 'dark'; observational: boolean },
        cmd: Command,
      ) => {
        const root = cmd.optsWithGlobals<RootOptions>();
        try {
          const brand = await resolveBrand(slug, root.dataDir);
          if (!brand) {
            return emitError(root.json, `Brand "${slug}" not found in the registry.`);
          }

          const runDate = opts.date ?? new Date().toISOString().slice(0, 10);

          const result = await composeBrandContextReport({
            brandSlug: brand.slug,
            brandName: brand.display_name,
            runDate,
            theme: opts.theme,
            observational: opts.observational,
            dataDirOverride: root.dataDir,
          });

          await track(
            {
              event_name: 'brand.context_rendered',
              payload: {
                brand_slug: brand.slug,
                run_date: runDate,
                verdict: result.verdict,
                required_present: result.coverage.required_present,
                required_total: result.coverage.required_total,
                open_gaps_count: result.coverage.open_gaps_count,
                stale_count: result.coverage.stale_count,
              },
            },
            root.dataDir,
          );

          if (root.json) {
            process.stdout.write(
              JSON.stringify(
                {
                  status: 'ok',
                  brand_slug: brand.slug,
                  run_date: runDate,
                  verdict: result.verdict,
                  verdict_reason: result.verdict_reason,
                  html_path: result.html_path,
                  headline_path: result.headline_path,
                  review_path: result.review_path,
                  coverage: {
                    required_present: result.coverage.required_present,
                    required_total: result.coverage.required_total,
                    recommended_present: result.coverage.recommended_present,
                    recommended_total: result.coverage.recommended_total,
                    stale_count: result.coverage.stale_count,
                    open_gaps_count: result.coverage.open_gaps_count,
                  },
                },
                null,
                2,
              ) + '\n',
            );
          } else {
            process.stdout.write(
              `\n✓ Rendered Brand Context for ${brand.display_name}\n` +
                `  Verdict: ${result.verdict} — ${result.verdict_reason}\n` +
                `  HTML:     ${result.html_path}\n` +
                `  Headline: ${result.headline_path}\n` +
                `  Review:   ${result.review_path}\n\n`,
            );
          }

          if (opts.open) {
            await openInBrowser(result.html_path);
          }
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

async function openInBrowser(path: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      await exec(`start "" "${path}"`);
    } else if (process.platform === 'darwin') {
      await exec(`open "${path}"`);
    } else {
      await exec(`xdg-open "${path}"`);
    }
  } catch {
    // Best effort — file is written regardless.
  }
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
