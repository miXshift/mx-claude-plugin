/**
 * Group discovered seller rows into proposed brand entries.
 *
 * CANONICAL SEMANTICS (feedback #37278): `seller.Name` is the
 * user-curated canonical brand name. It defaults to `MerchantAlias` on
 * the first warehouse pull, then an AM edits it directly as the account
 * gets cleaned up — it is the field that is SUPPOSED to drift from the
 * original storefront label over time. `seller.MerchantAlias`
 * deliberately RETAINS the original Amazon storefront/legal name and is
 * never repointed at the brand identity; it is a historical label, not
 * a curation target.
 *
 * Grouping signal: a CANONICAL KEY derived from `Name` (`seller_name`),
 * which is always non-empty (seller-query.ts's normalizeRow falls back
 * to `seller-${id}` only when the warehouse column itself is blank — a
 * data-quality gap, not the normal case). Two rows land in the same
 * brand entry when their Names collapse to the same canonical key (see
 * `canonicalBrandKey`).
 *
 * (Previously keyed MerchantAlias-first, task #62, 2026-06-10. That read
 * the relationship backwards: MerchantAlias is the retained storefront
 * label, not an AM-curated override of Name. The header at the time
 * cited a brand-brain-doc claim that does not generalize here — the only
 * concrete warehouse note in that vein (shared/tables.yaml's mws_items
 * notes) is a warning that `mws_items.SellerName` is a denormalized,
 * staleness-prone column on a DIFFERENT table (many SKU rows per
 * SellerID, arbitrary row picked without an explicit tie-break). It says
 * nothing about `seller.Name` vs `seller.MerchantAlias`, and has been
 * corrected to point readers at `seller.Name` for the canonical brand
 * label instead.)
 *
 * Consequence worth knowing: a brand whose storefront was renamed on
 * Amazon shows the new `Name` once it is updated, but a sibling account
 * row that never got the same edit can still carry the OLD `Name` — and,
 * having lost ads/retail access around the same time as the rename,
 * never resurfaces in an active discovery pass on its own, so it would
 * otherwise sit as its own stale, unreachable brand entry forever. The
 * merge pass below (`mergeStaleAliasSiblings`) recovers that case: a
 * group with NO active rows folds into a group WITH active rows when the
 * two share a non-null `MerchantAlias` canonical key — the one field
 * that stayed consistent across the rename — and the merged entry is
 * labeled by the active group's `Name`. Retained alias labels that
 * differ from a brand's own Name-derived key are surfaced on
 * `BrandSuggestion.alias_labels` so downstream consumers (the registry's
 * `buildIndexFromBrands` and the brand resolver) can keep resolving a
 * brand by an old storefront name after a rename like this.
 *
 * Warehouse labels also vary across marketplaces and account types for
 * the same legal brand, independent of the Name/MerchantAlias question.
 * Examples observed in `Name`:
 *   - "Ridgepak" (VC US)
 *   - "Ridgepak - CA" (VC Canada — marketplace suffix)
 *   - "Ridgepak - DE Sporting Goods - (Pan-EU)" (VC Germany)
 *   - "Ridgepak, LLC" (SC US/CA/MX — corporate suffix)
 *
 * Exact-name grouping (the original behavior) split these into six
 * separate brand entries. The canonical key strips marketplace +
 * corporate suffixes so they collapse to one entry.
 *
 * Canonical key derivation (see `canonicalBrandKey`):
 *   1. Lowercase, normalize unicode
 *   2. Split on first " - ", " — ", or ", " — anything after is metadata
 *      (marketplace suffix, sub-account label, corporate form)
 *   3. Strip apostrophes
 *   4. Strip trailing corporate suffix (LLC / Inc / etc.)
 *   5. Strip non-alphanumeric to hyphens
 *
 * The same canonicalization is applied to `MerchantAlias` values for the
 * merge pass and for `alias_labels` — a renamed-with-marketplace-suffix
 * alias still collapses the same way a renamed Name would.
 *
 * Display name prefers the shortest `Name` among the group's ACTIVE
 * rows, falling back to the shortest `Name` overall when no row in the
 * group is active. It never prefers the alias — `MerchantAlias` is
 * surfaced separately via `alias_labels`, not folded into the picked
 * display string.
 *
 * Slug suggestions come from the canonical key (already slug-shaped).
 * Collisions (rare — would require two legally-distinct brands with the
 * same canonical key) get numeric suffixes.
 */

import type { SellerRow } from './seller-query.js';

export interface BrandSuggestion {
  /** Proposed slug — lowercase, hyphenated, unique within the suggestion set. */
  slug: string;
  /** Human-friendly display name (shortest active-row Name in the group). */
  display_name: string;
  /** All seller rows that group under this brand. */
  accounts: SellerRow[];
  /** Whether any account in the group has ads_active. */
  ads_active: boolean;
  /** Whether any account in the group has retail_active. */
  retail_active: boolean;
  /**
   * Distinct `MerchantAlias` canonical keys retained on this brand's
   * accounts, EXCLUDING the group's own Name-derived canonical key
   * (`slug`). Surfaces old/retained storefront identities — an alias
   * that outlived a Name-side rename, or the alias that linked a stale
   * sibling row back in via the merge pass — so callers (the registry's
   * `buildIndexFromBrands`, the brand resolver) can still find this
   * brand by a name it no longer canonically uses. Empty when no account
   * in the group carries a MerchantAlias distinct from the Name.
   */
  alias_labels: string[];
}

export function groupIntoBrands(rows: SellerRow[]): BrandSuggestion[] {
  // Bucket rows by canonical Name key. Different marketplace-suffixed
  // labels ("Ridgepak", "Ridgepak - CA", "Ridgepak, LLC") collapse to
  // the same key ("ridgepak") and land in one brand entry.
  const byCanonical = new Map<string, SellerRow[]>();
  for (const r of rows) {
    const key = canonicalBrandKey(brandLabel(r));
    const bucket = byCanonical.get(key) ?? [];
    bucket.push(r);
    byCanonical.set(key, bucket);
  }

  // Fold stale (no active rows) Name-groups into an active Name-group
  // they share a MerchantAlias with. See the module header and
  // `mergeStaleAliasSiblings` for why this exists.
  const groups = mergeStaleAliasSiblings(byCanonical);

  const suggestions: BrandSuggestion[] = [];
  const usedSlugs = new Set<string>();

  // Stable alpha order by canonical key
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [canonical, accounts] of entries) {
    // Display name = the shortest non-truncated active-row Name in the
    // group. This picks "Ridgepak" over "Ridgepak - DE Sporting Goods -
    // (Pan-EU)" — the marketplace suffix is captured per-account via
    // account.marketplace so showing it twice in the brand label is noise.
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
      alias_labels: aliasLabelsFor(accounts, canonical),
    });
  }

  return suggestions;
}

/**
 * The brand label a row groups under: the user-curated `Name`. Always
 * non-empty — see seller-query.ts's normalizeRow. Single source of
 * truth for both the grouping key and the display-name picker.
 */
function brandLabel(r: SellerRow): string {
  return r.seller_name;
}

/**
 * Merge pass: fold a stale (no active rows) Name-group into an active
 * Name-group when the two share a non-null `MerchantAlias` canonical
 * key.
 *
 * Why this exists: `Name` can lag a storefront rename on a sibling
 * account row that lost ads/retail access around the same time —
 * nobody circles back to fix the Name on a dormant row. `MerchantAlias`
 * is the field the warehouse never repoints, so it is the reliable link
 * back to the still-live brand.
 *
 * A stale group only merges when its alias key resolves to EXACTLY ONE
 * active group. If it resolves to more than one (the alias itself was
 * reused across two live brands — unusual but not impossible data), the
 * groups are left separate rather than guessed at. Deterministic:
 * depends only on the alias-key relationships between groups, not on
 * Map iteration order.
 *
 * Pure function — the input map is not mutated; returns a new map.
 */
function mergeStaleAliasSiblings(
  byCanonical: Map<string, SellerRow[]>,
): Map<string, SellerRow[]> {
  const isActiveGroup = (accounts: SellerRow[]): boolean =>
    accounts.some((a) => a.ads_active || a.retail_active);

  // alias canonical key -> set of ACTIVE group canonical keys carrying it.
  const aliasToActiveGroups = new Map<string, Set<string>>();
  for (const [canonical, accounts] of byCanonical) {
    if (!isActiveGroup(accounts)) continue;
    for (const a of accounts) {
      if (!a.merchant_alias) continue;
      const aliasKey = canonicalBrandKey(a.merchant_alias);
      const set = aliasToActiveGroups.get(aliasKey) ?? new Set<string>();
      set.add(canonical);
      aliasToActiveGroups.set(aliasKey, set);
    }
  }

  // Resolve at most one merge target per stale group.
  const mergeTargetOf = new Map<string, string>(); // stale canonical -> target canonical
  for (const [canonical, accounts] of byCanonical) {
    if (isActiveGroup(accounts)) continue;
    let target: string | undefined;
    let ambiguous = false;
    for (const a of accounts) {
      if (!a.merchant_alias) continue;
      const aliasKey = canonicalBrandKey(a.merchant_alias);
      const candidates = aliasToActiveGroups.get(aliasKey);
      if (!candidates) continue;
      for (const cand of candidates) {
        if (target === undefined) target = cand;
        else if (target !== cand) ambiguous = true;
      }
    }
    if (target !== undefined && !ambiguous) {
      mergeTargetOf.set(canonical, target);
    }
  }

  const merged = new Map<string, SellerRow[]>();
  for (const [canonical, accounts] of byCanonical) {
    if (mergeTargetOf.has(canonical)) continue; // absorbed below
    merged.set(canonical, [...accounts]);
  }
  for (const [staleCanonical, target] of mergeTargetOf) {
    const staleAccounts = byCanonical.get(staleCanonical)!;
    const targetAccounts = merged.get(target);
    // Defensive: target is always present — it was an active group, and
    // active groups are never keys in mergeTargetOf.
    if (!targetAccounts) continue;
    targetAccounts.push(...staleAccounts);
  }
  return merged;
}

/**
 * Strip marketplace + corporate suffixes from a warehouse brand label
 * (Name or MerchantAlias) to produce a canonical brand grouping key.
 * Exported for unit tests.
 *
 * The shape of the key is also a valid slug (matches /^[a-z][a-z0-9-]*$/)
 * so it doubles as the brand slug; no extra slugify pass needed.
 */
export function canonicalBrandKey(name: string): string {
  // Step 1: take everything up to the first " - ", " — ", or ", " — the
  // remainder is marketplace / sub-account / corporate metadata.
  // Examples:
  //   "Ridgepak - CA"                            → "Ridgepak"
  //   "Ridgepak - DE Sporting Goods - (Pan-EU)"  → "Ridgepak"
  //   "Ridgepak, LLC"                            → "Ridgepak"
  //   "Aspen Outdoor Provisions"                → "Aspen Outdoor Provisions"
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
 * canonical key. Prefers the shortest `Name` among ACTIVE accounts
 * (least marketplace/corporate-suffix noise); falls back to the
 * shortest `Name` overall when no account in the group is active. Never
 * considers `merchant_alias` — see `BrandSuggestion.alias_labels` for
 * that.
 *
 *   names ["Ridgepak", "Ridgepak - CA", "Ridgepak, LLC"] (all active) → "Ridgepak"
 *   ["Aspen Outdoor Provisions"] (×4, all active)          → "Aspen Outdoor Provisions"
 */
function pickDisplayName(accounts: SellerRow[]): string {
  const activeNames = accounts
    .filter((a) => a.ads_active || a.retail_active)
    .map((a) => a.seller_name)
    .filter(Boolean);
  const pool = activeNames.length > 0
    ? activeNames
    : accounts.map((a) => a.seller_name).filter(Boolean);
  if (pool.length === 0) return 'Unknown brand';
  return pool.reduce((best, cur) =>
    cur.length < best.length ? cur : best,
  );
}

/**
 * Distinct MerchantAlias canonical keys on `accounts` that differ from
 * the group's own Name-derived canonical key (`nameCanonical`). Sorted
 * for deterministic output. See `BrandSuggestion.alias_labels`.
 */
function aliasLabelsFor(accounts: SellerRow[], nameCanonical: string): string[] {
  const keys = new Set<string>();
  for (const a of accounts) {
    if (!a.merchant_alias) continue;
    const aliasKey = canonicalBrandKey(a.merchant_alias);
    if (aliasKey && aliasKey !== nameCanonical) keys.add(aliasKey);
  }
  return [...keys].sort();
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
