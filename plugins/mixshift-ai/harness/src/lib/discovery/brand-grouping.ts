/**
 * Group discovered seller rows into proposed brand entries.
 *
 * One brand can hold multiple (SellerID, marketplace, account_type) rows
 * — e.g. SC US + VC US + SC CA all belong to one brand legally. The
 * grouping heuristic here is:
 *
 *   1. Primary signal: `MerchantAlias` (warehouse-curated label for
 *      "this is the same brand even across SC/VC/marketplaces"). Rows
 *      with the same non-empty alias group together.
 *
 *   2. Fallback: `seller_name` exact-match for rows with no alias.
 *
 *   3. Anything still ungrouped becomes its own single-seller brand.
 *
 * Slug suggestions are derived from the alias / name via slugify().
 * Suggestions are starting points — the user can rename at brand-add
 * time. Slug uniqueness within the suggestion set is enforced; collisions
 * get numeric suffixes.
 */

import type { SellerRow } from './seller-query.js';

export interface BrandSuggestion {
  /** Proposed slug — lowercase, hyphenated, unique within the suggestion set. */
  slug: string;
  /** Human-friendly display name (from MerchantAlias when present, else seller_name). */
  display_name: string;
  /** All seller rows that group under this brand. */
  accounts: SellerRow[];
  /** Whether any account in the group has ads_active. */
  ads_active: boolean;
  /** Whether any account in the group has retail_active. */
  retail_active: boolean;
  /** Confidence in the grouping ("alias" is strongest; "name_match" is medium; "singleton" means no grouping signal). */
  group_signal: 'alias' | 'name_match' | 'singleton';
}

export function groupIntoBrands(rows: SellerRow[]): BrandSuggestion[] {
  // First pass: bucket by alias (when present).
  const byAlias = new Map<string, SellerRow[]>();
  const noAlias: SellerRow[] = [];

  for (const r of rows) {
    if (r.merchant_alias) {
      const key = r.merchant_alias.toLowerCase();
      const bucket = byAlias.get(key) ?? [];
      bucket.push(r);
      byAlias.set(key, bucket);
    } else {
      noAlias.push(r);
    }
  }

  // Second pass: bucket non-aliased rows by exact seller_name match.
  const byName = new Map<string, SellerRow[]>();
  const singletons: SellerRow[] = [];

  for (const r of noAlias) {
    const key = r.seller_name.toLowerCase();
    const bucket = byName.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      // Tentatively a singleton — promote to a bucket only if we see another match.
      byName.set(key, [r]);
    }
  }

  for (const [, bucket] of byName) {
    if (bucket.length === 1) singletons.push(bucket[0]!);
  }

  // Build suggestions
  const suggestions: BrandSuggestion[] = [];
  const usedSlugs = new Set<string>();

  const aliasGroups = [...byAlias.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [alias, accounts] of aliasGroups) {
    const baseSlug = slugify(alias);
    suggestions.push(buildSuggestion(baseSlug, alias, accounts, 'alias', usedSlugs));
  }

  const nameGroups = [...byName.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [name, accounts] of nameGroups) {
    const display = accounts[0]!.seller_name;
    const baseSlug = slugify(name);
    suggestions.push(buildSuggestion(baseSlug, display, accounts, 'name_match', usedSlugs));
  }

  for (const account of singletons) {
    const display = account.seller_name;
    const baseSlug = slugify(display);
    suggestions.push(buildSuggestion(baseSlug, display, [account], 'singleton', usedSlugs));
  }

  return suggestions;
}

function buildSuggestion(
  baseSlug: string,
  display: string,
  accounts: SellerRow[],
  signal: BrandSuggestion['group_signal'],
  usedSlugs: Set<string>,
): BrandSuggestion {
  const slug = ensureUniqueSlug(baseSlug, usedSlugs);
  usedSlugs.add(slug);
  return {
    slug,
    display_name: display,
    accounts,
    ads_active: accounts.some((a) => a.ads_active),
    retail_active: accounts.some((a) => a.retail_active),
    group_signal: signal,
  };
}

/**
 * Slugify a label for use as a brand_slug. Output matches the regex in
 * lib/context/schema.ts: ^[a-z][a-z0-9-]*$.
 *
 * Steps:
 *   - lowercase
 *   - replace whitespace + underscore + dot with hyphen
 *   - strip non-[a-z0-9-] characters
 *   - collapse runs of hyphens
 *   - trim leading/trailing hyphens
 *   - strip common corporate suffixes (inc, llc, co, corp, ltd) as a
 *     separate trailing token
 *   - if the result starts with a digit or is empty, prefix with "b-"
 */
export function slugify(input: string): string {
  let s = input
    .toLowerCase()
    .normalize('NFKD')
    // Strip apostrophes (both straight and curly) — "Bob's Burgers" should
    // slug as "bobs-burgers", not "bob-s-burgers".
    .replace(/['‘’]+/g, '')
    // Replace any run of non-alphanumeric characters with a single hyphen.
    // Handles spaces, dots, slashes, ampersands, combining diacritics, etc.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Strip a single trailing corporate-suffix token. Keeps slugs short
  // and stable when the same brand appears with / without the suffix.
  s = s.replace(/-(inc|llc|co|corp|corporation|ltd|limited|gmbh)$/, '');

  if (s.length === 0) return 'brand';
  if (!/^[a-z]/.test(s)) return `b-${s}`;
  return s;
}

/**
 * If `base` is already taken, append -2, -3, ... until unique.
 * Pure function on the set passed in; doesn't mutate.
 */
function ensureUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
