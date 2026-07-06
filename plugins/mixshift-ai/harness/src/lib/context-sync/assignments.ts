/**
 * Best-effort mirroring of the local key-brand list to the org store's
 * person→brand assignment table (PUT /api/context/assignments, P1 endpoint).
 *
 * Called by `mixshift brand key add|remove|clear` AFTER the local mutation
 * succeeded. The local list stays the source of truth for the plugin
 * (assignments are recorded, not enforced — P1 decision), so:
 *
 *   - failure here NEVER fails or reverts the local change; the command
 *     prints a one-line note and exits as it always did;
 *   - reads are never gated on the server copy;
 *   - offline machines simply drift until the next successful mutation.
 */

import {
  createContextSyncClient,
  type ContextSyncClient,
} from './client.js';

export interface MirrorOutcome {
  op: 'add' | 'remove';
  brand_slug: string;
  mirrored: boolean;
  /** Failure amplification (friendly copy) when mirrored=false. */
  detail?: string;
}

/**
 * Mirror one key-list mutation to the server. Never throws; the boolean
 * outcome is advisory (command layer prints a note on false).
 */
export async function mirrorKeyAssignment(
  op: 'add' | 'remove',
  brandSlug: string,
  dataDirOverride?: string,
  client?: ContextSyncClient,
): Promise<MirrorOutcome> {
  try {
    const c = client ?? createContextSyncClient({ dataDirOverride });
    const result = await c.putAssignment({ op, brand_slug: brandSlug, role: 'key' });
    if (result.ok) return { op, brand_slug: brandSlug, mirrored: true };
    return { op, brand_slug: brandSlug, mirrored: false, detail: result.friendly };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { op, brand_slug: brandSlug, mirrored: false, detail: message };
  }
}

/** Mirror several mutations sequentially (key add/remove accept multiple
 *  inputs; clear removes each slug). Never throws. */
export async function mirrorKeyAssignments(
  op: 'add' | 'remove',
  brandSlugs: string[],
  dataDirOverride?: string,
  client?: ContextSyncClient,
): Promise<MirrorOutcome[]> {
  const out: MirrorOutcome[] = [];
  for (const slug of brandSlugs) {
    out.push(await mirrorKeyAssignment(op, slug, dataDirOverride, client));
  }
  return out;
}

/** One-line stderr note for human output when any mirror failed. Empty
 *  string when everything mirrored. */
export function mirrorFailureNote(outcomes: MirrorOutcome[]): string {
  const failed = outcomes.filter((o) => !o.mirrored);
  if (failed.length === 0) return '';
  const detail = failed[0]?.detail ?? 'unreachable';
  return (
    `  note: ${failed.length} key-brand change(s) not mirrored to the org ` +
    `store (${detail}) — your local list is updated; it will re-mirror on ` +
    'the next change.\n'
  );
}
