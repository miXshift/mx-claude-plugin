/**
 * Brand-name typo clusterer — Phase 1.5 analysis #3.
 *
 * Ported from Todd's `enrich-context.py::detect_brand_term_typos` (v2.3.1+).
 * Reads CS-31 (trailing-90-day converting search-term corpus) and the
 * brand's `brand_terms` + `negation.competitor_brands`, then finds search
 * terms that LOOK like brand traffic but aren't already in
 * `brand_terms.variants`.
 *
 * **Two detection paths:**
 *
 *   Path A — `token_membership`: multi-token search term contains a known
 *     single-word brand variant as a token. E.g. "water bottle polar"
 *     contains "polar" which is in polar_bottle.variants. Trusts the AM's
 *     curated single-word variants list as ground truth for branded intent.
 *     `distance: 0`, `match_type: "token_membership"`.
 *
 *   Path B — `levenshtein`: search term is within a length-aware edit
 *     distance of a canonical brand term. E.g. "hydropack" is dist-2 from
 *     "hydrapak". `distance: 1 | 2`, `match_type: "levenshtein"`.
 *
 * Both paths filter out competitor-brand collisions. Path B additionally
 * filters plural-only matches ("polar bottles" vs "polar bottle").
 *
 * **Output:** clusters keyed by `(canonical_match, root_token)` so the AM
 * gets one decision per cluster instead of N flat rows. Cluster members
 * share the same root token within a canonical's variant family.
 */

import type {
  BrandTermTypoCluster,
  BrandTermVariant,
  TypoMatchType,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CS31Row {
  SearchTerm?: unknown;
  clicks?: unknown;
  spend?: unknown;
  sales?: unknown;
  orders?: unknown;
}

/**
 * Per-sub-brand brand_terms block from context.yaml:
 *   { hydrapak: { canonical: ["hydrapak"], variants: ["hyrdapak", "hydra-pak"] } }
 */
export type BrandTermsBlock = Record<
  string,
  {
    canonical?: string[];
    variants?: string[];
  }
>;

export interface TypoDetectOptions {
  /** Levenshtein max ceiling. Default 2. Per-canonical budgets tighten this. */
  max_dist?: number;
  /** Filter competitor-brand collisions out of the result. */
  competitor_brands?: string[];
}

/**
 * Main entry — returns clusters sorted by total_orders desc, then total_sales.
 */
export function detectBrandTermTypos(
  cs31Rows: CS31Row[],
  brandTerms: BrandTermsBlock | null,
  options: TypoDetectOptions = {},
): BrandTermTypoCluster[] {
  const maxDist = options.max_dist ?? 2;
  const competitorBrands = options.competitor_brands ?? [];
  if (cs31Rows.length === 0 || !brandTerms) return [];

  // -- Build canonical + known sets + single_token_variants map ----------
  const canonicals = new Set<string>();
  const known = new Set<string>();
  // single_token_variants: word → primary canonical of its sub_brand
  const singleTokenVariants = new Map<string, string>();
  for (const td of Object.values(brandTerms)) {
    if (!td || typeof td !== 'object') continue;
    const subCanonicals = (td.canonical ?? []).map((c) => String(c).toLowerCase().trim());
    const primary = subCanonicals[0] ?? null;
    for (const c of subCanonicals) {
      canonicals.add(c);
      known.add(c);
      if (primary && !c.includes(' ')) singleTokenVariants.set(c, primary);
    }
    for (const v of td.variants ?? []) {
      const vl = String(v).toLowerCase().trim();
      known.add(vl);
      if (primary && vl && !vl.includes(' ')) singleTokenVariants.set(vl, primary);
    }
  }
  if (canonicals.size === 0) return [];

  // -- Pass 1: classify each row -----------------------------------------
  type RawMatch = {
    term: string;
    distance: number;
    canonical_match: string;
    root_token: string;
    match_type: TypoMatchType;
    clicks: number;
    spend: number;
    sales: number;
    orders: number;
  };
  const raw: RawMatch[] = [];

  for (const row of cs31Rows) {
    const termRaw = row.SearchTerm;
    if (typeof termRaw !== 'string' || termRaw.trim() === '') continue;
    const term = termRaw;
    const termL = term.toLowerCase().trim();
    const termClean = stripPunct(termL);
    if (known.has(termL) || known.has(termClean)) continue; // already known — skip

    const tokensClean = termL
      .split(/\s+/)
      .map(stripPunct)
      .filter((t) => t.length > 0);

    // -- Path A: token_membership against single-token variants ----------
    let membershipHit: { variant: string; canonical: string } | null = null;
    if (tokensClean.length >= 2 && singleTokenVariants.size > 0) {
      for (const tok of tokensClean) {
        const can = singleTokenVariants.get(tok);
        if (can) {
          membershipHit = { variant: tok, canonical: can };
          break;
        }
      }
    }

    if (membershipHit) {
      // Competitor filter still applies even on membership hit
      if (competitorCollision(termL, competitorBrands)) continue;
      raw.push({
        term,
        distance: 0,
        canonical_match: membershipHit.canonical,
        root_token: membershipHit.variant,
        match_type: 'token_membership',
        clicks: intOrZero(row.clicks),
        spend: safeFloat(row.spend),
        sales: safeFloat(row.sales),
        orders: intOrZero(row.orders),
      });
      continue;
    }

    // -- Path B: Levenshtein typo detection -------------------------------
    let bestDist = Infinity;
    let bestMatch: string | null = null;
    let bestBudget = maxDist;
    for (const canonical of canonicals) {
      const budget = maxDistFor(canonical, maxDist);
      const d = levenshtein(termL, canonical);
      if (d < bestDist) {
        bestDist = d;
        bestMatch = canonical;
        bestBudget = budget;
      }
      for (const tok of tokensClean) {
        const d2 = levenshtein(tok, canonical);
        if (d2 < bestDist) {
          bestDist = d2;
          bestMatch = canonical;
          bestBudget = budget;
        }
      }
    }
    if (bestDist === 0 || bestDist > bestBudget || bestMatch === null) continue;

    // Filter plural-only and competitor collisions
    if (isPluralOnly(termL, bestMatch)) continue;
    if (competitorCollision(termL, competitorBrands)) continue;

    raw.push({
      term,
      distance: bestDist,
      canonical_match: bestMatch,
      root_token: rootToken(termL, bestMatch),
      match_type: 'levenshtein',
      clicks: intOrZero(row.clicks),
      spend: safeFloat(row.spend),
      sales: safeFloat(row.sales),
      orders: intOrZero(row.orders),
    });
  }

  // -- Pass 2: cluster by (canonical_match, root_token) -------------------
  const clusters = new Map<string, RawMatch[]>();
  for (const r of raw) {
    const key = `${r.canonical_match}::${r.root_token}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(r);
  }

  const out: BrandTermTypoCluster[] = [];
  for (const members of clusters.values()) {
    const sorted = [...members].sort(
      (a, b) => b.orders - a.orders || b.sales - a.sales,
    );
    const total_orders = members.reduce((s, m) => s + m.orders, 0);
    const total_sales = members.reduce((s, m) => s + m.sales, 0);
    const total_spend = members.reduce((s, m) => s + m.spend, 0);
    const first = sorted[0]!;

    const variantsToTopN = (rs: RawMatch[], n?: number): BrandTermVariant[] =>
      (n === undefined ? rs : rs.slice(0, n)).map((m) => ({
        term: m.term,
        orders: m.orders,
        sales: round2(m.sales),
        spend: round2(m.spend),
      }));

    out.push({
      canonical_match: first.canonical_match,
      root_token: first.root_token,
      distance: first.distance,
      match_type: first.match_type,
      variant_count: members.length,
      total_orders,
      total_sales: round2(total_sales),
      total_spend: round2(total_spend),
      top_variants: variantsToTopN(sorted, 5),
      all_variants: variantsToTopN(sorted),
    });
  }

  out.sort(
    (a, b) =>
      b.total_orders - a.total_orders || b.total_sales - a.total_sales,
  );
  return out;
}

// ---------------------------------------------------------------------------
// Helpers — all exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Iterative Levenshtein distance — O(len(a) × len(b)), no allocations
 * beyond two row buffers. Zero-dep, mirrors Todd's Python implementation.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr: number[] = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const ins = curr[j]! + 1;
      const del = prev[j + 1]! + 1;
      const sub = prev[j]! + (a[i] === b[j] ? 0 : 1);
      curr.push(Math.min(ins, del, sub));
    }
    prev = curr;
  }
  return prev[prev.length - 1]!;
}

const PUNCT_BOUND_RE = /^[^\w]+|[^\w]+$/g;

/** Strip leading/trailing non-word characters. Preserves internal hyphens + digits. */
export function stripPunct(s: string): string {
  return s.replace(PUNCT_BOUND_RE, '');
}

/**
 * Length-aware Levenshtein budget. Short canonicals can't tolerate dist 2.
 *   len <= 3 → 0 (exact only)
 *   len 4-5 → 1
 *   len >= 6 → configured_max (default 2)
 */
export function maxDistFor(canonical: string, configuredMax: number = 2): number {
  const n = canonical.length;
  if (n <= 3) return 0;
  if (n <= 5) return Math.min(1, configuredMax);
  return configuredMax;
}

/**
 * True if term differs from canonical only by a trailing s/es (plural) on
 * the whole string OR a contained token. Plural-only matches are NOT
 * typos — they're just the plural form.
 */
export function isPluralOnly(term: string, canonical: string): boolean {
  const t = term.toLowerCase().trim();
  const c = canonical.toLowerCase().trim();
  const pluralize = (s: string) => new Set([s + 's', s + 'es']);
  if (pluralize(c).has(t) || pluralize(t).has(c)) return true;
  for (const tok of t.split(/\s+/)) {
    if (pluralize(c).has(tok) || pluralize(tok).has(c)) return true;
  }
  return false;
}

/**
 * Detect that `term` is searching for a competitor brand, not a typo of our
 * brand. Three checks (any one is sufficient):
 *   1. Token-level — any token equals, starts with, or Levenshtein <= max_dist of a competitor
 *   2. Whole-term — the full term is within max_dist of a competitor (catches "hydra peak" → "hydrapeak")
 *   3. Adjacent-pair concat — any two consecutive tokens joined match a competitor
 *
 * Returns the matched competitor brand name, or null.
 */
export function competitorCollision(
  term: string,
  competitorBrands: string[],
  maxDist: number = 1,
  minCompetitorLen: number = 4,
): string | null {
  if (competitorBrands.length === 0) return null;
  const termL = term.toLowerCase().trim();
  const termClean = stripPunct(termL);
  const rawTokens = termL.split(/\s+/);
  const tokens = rawTokens.map(stripPunct).filter((t) => t.length > 0);

  for (const cb of competitorBrands) {
    const cbL = cb.toLowerCase().trim();
    if (!cbL) continue;

    if (cbL.length < minCompetitorLen) {
      // Short competitors: exact-token match only
      for (const tok of tokens) {
        if (tok === cbL) return cb;
      }
      continue;
    }

    if (levenshtein(termL, cbL) <= maxDist) return cb;
    if (termClean && levenshtein(termClean, cbL) <= maxDist) return cb;

    for (const tok of tokens) {
      if (tok === cbL || tok.startsWith(cbL)) return cb;
      if (levenshtein(tok, cbL) <= maxDist) return cb;
    }

    for (let i = 0; i < tokens.length - 1; i++) {
      const joined = tokens[i]! + tokens[i + 1]!;
      if (levenshtein(joined, cbL) <= maxDist) return cb;
    }
  }
  return null;
}

/**
 * Return the token in `term` closest to `canonical` (by Levenshtein). The
 * cluster key — terms sharing the same root token get grouped. Punctuation
 * stripped first so '"hydrapak' and 'hydrapak/' yield the same root.
 */
export function rootToken(term: string, canonical: string): string {
  const t = term.toLowerCase().trim();
  const c = canonical.toLowerCase().trim();
  const tClean = stripPunct(t);
  let bestTok = tClean || t;
  let bestDist = levenshtein(tClean || t, c);
  for (const tok of t.split(/\s+/)) {
    const tokClean = stripPunct(tok);
    if (!tokClean) continue;
    const d = levenshtein(tokClean, c);
    if (d < bestDist) {
      bestDist = d;
      bestTok = tokClean;
    }
  }
  return bestTok;
}

function safeFloat(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function intOrZero(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
