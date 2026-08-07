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
 * DISPLAY LABEL vs IDENTITY — these are deliberately decoupled here.
 *
 * The DISPLAY NAME comes from `Name`: that is the field a user curates,
 * so it is the one they should see. (Corrects task #62, 2026-06-10,
 * which read the relationship backwards and labeled brands from
 * MerchantAlias. The header at the time cited a brand-brain-doc claim
 * that does not generalize here — the only concrete warehouse note in
 * that vein, shared/tables.yaml's mws_items notes, is a warning that
 * `mws_items.SellerName` is a denormalized, staleness-prone column on a
 * DIFFERENT table. It says nothing about `seller.Name` vs
 * `seller.MerchantAlias`, and has been corrected to point readers at
 * `seller.Name` for the canonical brand label.)
 *
 * The GROUPING KEY — and therefore the SLUG — deliberately still derives
 * MerchantAlias-first. This is NOT an oversight, and changing it here
 * would be a mistake:
 *
 *   Persisted state is keyed by slug EVERYWHERE (`clients/<slug>/`
 *   directories, org-store documents, timeline idempotency keys), and
 *   the org store is slug-namespaced and SHARED across machines. Slug
 *   carry-forward can only ever be machine-local, because it needs a
 *   prior `index.yaml` on that machine to carry forward FROM. So a
 *   re-key that looks seamless on the machine that performed it
 *   silently re-keys every brand for a teammate on a fresh machine, and
 *   cuts them off from the shared brand documents. On top of that,
 *   `brand add <slug>` would match the NEW derived slug while
 *   `brand list` still showed the CARRIED-FORWARD old one, so the only
 *   identifier a user ever sees is the one that command cannot accept.
 *
 * Brand identity re-keying is therefore its own designed change (Sam,
 * 2026-08-07 — option C), sequenced with the brand-identity resolver,
 * where the server can be the source of truth for identity rather than
 * each machine's local registry. Until then: the label a user reads is
 * curated and current, and the identifier everything is filed under is
 * unchanged and stable. A brand whose Name and MerchantAlias disagree
 * displays the curated name while keeping its existing (alias-derived)
 * slug — visibly inconsistent for those brands, and accepted as the
 * lesser evil against silently orphaning shared state.
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
 * Display name prefers the shortest `Name` among the group's ACTIVE
 * rows, falling back to the shortest `Name` overall when no row in the
 * group is active. It never prefers the alias: an inactive row's `Name`
 * is the one most likely to have gone stale, so a live row's curated
 * name is the better label.
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

  const suggestions: BrandSuggestion[] = [];
  const usedSlugs = new Set<string>();

  // Stable alpha order by canonical key
  const entries = [...byCanonical.entries()].sort(([a], [b]) => a.localeCompare(b));
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
    });
  }

  return suggestions;
}

/**
 * The label a row GROUPS under (and therefore the slug it lands on):
 * `MerchantAlias` when present, else `Name`.
 *
 * Deliberately NOT switched to Name-first alongside the display-label
 * fix. Changing this re-keys existing brands, and slug is the key that
 * `clients/<slug>/` directories, org-store documents, and timeline
 * idempotency keys are all filed under. See the module header for the
 * full reasoning and the sequencing decision. The display-name picker
 * no longer shares this function precisely because the two questions
 * are now answered differently.
 */
function brandLabel(r: SellerRow): string {
  return r.merchant_alias || r.seller_name;
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
 * considers `merchant_alias`: that is the retained storefront label, and
 * showing it was the defect this change fixes. Note this is the one
 * place Name is consulted — the grouping key above still comes from
 * `brandLabel`, which stays alias-first on purpose.
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
