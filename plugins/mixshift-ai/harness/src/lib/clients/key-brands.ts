/**
 * Manage `profile.brands.key` — the user-curated subset of brands that
 * portfolio-level skills (e.g. portfolio-quick-scan) default to. Distinct
 * from the warehouse-derived registry at ~/.mixshift/clients/index.yaml,
 * which lists every brand the user can access.
 *
 * Validation: every slug in `brands.key` MUST exist in the registry.
 * Add operations validate against the registry; reading the list
 * cross-references and flags stale entries (slug present in profile but
 * no longer in registry — happens when ops archives a seller account).
 *
 * Storage: in ~/.mixshift/profile.yaml via the existing profile load/save
 * helpers. Atomic writes inherited from saveProfile().
 */

import { loadProfile } from '../profile/load.js';
import { saveProfile } from '../profile/save.js';
import { defaultProfile, type Profile } from '../profile/schema.js';
import { readIndex } from './index.js';
import { resolveBrandName, type ResolveResult } from './resolve-brand.js';
import type { IndexBrand } from './index-schema.js';

export interface KeyBrand {
  slug: string;
  /** Brand entry from the registry. NULL when slug references a brand
   * that's no longer in the registry (ops archived, registry refreshed
   * before the user dropped the key entry). */
  registry_entry: IndexBrand | null;
}

export interface AddKeyResult {
  status: 'added' | 'already_key' | 'ambiguous' | 'not_found';
  /** Set when status === 'added' or 'already_key' */
  brand?: IndexBrand;
  /** Set when status === 'ambiguous' */
  candidates?: IndexBrand[];
  /** Set when status === 'not_found' or 'ambiguous' */
  normalized_input?: string;
  /** Full key list AFTER the operation (no-op for ambiguous / not_found). */
  key_brands: string[];
}

/**
 * Load the user's current key-brand list, cross-referenced with the
 * registry. Stale entries (slug in profile but missing from registry)
 * come back with `registry_entry: null` so callers can flag them.
 */
export async function loadKeyBrands(
  dataDirOverride?: string,
): Promise<KeyBrand[]> {
  const { profile } = await loadProfile(dataDirOverride);
  const slugs = profile.brands?.key ?? [];
  if (slugs.length === 0) return [];

  const { index } = await readIndex(dataDirOverride);
  const bySlug = new Map<string, IndexBrand>();
  for (const b of index.brands) bySlug.set(b.slug, b);

  return slugs.map((slug) => ({
    slug,
    registry_entry: bySlug.get(slug) ?? null,
  }));
}

/**
 * Add a brand to the key list. Accepts a slug OR a fuzzy display-name
 * input — resolver in resolve-brand.ts handles the lookup. Idempotent:
 * adding an already-key brand returns `status: 'already_key'`.
 */
export async function addKeyBrand(
  input: string,
  dataDirOverride?: string,
): Promise<AddKeyResult> {
  const { index } = await readIndex(dataDirOverride);

  const resolved: ResolveResult = resolveBrandName(input, index);
  if (resolved.status === 'none') {
    const { profile } = await loadProfile(dataDirOverride);
    return {
      status: 'not_found',
      normalized_input: resolved.normalized_input,
      key_brands: profile.brands?.key ?? [],
    };
  }
  if (resolved.status === 'ambiguous') {
    const { profile } = await loadProfile(dataDirOverride);
    return {
      status: 'ambiguous',
      candidates: resolved.candidates,
      normalized_input: resolved.normalized_input,
      key_brands: profile.brands?.key ?? [],
    };
  }

  const slug = resolved.brand.slug;
  const { profile, source } = await loadProfile(dataDirOverride);
  const existing = profile.brands?.key ?? [];

  if (existing.includes(slug)) {
    return {
      status: 'already_key',
      brand: resolved.brand,
      key_brands: existing,
    };
  }

  const next: Profile =
    source === 'file' ? { ...profile } : defaultProfile();
  next.brands = {
    ...(next.brands ?? { key: [] }),
    key: [...existing, slug],
  };
  await saveProfile(next, dataDirOverride);

  return {
    status: 'added',
    brand: resolved.brand,
    key_brands: next.brands.key,
  };
}

export interface RemoveKeyResult {
  status: 'removed' | 'not_key' | 'ambiguous' | 'not_found';
  brand?: IndexBrand;
  candidates?: IndexBrand[];
  normalized_input?: string;
  key_brands: string[];
}

/**
 * Remove a brand from the key list. Accepts the same fuzzy input
 * patterns as add. Idempotent: removing a brand that isn't key returns
 * `status: 'not_key'`.
 */
export async function removeKeyBrand(
  input: string,
  dataDirOverride?: string,
): Promise<RemoveKeyResult> {
  const { profile, source } = await loadProfile(dataDirOverride);
  const existing = profile.brands?.key ?? [];

  // For removal, we can also accept a slug that exists in the key list
  // even if it's no longer in the registry (stale entry cleanup path).
  // Try direct slug match first.
  const inputTrimmed = input.trim();
  if (existing.includes(inputTrimmed)) {
    const next: Profile =
      source === 'file' ? { ...profile } : defaultProfile();
    next.brands = {
      ...(next.brands ?? { key: [] }),
      key: existing.filter((s) => s !== inputTrimmed),
    };
    await saveProfile(next, dataDirOverride);
    return {
      status: 'removed',
      key_brands: next.brands.key,
    };
  }

  // Otherwise resolve via the registry and try again.
  const { index } = await readIndex(dataDirOverride);
  const resolved = resolveBrandName(input, index);
  if (resolved.status === 'none') {
    return {
      status: 'not_found',
      normalized_input: resolved.normalized_input,
      key_brands: existing,
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: resolved.candidates,
      normalized_input: resolved.normalized_input,
      key_brands: existing,
    };
  }

  const slug = resolved.brand.slug;
  if (!existing.includes(slug)) {
    return {
      status: 'not_key',
      brand: resolved.brand,
      key_brands: existing,
    };
  }

  const next: Profile =
    source === 'file' ? { ...profile } : defaultProfile();
  next.brands = {
    ...(next.brands ?? { key: [] }),
    key: existing.filter((s) => s !== slug),
  };
  await saveProfile(next, dataDirOverride);
  return {
    status: 'removed',
    brand: resolved.brand,
    key_brands: next.brands.key,
  };
}

/**
 * Empty the key list. Returns the count of slugs that were removed.
 */
export async function clearKeyBrands(
  dataDirOverride?: string,
): Promise<{ removed_count: number }> {
  const { profile, source } = await loadProfile(dataDirOverride);
  const existing = profile.brands?.key ?? [];
  if (existing.length === 0) return { removed_count: 0 };

  const next: Profile =
    source === 'file' ? { ...profile } : defaultProfile();
  next.brands = { ...(next.brands ?? { key: [] }), key: [] };
  await saveProfile(next, dataDirOverride);
  return { removed_count: existing.length };
}
