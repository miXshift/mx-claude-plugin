/**
 * Fuzzy brand-name resolver.
 *
 * Users say "Skratch", "Hydro Cell", "AOP", "Home IQ" — display names,
 * acronyms, prefixes, partial matches. The resolver maps those to a
 * canonical slug from the brand registry (`~/.mixshift/clients/index.yaml`)
 * so commands like `mixshift brand key add` can accept human-friendly
 * input.
 *
 * Resolution order (first hit wins):
 *   1. Slug-shape input (kebab-case) → exact slug match in registry
 *   2. Display name match (case-insensitive, punctuation-stripped)
 *   3. Acronym match (first letter of each word in display name)
 *   4. Prefix match on normalized display name
 *   5. Substring match on normalized display name
 *
 * Returns `found` (unique match), `ambiguous` (multiple candidates), or
 * `none` (no match). Callers decide what to do — `key add` reports the
 * ambiguity to the user for disambiguation; CI / scripted callers
 * surface the non-zero exit.
 */

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
 * (after normalization), uppercased. "American Outdoor Products" → "AOP".
 * "Home IQ USA" → "HIU". "HydraPak, LLC" → "HL" (after corporate-suffix
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
  //    from a display name like "skratch labs" (which doesn't match
  //    SLUG_REGEX anyway).
  if (SLUG_REGEX.test(raw)) {
    const slugMatch = index.brands.find((b) => b.slug === raw);
    if (slugMatch) return { status: 'found', brand: slugMatch };
  }

  // 2a. Literal case-insensitive equality (no punctuation stripping).
  //     Wins over the normalized check below — so "Polar Bottle" matches
  //     "Polar Bottle" exactly even though "Polar Bottle®" would also
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

  // 3. Acronym match. Only consider acronyms ≥2 chars and where the user
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
  //   "ca" matches "Ameri-CA-n Outdoor Products" + "Hydrapak - CA" + etc.
  // Require ≥3 characters for these fuzzy paths. The acronym path above
  // (which requires exact match against the full acronym, not a prefix)
  // already covers most short-input cases like "AOP".
  if (normalized.length < 3) {
    return { status: 'none', normalized_input: raw };
  }

  // 4. Prefix match on the normalized display name. "Skratch" matches
  //    "Skratch Labs" via prefix; "Home IQ" matches "Home IQ USA".
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

  // 5. Substring match on display name. Last-resort — "polar" might match
  //    Polar Bottle, Polar Bottle® (legacy variant), etc. Returns ambiguous
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
