/**
 * S3 observation write-backs: how skills contribute to the Brand Brain.
 *
 * Skills emit BrainObservation envelopes; the applier merges them into
 * the brain document's `observations` map with count-weighted confidence.
 * Today the applier runs locally against the yaml cache; at P2 the same
 * envelopes POST to the brain service and the aggregation runs there.
 *
 * Design rules (internal/BRAND-BRAIN-STRATEGY.md §5):
 *   - Single observations never present as facts: `count` and
 *     `confidence` ride along, and consumers render observation-backed
 *     values as suggestions.
 *   - The brain proposes, never overrules: observations live in their
 *     own namespace and are promoted to Tier 3 only by AM confirmation.
 *
 * First slice ships the envelope + applier; the first emitting skill is
 * mx-featured-offer-watch (chronic_loss_asins) when it productizes.
 */

import { z } from 'zod';
import type { BrandBrain } from './schema.js';
import { loadBrain, saveBrain } from './read.js';
import {
  readPendingDiscoveries,
  clearPendingDiscoveries,
} from './discoveries.js';

export const brainObservationSchema = z.object({
  /** Dotted field path, namespaced by domain
   *  (e.g. "buy_box_health.chronic_losers"). */
  field: z.string().min(1),
  value: z.unknown(),
  /** Emitter's own confidence in this single observation, 0..1. */
  confidence: z.number().min(0).max(1),
  /** Skill id + version, e.g. "mx-featured-offer-watch@1.0.0". */
  observed_by: z.string().min(1),
  observed_at: z.iso.datetime(),
});

export type BrainObservation = z.infer<typeof brainObservationSchema>;

/**
 * Merge observations into a brain document. Pure: returns a new
 * document. Repeated observations of the same field bump `count` and
 * blend confidence toward the newest emitter's value (latest value
 * wins; confidence = max(prior, incoming) damped by recency is
 * deliberately NOT attempted in P1; keep the aggregation legible).
 */
export function applyObservations(
  brain: BrandBrain,
  observations: BrainObservation[],
): BrandBrain {
  const merged = { ...brain.observations };
  for (const obs of observations) {
    const prior = merged[obs.field];
    merged[obs.field] = {
      value: obs.value,
      confidence: obs.confidence,
      observed_by: obs.observed_by,
      observed_at: obs.observed_at,
      count: (prior?.count ?? 0) + 1,
    };
  }
  return { ...brain, observations: merged };
}

export type RecordObservationsResult =
  | { ok: true; path: string; applied: number }
  | { ok: false; reason: string };

/**
 * P1 transport: load the local brain, apply, save. No-ops with a clear
 * reason when the brand has no brain yet (observations are best-effort
 * enrichment; they must never fail a skill run).
 */
export async function recordObservations(
  brandSlug: string,
  observations: BrainObservation[],
  dataDirOverride?: string,
): Promise<RecordObservationsResult> {
  if (observations.length === 0) {
    return { ok: false, reason: 'no observations supplied' };
  }
  const loaded = await loadBrain(brandSlug, dataDirOverride);
  if (!loaded.ok) {
    return {
      ok: false,
      reason: `brain not available for "${brandSlug}" (${loaded.kind}); ` +
        `run \`mixshift brand brain fetch ${brandSlug}\` first`,
    };
  }
  const next = applyObservations(loaded.brain, observations);
  const { path } = await saveBrain(next, dataDirOverride);
  return { ok: true, path, applied: observations.length };
}

// ---------------------------------------------------------------------------
// Phase 9: drain capture proposals into the brain (the progressive loop)
// ---------------------------------------------------------------------------

export type DrainResult =
  | { ok: true; drained: number; applied: number; path: string | null }
  | { ok: false; reason: string; drained: 0 };

/**
 * Drain a brand's pending capture proposals (`.pending-discoveries.json`,
 * emitted by the confirm-flow when an AM sets a SHARED field) into the brain's
 * count-weighted `observations` map, then clear the pending file.
 *
 * This is the back half of the progressive loop: Phase-4 capture writes a
 * proposal; this folds it into Tier-2 as an observation (a SUGGESTION, never a
 * fact — promoted to Tier-3 context only by explicit AM confirmation). Repeated
 * captures of the same field bump `count`, so a value the AM keeps choosing
 * accrues confidence.
 *
 * Safety: if the brain isn't available yet (no fetch), nothing is applied AND
 * the pending file is LEFT IN PLACE (proposals are never lost) — the caller
 * runs `brand brain fetch` then retries. Idempotent: a second run finds no
 * pending file and no-ops.
 */
export async function drainPendingDiscoveries(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<DrainResult> {
  const pending = await readPendingDiscoveries(brandSlug, dataDirOverride);
  const proposals = pending?.discoveries.context_field_proposals ?? [];
  if (proposals.length === 0) {
    return { ok: true, drained: 0, applied: 0, path: null };
  }

  const observations: BrainObservation[] = proposals.map((p) => ({
    field: p.field,
    value: p.proposed_value,
    confidence: p.confidence,
    observed_by: p.observed_by,
    observed_at: p.observed_at,
  }));

  const result = await recordObservations(brandSlug, observations, dataDirOverride);
  if (!result.ok) {
    // Brain unavailable — keep the pending file so proposals survive the retry.
    return { ok: false, reason: result.reason, drained: 0 };
  }

  await clearPendingDiscoveries(brandSlug, dataDirOverride);
  return {
    ok: true,
    drained: proposals.length,
    applied: result.applied,
    path: result.path,
  };
}
