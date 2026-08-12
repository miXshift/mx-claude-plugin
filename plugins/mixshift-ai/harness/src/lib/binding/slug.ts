/**
 * Slug minting for sub-brand labels (mx-ops#6 P1; docs/subbrand-architecture.md
 * §4.2 "mint slug" step in mx-legacy-auth).
 *
 * Reuses the existing `slugify()` from lib/discovery/brand-grouping.ts rather
 * than duplicating it — same output shape (`^[a-z][a-z0-9-]*$`, matching
 * lib/context/schema.ts's brand_slug regex), same corporate-suffix stripping,
 * same unicode/apostrophe handling.
 *
 * SLUGS NEVER RENAME (design doc §7, and the same rule the brand-identity
 * grouping key already lives by): once a sub-brand slug is minted and used to
 * create `~/.mixshift/clients/<slug>/`, org-store documents, and timeline
 * idempotency keys, it is permanent. A label rename is a re-BINDING (update
 * binding.retail_label.value / ads_label.value), never a slug rename — see
 * resolve.ts and the coverage-drift handling this module intentionally does
 * NOT own (that is the discover/promote command's job at Phase 2).
 */

import { slugify } from '../discovery/brand-grouping.js';

export { slugify };

/**
 * Mint a unique brand slug for a discovered sub-brand label.
 *
 *   1. Slugify the label value.
 *   2. If unique against `existingSlugs`, done.
 *   3. On collision, prefix with the slugified seller name
 *      (e.g. "acme-agency-forager-pantry" for label "Forager Pantry" under
 *      seller "Acme Agency" — a synthetic example, not an account name).
 *   4. If STILL colliding (or the seller name yields no useful prefix —
 *      empty, or identical to the base slug), append a numeric suffix
 *      (-2, -3, ...) until unique.
 *
 * Pure function: callers assemble `existingSlugs` from every source that
 * must never collide — this tenant's local `~/.mixshift/clients/index.yaml`
 * registry (see collectExistingSlugs below) AND the org-store manifest
 * (other machines' brands the org store already knows about), since a slug
 * is shared cross-machine the moment it is pushed.
 */
export function mintSlug(
  labelValue: string,
  existingSlugs: ReadonlySet<string> | readonly string[],
  sellerName: string,
): string {
  const existing = toSet(existingSlugs);
  const base = slugify(labelValue);
  if (!existing.has(base)) return base;

  // slugify() always returns a non-empty slug (worst case the literal
  // fallback 'brand'), so the only case with no USEFUL prefix is the
  // seller's slug happening to equal the label's own base slug.
  const sellerSlug = slugify(sellerName);
  const prefixed = sellerSlug !== base ? `${sellerSlug}-${base}` : base;
  if (prefixed !== base && !existing.has(prefixed)) return prefixed;

  let n = 2;
  let candidate = `${prefixed}-${n}`;
  while (existing.has(candidate)) {
    n += 1;
    candidate = `${prefixed}-${n}`;
  }
  return candidate;
}

function toSet(slugs: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return slugs instanceof Set ? slugs : new Set(slugs);
}

/**
 * Gather every slug that a newly-minted sub-brand slug must not collide
 * with: this machine's local brand registry, plus every brand the org store
 * already knows about (other machines' brands — a slug is shared the
 * moment it is pushed, so a local-only dedupe check is not enough).
 *
 * Best-effort on the org-store leg: an unreachable/offline org store must
 * never block slug minting — it just means the dedupe check is narrower
 * than ideal for that one run (a genuine collision would still be caught
 * the next time this machine syncs). The local registry read is likewise
 * tolerant of a missing/stale index (readIndex already returns an empty
 * index rather than throwing).
 */
export async function collectExistingSlugs(dataDirOverride?: string): Promise<Set<string>> {
  const slugs = new Set<string>();

  try {
    const { readIndex } = await import('../clients/index.js');
    const { index } = await readIndex(dataDirOverride);
    for (const b of index.brands) slugs.add(b.slug);
  } catch {
    // Registry missing/corrupt — proceed with whatever else we can gather.
  }

  try {
    const { createContextSyncClient } = await import('../context-sync/client.js');
    const client = createContextSyncClient({ dataDirOverride });
    const manifest = await client.fetchManifest();
    if (manifest.ok) {
      for (const b of manifest.brands) slugs.add(b.brand_slug);
    }
  } catch {
    // Org store unreachable — best-effort, never fatal to slug minting.
  }

  return slugs;
}
