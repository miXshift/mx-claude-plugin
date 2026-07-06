/**
 * Best-effort mirroring of the local key-brand list to the org store's
 * person→brand assignment table (PUT /api/context/assignments, P1 endpoint).
 *
 * Called by `mixshift brand key add|remove|clear` AFTER the local mutation
 * succeeded (and after the local success has been printed — the mirror must
 * never make keying feel slow). The local list stays the source of truth
 * for the plugin (assignments are recorded, not enforced — P1 decision), so:
 *
 *   - failure here NEVER fails or reverts the local change; the command
 *     prints a one-line note and exits as it always did;
 *   - reads are never gated on the server copy;
 *   - offline machines simply drift until the affected key command is
 *     re-run.
 *
 * Each PUT is raced against ASSIGNMENT_TIMEOUT_MS wall-clock: the client's
 * own fetch timeout doesn't cover a token refresh (global fetch, its own
 * 30s timeout), and a blackholed host must not hold an interactive command
 * hostage. Multiple slugs mirror CONCURRENTLY over one shared client.
 */

import {
  createContextSyncClient,
  ASSIGNMENT_TIMEOUT_MS,
  type ContextSyncClient,
} from './client.js';
import { DEADLINE, raceDeadline } from '../utils/deadline.js';

export interface MirrorOutcome {
  op: 'add' | 'remove';
  brand_slug: string;
  mirrored: boolean;
  /** Failure amplification (friendly copy) when mirrored=false. */
  detail?: string;
}

/**
 * Mirror one key-list mutation to the server. Never throws; the boolean
 * outcome is advisory (command layer prints a note on false). Bounded by
 * ASSIGNMENT_TIMEOUT_MS end to end; on deadline the detached PUT is left
 * to finish on its own (its errors are already swallowed by the envelope
 * contract; a late success just means the server converged after all).
 */
export async function mirrorKeyAssignment(
  op: 'add' | 'remove',
  brandSlug: string,
  dataDirOverride?: string,
  client?: ContextSyncClient,
  timeoutMs: number = ASSIGNMENT_TIMEOUT_MS,
): Promise<MirrorOutcome> {
  try {
    const c = client ?? createContextSyncClient({ dataDirOverride });
    const raced = await raceDeadline(
      c.putAssignment({ op, brand_slug: brandSlug, role: 'key' }),
      timeoutMs,
    );
    if (raced === DEADLINE) {
      return {
        op,
        brand_slug: brandSlug,
        mirrored: false,
        detail: `timed out after ${timeoutMs}ms`,
      };
    }
    if (raced.ok) return { op, brand_slug: brandSlug, mirrored: true };
    return { op, brand_slug: brandSlug, mirrored: false, detail: raced.friendly };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { op, brand_slug: brandSlug, mirrored: false, detail: message };
  }
}

/**
 * Mirror several mutations CONCURRENTLY over one shared client (key
 * add/remove accept multiple inputs; clear removes each slug), so N slugs
 * against a blackholed host cost one timeout, not N. Never throws;
 * outcomes come back in input order.
 */
export async function mirrorKeyAssignments(
  op: 'add' | 'remove',
  brandSlugs: string[],
  dataDirOverride?: string,
  client?: ContextSyncClient,
): Promise<MirrorOutcome[]> {
  if (brandSlugs.length === 0) return [];
  const shared = client ?? createContextSyncClient({ dataDirOverride });
  return Promise.all(
    brandSlugs.map((slug) => mirrorKeyAssignment(op, slug, dataDirOverride, shared)),
  );
}

/** One-line stderr note for human output reporting the mirror result:
 *  a success confirmation when everything reached the org store, or a
 *  friendly fallback naming the re-run command when some did not. Empty
 *  string only when there was nothing to mirror. */
export function mirrorStatusNote(outcomes: MirrorOutcome[]): string {
  if (outcomes.length === 0) return '';
  const failed = outcomes.filter((o) => !o.mirrored);
  if (failed.length === 0) {
    return '  ✓ Key brands mirrored to the org store.\n';
  }
  const mirrored = outcomes.length - failed.length;
  const detail = failed[0]?.detail ?? 'unreachable';
  const commands = [...new Set(failed.map((o) => `mixshift brand key ${o.op} ${o.brand_slug}`))];
  const lead = mirrored > 0 ? `  ✓ ${mirrored} mirrored to the org store. ` : '  ';
  return (
    `${lead}note: ${failed.length} key-brand change(s) could not be mirrored ` +
    `to the org store (${detail}). Your local list is updated. To mirror when ` +
    `back online, re-run: ${commands.join('; ')}\n`
  );
}
