/**
 * Enrichment artifact read/write.
 *
 * Lives at `runs/mx-account-cold-start/<date>/<date>.enrichment.json`.
 * Written by `mixshift brand enrich`; read by the cold-start renderer
 * (Detected Anomalies section) and by `mixshift brand merge-delta`
 * (delta-mode merge into context.yaml).
 *
 * Treated as APPEND-ONLY per the data-contract sovereignty rules — the
 * artifact reflects one enrichment run, never mutated post-write. Delta
 * mode produces a NEW artifact for each rerun under the appropriate
 * date directory.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { enrichmentPath } from '../paths/resolve.js';
import type { EnrichmentArtifact } from './types.js';

/**
 * Write an enrichment artifact atomically. Pretty-printed JSON for
 * human-readable diffs in version-controlled exports.
 */
export async function writeEnrichmentArtifact(
  brandSlug: string,
  runDate: string,
  artifact: EnrichmentArtifact,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const path = enrichmentPath(brandSlug, runDate, dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(artifact, null, 2), 'utf-8');
  await rename(tmpPath, path);
  return { path };
}

/**
 * Read an enrichment artifact for a given run date. Returns null when
 * the file doesn't exist (run didn't have enrichment, or it's pending).
 */
export async function readEnrichmentArtifact(
  brandSlug: string,
  runDate: string,
  dataDirOverride?: string,
): Promise<EnrichmentArtifact | null> {
  const path = enrichmentPath(brandSlug, runDate, dataDirOverride);
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as EnrichmentArtifact;
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Build a fresh artifact skeleton — used at the start of `mixshift brand
 * enrich` before any of the three sub-analyses fill in their fields.
 */
export function emptyArtifact(
  brandSlug: string,
  runDate: string,
  accountCount: number,
): EnrichmentArtifact {
  return {
    schema_version: 1,
    brand_slug: brandSlug,
    run_date: runDate,
    generated_at: new Date().toISOString(),
    account_count: accountCount,
    partial: false,
    partial_reasons: [],
    daily_settlement_curve: null,
    stockout_candidates: [],
    brand_term_typo_candidates: [],
  };
}
