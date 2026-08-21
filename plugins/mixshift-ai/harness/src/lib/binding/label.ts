/**
 * The one label normalizer, shared by every side of sub-brand discovery.
 *
 * This lives in its own module for a reason. `normalizeLabel` used to sit in
 * discovery.ts, so the coverage sides (sbd-01..04) keyed their maps on the
 * normalized value while economics.ts — which cannot import discovery.ts
 * without a cycle, since discovery imports economics — keyed on the raw wire
 * string. A label that arrived with stray whitespace on one side and clean on
 * the other therefore produced TWO keys that never joined: the candidate lost
 * its economics, and then read as a brand with no money behind it.
 *
 * Any new consumer of a wire `label` column imports from here. Nothing
 * re-implements the trim.
 */

/** The bucket blank labels collapse into. Matches the gateway's server-side
 *  COALESCE (design doc §3, the DHC-07/08 rule:
 *  `COALESCE(NULLIF(col,''),'(unclassified)')`). */
export const UNCLASSIFIED_LABEL = '(unclassified)';

/** Normalize a raw label value to the unclassified bucket when blank. The
 *  gateway is expected to already COALESCE server-side (matching the
 *  DHC-07/08 pattern), but this is defensive: a null/''/whitespace-only
 *  label must never silently count as a "distinct label" candidate.
 *
 *  Idempotent: normalizing an already-'(unclassified)' value returns it
 *  unchanged, so it is safe to apply at every boundary. */
export function normalizeLabel(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : UNCLASSIFIED_LABEL;
}
