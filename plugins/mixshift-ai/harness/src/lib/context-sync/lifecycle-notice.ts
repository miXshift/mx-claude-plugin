/**
 * Retired-brand notice for explicit single-brand reads (brand retire,
 * slice 1). `mixshift brand context resolve <slug>` is Step 0 of most skills:
 * when the named brand is retired, the read proceeds exactly as before (its
 * stdout stays byte-identical) and ONE line on stderr says who retired it,
 * when, and how to bring it back.
 *
 * The lifecycle comes from the org-manifest cache (getCachedOrgManifest):
 * a cache hit costs no network at all, and autosync keeps that cache warm on
 * every real attempt. A cold cache costs one budgeted fetch. Every failure is
 * silent (fail open): an unknown lifecycle prints nothing and changes
 * nothing.
 */

import { getCachedOrgManifest, type OrgManifestOptions } from './autosync.js';
import { emitRetiredNotice, findManifestBrand, retiredLifecycleOf } from './lifecycle.js';
import type { WireBrandLifecycle } from './types.js';

/**
 * The lifecycle record of `slug` when the org store lists it as RETIRED;
 * null when it is active, unlisted, or the manifest is unavailable (the
 * callers treat all three the same: say nothing). Never throws.
 */
export async function lookupRetiredLifecycle(
  slug: string,
  options: OrgManifestOptions = {},
): Promise<WireBrandLifecycle | null> {
  try {
    const manifest = await getCachedOrgManifest(options);
    if (!manifest.ok) return null;
    return retiredLifecycleOf(findManifestBrand(manifest.brands, slug));
  } catch {
    return null;
  }
}

/** Print the once-per-process retired notice for `slug` if it is retired. Never throws. */
export async function noticeIfRetired(
  slug: string,
  options: OrgManifestOptions = {},
): Promise<WireBrandLifecycle | null> {
  const lc = await lookupRetiredLifecycle(slug, options);
  if (lc) emitRetiredNotice(slug, lc);
  return lc;
}
