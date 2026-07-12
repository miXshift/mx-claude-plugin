/**
 * Delta-mode merge — patches the settlement curve from the Tier-2 brain
 * (brand-brain.yaml::capture_rate_calibration.daily_settlement_curve) into
 * context.yaml without touching AM-edited fields.
 *
 * Phase 8: re-sourced from the per-run enrichment.json artifact to the brain
 * (the brain now computes the curve on `brand key add` / `brand brain refresh`).
 * Narrow scope on purpose:
 *
 *   PATCHED into context.yaml::capture_rate_calibration:
 *     - daily_settlement_curve   (full block replacement — enrichment-owned)
 *     - last_calibrated          (today's date, when curve is present)
 *     - stability_score          (from the new curve)
 *
 *   PATCHED at top level:
 *     - last_updated             (today's ISO date)
 *
 *   NOT MERGED into context.yaml (stays in enrichment artifact):
 *     - stockout_candidates      → renderer reads from enrichment.json
 *     - brand_term_typo_candidates → same. AM confirms via the Brand Context
 *       page review surface, then manually promotes to structural_events[]
 *       or brand_terms.variants[].
 *
 * Uses `yaml`'s Document parser to preserve comments + user-curated layout.
 * AM-edited fields (negation, structural_events, brand_terms, posture,
 * accounts, sources, management) are NEVER touched — the merge is field-
 * specific, not a wholesale rewrite.
 */

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Document, parseDocument } from 'yaml';
import { contextPath } from '../paths/resolve.js';
import { loadBrain } from '../brain/read.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';
import type { BrainCaptureRateCalibration } from '../brain/schema.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeltaMergeResult {
  status: 'ok' | 'no_brain' | 'no_curve' | 'context_missing';
  /** Path of the context.yaml that was patched (when status === 'ok'). */
  context_path: string;
  /** Fields actually updated in context.yaml. */
  fields_updated: string[];
  /** Always populated for diagnostic. */
  brain_path: string;
}

/**
 * Merge the enrichment artifact's settlement curve into context.yaml.
 * Bumps `last_updated` to today on successful merge. Preserves comments
 * + AM-edited fields throughout.
 *
 * Idempotent: running twice with the same enrichment produces identical
 * output (modulo last_updated, which always advances to today).
 */
export async function mergeEnrichmentIntoContext(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<DeltaMergeResult> {
  const ctxPath = contextPath(brandSlug, dataDirOverride);

  // 1. Load the Tier-2 brain — the settlement curve lives there now (computed
  //    on `brand key add` / `brand brain refresh`), not a per-run artifact.
  const loaded = await loadBrain(brandSlug, dataDirOverride);
  if (!loaded.ok) {
    return {
      status: 'no_brain',
      context_path: ctxPath,
      fields_updated: [],
      brain_path: loaded.path,
    };
  }
  const curve = loaded.brain.capture_rate_calibration?.daily_settlement_curve;
  if (!curve) {
    return {
      status: 'no_curve',
      context_path: ctxPath,
      fields_updated: [],
      brain_path: loaded.path,
    };
  }

  // 2. Load context.yaml as a Document (preserves comments)
  let ctxText: string;
  try {
    ctxText = await readFile(ctxPath, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        status: 'context_missing',
        context_path: ctxPath,
        fields_updated: [],
        brain_path: loaded.path,
      };
    }
    throw err;
  }
  const doc = parseDocument(ctxText, { keepSourceTokens: true });

  // 3. Patch the curve + metadata fields
  const fieldsUpdated = patchSettlementCurve(doc, curve);

  // 4. Bump last_updated
  const today = new Date().toISOString().slice(0, 10);
  doc.set('last_updated', today);
  fieldsUpdated.push('last_updated');

  // 5. Atomic write
  await writeYamlAtomic(ctxPath, doc.toString({ indent: 2, lineWidth: 0 }));

  // Auto-publish the patched context.yaml to the org store (best-effort,
  // bounded, non-throwing — the local write above is the durable result).
  await pushAfterWrite(brandSlug, { dataDirOverride });

  return {
    status: 'ok',
    context_path: ctxPath,
    fields_updated: fieldsUpdated,
    brain_path: loaded.path,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Mutate the doc's `capture_rate_calibration` block:
 *   - Sets `daily_settlement_curve` to the enrichment's value (full replace)
 *   - Sets `stability_score` to the enrichment's value
 *   - Sets `last_calibrated` to the enrichment's value
 *
 * Creates the parent block if it doesn't exist. Returns the field paths
 * actually written for the result summary.
 *
 * The yaml library's Document API does the right thing here: setIn() walks
 * the path, creating intermediate nodes as needed, and preserves surrounding
 * comments. We're not rewriting the whole calibration block — just three
 * specific subfields.
 */
function patchSettlementCurve(
  doc: Document,
  curve: NonNullable<BrainCaptureRateCalibration['daily_settlement_curve']>,
): string[] {
  const updated: string[] = [];

  doc.setIn(
    ['capture_rate_calibration', 'daily_settlement_curve'],
    {
      by_campaign_type: curve.by_campaign_type,
      dow_offset_pts: curve.dow_offset_pts,
    },
  );
  updated.push('capture_rate_calibration.daily_settlement_curve');

  doc.setIn(
    ['capture_rate_calibration', 'stability_score'],
    curve.stability_score,
  );
  updated.push('capture_rate_calibration.stability_score');

  doc.setIn(
    ['capture_rate_calibration', 'last_calibrated'],
    curve.last_calibrated,
  );
  updated.push('capture_rate_calibration.last_calibrated');

  // Ensure `enabled: true` since we just calibrated. Don't set it if the
  // user has explicitly disabled — only flip false → true on first
  // calibration. Check current value first.
  const enabledNode = doc.getIn(['capture_rate_calibration', 'enabled']);
  if (enabledNode === undefined || enabledNode === null) {
    doc.setIn(['capture_rate_calibration', 'enabled'], true);
    updated.push('capture_rate_calibration.enabled');
  }

  return updated;
}

async function writeYamlAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, text, 'utf-8');
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    // Windows tolerant.
  }
  await rename(tmpPath, path);
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
