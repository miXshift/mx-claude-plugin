/**
 * Group discovered seller rows into proposed brand entries.
 *
 * Grouping signal: a CANONICAL KEY derived from the warehouse `Name`
 * column (exposed as `seller_name` in SellerRow). The Name is the
 * brand label as stored in the warehouse — initially copied from the
 * Amazon storefront (`MerchantAlias`), but user-editable for curated
 * entries like "American Outdoor Products" overriding the default
 * storefront name "Backpacker's Pantry".
 *
 * Warehouse Names vary across marketplaces and account types for the
 * same legal brand. Examples observed:
 *   - "Hydrapak" (VC US)
 *   - "Hydrapak - CA" (VC Canada — marketplace suffix)
 *   - "Hydrapak - DE Sporting Goods - (Pan-EU)" (VC Germany)
 *   - "HydraPak, LLC" (SC US/CA/MX — corporate suffix)
 *
 * Exact-name grouping (the previous behavior) split these into six
 * separate brand entries. Users have to mentally consolidate. The
 * canonical key strips marketplace + corporate suffixes so they
 * collapse to one entry.
 *
 * Canonical key derivation (see `canonicalBrandKey`):
 *   1. Lowercase, normalize unicode
 *   2. Split on first " - ", " — ", or ", " — anything after is metadata
 *      (marketplace suffix, sub-account label, corporate form)
 *   3. Strip apostrophes
 *   4. Strip trailing corporate suffix (LLC / Inc / etc.)
 *   5. Strip non-alphanumeric to hyphens
 *
 * Display name comes from the longest variant in the group (richest
 * representation, usually the "Hydrapak - DE Sporting Goods" form), but
 * the slug uses the canonical key directly. Users still see all the
 * underlying accounts via the per-row marketplace + account_type, so no
 * information is lost.
 *
 * `MerchantAlias` is preserved on each account row for reference but
 * not used for grouping.
 *
 * Slug suggestions come from the canonical key (already slug-shaped).
 * Collisions (rare — would require two legally-distinct brands with the
 * same canonical key) get numeric suffixes.
 */

import type { SellerRow } from './seller-query.js';

export interface BrandSuggestion {
  /** Proposed slug — lowercase, hyphenated, unique within the suggestion set. */
  slug: string;
  /** Human-friendly display name (longest variant from the grouped Names). */
  display_name: string;
  /** All seller rows that group under this brand. */
  accounts: SellerRow[];
  /** Whether any account in the group has ads_active. */
  ads_active: boolean;
  /** Whether any account in the group has retail_active. */
  retail_active: boolean;
}

export function groupIntoBrands(rows: SellerRow[]): BrandSuggestion[] {
  // Bucket rows by canonical brand key. Different marketplace-suffixed
  // names ("Hydrapak", "Hydrapak - CA", "HydraPak, LLC") collapse to
  // the same key ("hydrapak") and land in one brand entry.
  const byCanonical = new Map<string, SellerRow[]>();
  for (const r of rows) {
    const key = canonicalBrandKey(r.seller_name);
    const bucket = byCanonical.get(key) ?? [];
    bucket.push(r);
    byCanonical.set(key, bucket);
  }

  const suggestions: BrandSuggestion[] = [];
  const usedSlugs = new Set<string>();

  // Stable alpha order by canonical key
  const entries = [...byCanonical.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [canonical, accounts] of entries) {
    // Display name = the shortest non-truncated name in the group. This
    // picks "Hydrapak" over "Hydrapak - DE Sporting Goods - (Pan-EU)" —
    // the marketplace suffix is captured per-account via account.marketplace
    // so showing it twice in the brand label is noise.
    const display = pickDisplayName(accounts);
    // Slug FROM the canonical key — already slug-shaped, no need to re-slugify.
    const baseSlug = canonical || 'brand';
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
 * Strip marketplace + corporate suffixes from a warehouse seller_name to
 * produce a canonical brand grouping key. Exported for unit tests.
 *
 * The shape of the key is also a valid slug (matches /^[a-z][a-z0-9-]*$/)
 * so it doubles as the brand slug; no extra slugify pass needed.
 */
export function canonicalBrandKey(name: string): string {
  // Step 1: take everything up to the first " - ", " — ", or ", " — the
  // remainder is marketplace / sub-account / corporate metadata.
  // Examples:
  //   "Hydrapak - CA"                            → "Hydrapak"
  //   "Hydrapak - DE Sporting Goods - (Pan-EU)"  → "Hydrapak"
  //   "HydraPak, LLC"                            → "HydraPak"
  //   "American Outdoor Products"                → "American Outdoor Products"
  let s = name.split(/\s+[-–—]\s+|,\s+/)[0] ?? name;

  // Step 2: lowercase + unicode normalize
  s = s.toLowerCase().normalize('NFKD');

  // Step 3: strip apostrophes (both straight and curly)
  s = s.replace(/['‘’]+/g, '');

  // Step 4: collapse non-alphanumeric to single hyphens
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // Step 5: strip trailing corporate suffix (in case it survived the
  // " - " / ", " split — rare, but defends against names like
  // "AcmeCo LLC" where there's no comma before "LLC").
  s = s.replace(/-(inc|llc|co|corp|corporation|ltd|limited|gmbh)$/, '');

  // Final guard: must start with [a-z]; empty → 'brand'.
  if (s.length === 0) return 'brand';
  if (!/^[a-z]/.test(s)) return `b-${s}`;
  return s;
}

/**
 * Pick the cleanest display name from a group of accounts that share a
 * canonical key. Prefers the shortest name (least marketplace suffix
 * noise) but falls back to the first if there's a tie.
 *
 *   ["Hydrapak", "Hydrapak - CA", "HydraPak, LLC"] → "Hydrapak"
 *   ["American Outdoor Products"] (×4)            → "American Outdoor Products"
 */
function pickDisplayName(accounts: SellerRow[]): string {
  const names = accounts.map((a) => a.seller_name).filter(Boolean);
  if (names.length === 0) return 'Unknown brand';
  return names.reduce((best, cur) =>
    cur.length < best.length ? cur : best,
  );
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
