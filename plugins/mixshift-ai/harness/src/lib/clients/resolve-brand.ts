/**
 * Fuzzy brand-name resolver.
 *
 * Users say "Summit", "Ridgeline Cell", "AOP", "Hearth IQ" — display names,
 * acronyms, prefixes, partial matches. The resolver maps those to a
 * canonical slug from the brand registry (`~/.mixshift/clients/index.yaml`)
 * so commands like `mixshift brand key add` can accept human-friendly
 * input.
 *
 * Resolution order (first hit wins):
 *   1. Slug-shape input (kebab-case) → exact slug match in registry
 *   2. Display name match (case-insensitive, punctuation-stripped)
 *   3. Alias match (retired slug or retained storefront name — feedback
 *      #37278, see below)
 *   4. Acronym match (first letter of each word in display name)
 *   5. Prefix match on normalized display name
 *   6. Substring match on normalized display name
 *
 * Returns `found` (unique match), `ambiguous` (multiple candidates), or
 * `none` (no match). Callers decide what to do — `key add` reports the
 * ambiguity to the user for disambiguation; CI / scripted callers
 * surface the non-zero exit.
 *
 * Stage 3 (alias match) exists so a brand whose registry slug changed
 * identity-preserving (see index.ts's buildIndexFromBrands) — most
 * notably every brand that existed before the alias-first-to-Name-first
 * grouping flip — keeps resolving under names a user still remembers:
 * the brand's own old derived slug, or a MerchantAlias-derived storefront
 * name retained on its accounts. It sits BELOW slug and display-name
 * matching (those are the CURRENT identity and should always win) but
 * ABOVE the generic fuzzy stages (acronym/prefix/substring), since an
 * alias is a specific historical identifier, not a guess.
 */

import { canonicalBrandKey } from '../discovery/brand-grouping.js';
import type { ClientsIndex, IndexBrand } from './index-schema.js';

export type ResolveResult =
  | { status: 'found'; brand: IndexBrand }
  | { status: 'ambiguous'; candidates: IndexBrand[]; normalized_input: string }
  | { status: 'none'; normalized_input: string };

const SLUG_REGEX = /^[a-z][a-z0-9-]*$/;

/**
 * Normalize a string for matching: lowercase, strip non-alphanumeric
 * characters, collapse whitespace. Used for display-name + substring
 * comparisons. Acronyms have their own path.
 */
function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/['‘’]+/g, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the acronym for a display name: first character of each word
 * (after normalization), uppercased. "Aspen Outdoor Provisions" → "AOP".
 * "Hearth IQ USA" → "HIU". "Ridgepak, LLC" → "HL" (after corporate-suffix
 * stripping at the slug layer; we do a softer strip here so users can
 * still acronym-match brand variants). Returns an empty string if no
 * alphabetic content survives.
 */
function acronymFor(displayName: string): string {
  const tokens = normalizeForMatch(displayName).split(/\s+/).filter(Boolean);
  return tokens.map((t) => t[0]?.toUpperCase() ?? '').join('');
}

/**
 * Resolve a user-typed brand reference against the registry.
 *
 * `input` is the raw user string — could be a slug, a display name, an
 * acronym, or a substring. Whitespace around it is trimmed; case is
 * normalized inside the comparator.
 */
export function resolveBrandName(
  input: string,
  index: ClientsIndex,
): ResolveResult {
  const raw = input.trim();
  const normalized = normalizeForMatch(raw);

  // 1. Slug-shape input → exact slug match. Only checked when the input
  //    LOOKS like a slug (kebab-case, lowercase) — avoids false slug-hits
  //    from a display name like "summit labs" (which doesn't match
  //    SLUG_REGEX anyway).
  if (SLUG_REGEX.test(raw)) {
    const slugMatch = index.brands.find((b) => b.slug === raw);
    if (slugMatch) return { status: 'found', brand: slugMatch };
  }

  // 2a. Literal case-insensitive equality (no punctuation stripping).
  //     Wins over the normalized check below — so "Glacier Bottle" matches
  //     "Glacier Bottle" exactly even though "Glacier Bottle®" would also
  //     match if we stripped the ®. Punctuation IS signal for exact
  //     matches; we only collapse it when nothing literal hits.
  const lowerInput = raw.toLowerCase().trim();
  const literalCaseInsensitive = index.brands.filter(
    (b) => b.display_name.toLowerCase().trim() === lowerInput,
  );
  if (literalCaseInsensitive.length === 1) {
    return { status: 'found', brand: literalCaseInsensitive[0]! };
  }
  // Skip ambiguity reporting here — give the normalized step a chance to
  // narrow it down (rare but possible).

  // 2b. Exact display-name match after normalization (case + punctuation
  //     insensitive). Falls through here when the literal check above
  //     either missed or found multiple.
  const exactDisplayMatches = index.brands.filter(
    (b) => normalizeForMatch(b.display_name) === normalized,
  );
  if (exactDisplayMatches.length === 1) {
    return { status: 'found', brand: exactDisplayMatches[0]! };
  }
  if (exactDisplayMatches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: exactDisplayMatches,
      normalized_input: raw,
    };
  }

  // 3. Alias match — a specific historical identifier, not a fuzzy guess,
  //    so no length floor. `aliases[]` holds slug-shaped canonical keys
  //    (the brand's own retired slug plus retained MerchantAlias keys);
  //    canonicalize non-slug-shaped raw input the same way the discovery
  //    layer canonicalizes brand labels so a raw storefront name like
  //    "Forager's Pantry" still matches the stored "foragers-pantry".
  //    Also checked against `slug` itself: the canonicalized form of a
  //    retained alias can equal the CURRENT slug (e.g. the alias that
  //    was the old slug before an identity-preserving carry-forward),
  //    which stage 1 would have missed because raw input was not
  //    already slug-shaped.
  const aliasRawCanonical = SLUG_REGEX.test(raw) ? raw : canonicalBrandKey(raw);
  const aliasCandidates = index.brands.filter(
    (b) => b.slug === aliasRawCanonical || (b.aliases?.includes(aliasRawCanonical) ?? false),
  );
  if (aliasCandidates.length === 1) {
    return { status: 'found', brand: aliasCandidates[0]! };
  }
  if (aliasCandidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: aliasCandidates,
      normalized_input: raw,
    };
  }

  // 4. Acronym match. Only consider acronyms ≥2 chars and where the user
  //    input is ALL UPPERCASE in the original raw form (e.g., "AOP") OR
  //    matches an obvious acronym pattern (e.g., 3-4 chars, no spaces).
  //    This prevents "ca" (could be Canada region) from matching every
  //    brand with a C-A pair.
  const acronymCandidates = (() => {
    if (raw.length < 2 || raw.length > 6) return [] as IndexBrand[];
    if (/\s/.test(raw)) return [] as IndexBrand[]; // has spaces — not an acronym
    const inputUpper = raw.toUpperCase();
    return index.brands.filter((b) => acronymFor(b.display_name) === inputUpper);
  })();
  if (acronymCandidates.length === 1) {
    return { status: 'found', brand: acronymCandidates[0]! };
  }
  if (acronymCandidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: acronymCandidates,
      normalized_input: raw,
    };
  }

  // Prefix + substring matches are too noisy for very short inputs
  //   "ca" matches "Ridgepak - CA" and other " - CA" marketplace variants.
  // Require ≥3 characters for these fuzzy paths. The acronym path above
  // (which requires exact match against the full acronym, not a prefix)
  // already covers most short-input cases like "AOP".
  if (normalized.length < 3) {
    return { status: 'none', normalized_input: raw };
  }

  // 5. Prefix match on the normalized display name. "Summit" matches
  //    "Summit Labs" via prefix; "Hearth IQ" matches "Hearth IQ USA".
  const prefixCandidates = index.brands.filter((b) =>
    normalizeForMatch(b.display_name).startsWith(normalized),
  );
  if (prefixCandidates.length === 1) {
    return { status: 'found', brand: prefixCandidates[0]! };
  }
  if (prefixCandidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: prefixCandidates,
      normalized_input: raw,
    };
  }

  // 6. Substring match on display name. Last-resort — "glacier" might match
  //    Glacier Bottle, Glacier Bottle® (legacy variant), etc. Returns ambiguous
  //    if many; callers should consider this signal weak.
  const substringCandidates = index.brands.filter((b) =>
    normalizeForMatch(b.display_name).includes(normalized),
  );
  if (substringCandidates.length === 1) {
    return { status: 'found', brand: substringCandidates[0]! };
  }
  if (substringCandidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates: substringCandidates,
      normalized_input: raw,
    };
  }

  return { status: 'none', normalized_input: raw };
}

// Exported for tests
export const _internal = { normalizeForMatch, acronymFor };
