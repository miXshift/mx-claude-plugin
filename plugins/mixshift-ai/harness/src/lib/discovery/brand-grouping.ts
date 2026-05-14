/**
 * Group discovered seller rows into proposed brand entries.
 *
 * Grouping signal: the warehouse `Name` column (exposed as `seller_name`
 * in SellerRow). `Name` is the canonical brand label — initially copied
 * from the Amazon storefront (`MerchantAlias`), but user-editable for
 * curated entries like "American Outdoor Products" overriding the
 * default storefront name "Backpacker's Pantry".
 *
 * Rows sharing the same `Name` belong to the same logical brand
 * regardless of marketplace or account type. Rows with unique names
 * are their own brand. `MerchantAlias` is preserved on each account
 * row for reference but not used for grouping.
 *
 * Future: a `mixshift brand merge <slug1> <slug2>` command will let
 * users consolidate brands that the warehouse hasn't aligned yet
 * (e.g. seven Hydrapak rows that have distinct per-marketplace
 * Names but represent one legal brand).
 *
 * Slug suggestions come from slugify(display_name). Collisions get
 * numeric suffixes.
 */

import type { SellerRow } from './seller-query.js';

export interface BrandSuggestion {
  /** Proposed slug — lowercase, hyphenated, unique within the suggestion set. */
  slug: string;
  /** Human-friendly display name (always seller_name = warehouse `Name`). */
  display_name: string;
  /** All seller rows that group under this brand. */
  accounts: SellerRow[];
  /** Whether any account in the group has ads_active. */
  ads_active: boolean;
  /** Whether any account in the group has retail_active. */
  retail_active: boolean;
}

export function groupIntoBrands(rows: SellerRow[]): BrandSuggestion[] {
  // Bucket rows by canonical Name (case-insensitive). Preserves insertion
  // order via a Map so the first display capitalization wins.
  const byName = new Map<string, SellerRow[]>();
  for (const r of rows) {
    const key = r.seller_name.toLowerCase();
    const bucket = byName.get(key) ?? [];
    bucket.push(r);
    byName.set(key, bucket);
  }

  const suggestions: BrandSuggestion[] = [];
  const usedSlugs = new Set<string>();

  // Stable alpha order by display name
  const entries = [...byName.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, accounts] of entries) {
    const display = accounts[0]!.seller_name;
    const baseSlug = slugify(display);
    const slug = ensureUniqueSlug(baseSlug, usedSlugs);
    usedSlugs.add(slug);
    suggestions.push({
      slug,
      display_name: display,
      accounts,
      ads_active: accounts.some((a) => a.ads_active),
      retail_active: accounts.some((a) => a.retail_active),
    });
  }

  return suggestions;
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
