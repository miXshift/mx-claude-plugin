/**
 * Product-level ACoS targets (mx-ops#291, slice 1).
 *
 * A brand can set an ACoS target per ASIN and per SKU in Brand Context,
 * under `thresholds` in context.yaml. Before this module nothing read them:
 * every target-dependent skill judged every product against the single
 * brand-level `management.acos_target_pct`. This module is the one reader.
 * `brand context resolve` and `skill config` both return its result beside
 * the brand target, and each target-dependent skill uses the product target
 * where one is set and the brand target everywhere else.
 *
 * Canonical shape (whole percents, the same unit as
 * management.acos_target_pct):
 *
 *   thresholds:
 *     acos_target_by_asin:
 *       B0EXAMPLE1: 25
 *     acos_target_by_sku:
 *       SKU-RED-01: 30
 *
 * The reader is tolerant because the map was written by hand (or by Claude)
 * before any reader existed, so the key names vary:
 *   - any `thresholds` key whose name mentions `asin` (or `sku`) and `acos`
 *     or `target` is read as an ASIN (or SKU) map;
 *   - a `thresholds` key mentioning `acos` or `target` whose value nests
 *     `asin`/`asins`/`by_asin` and `sku`/`skus`/`by_sku` maps is read too;
 *   - a map value may be a number (25), a string ("25" or "25%"), or an
 *     object carrying the target (acos_target_pct, acos_target, target_acos,
 *     target_acos_pct, acos_pct, acos, target);
 *   - a list of rows ({asin: B0..., acos_target_pct: 25}) works like a map.
 * A fraction below 1 (0.25) is read as that share of 100 (25), since no ACoS
 * target is under 1%. An entry that cannot be read is listed in `skipped`
 * with the reason, never dropped silently, so a skill can say which
 * products fell back to the brand target and why.
 *
 * Pure: no I/O. Takes the parsed context.yaml (validated or raw).
 */

export interface SkippedProductTarget {
  /** Dotted context path of the map the entry came from. */
  path: string;
  /** The ASIN or SKU as written (or the row index for a list row). */
  id: string;
  reason: string;
}

export interface ProductAcosTargets {
  /** ASIN (upper case) to target, whole percent (25 = 25%). */
  by_asin: Record<string, number>;
  /** SKU (as written, trimmed) to target, whole percent. */
  by_sku: Record<string, number>;
  /** The context.yaml paths the targets were read from. */
  source_paths: string[];
  /** Entries that could not be read; each product here uses the brand target. */
  skipped: SkippedProductTarget[];
  /** How a skill applies the map. Constant; carried so the JSON explains itself. */
  rule: string;
}

export const PRODUCT_TARGET_RULE =
  'Each product on a row uses by_asin[ASIN], else by_sku[SKU], else the brand acos_target. ' +
  'If every product on the row lands on the same target, use it. If they differ, or the row ' +
  'names no product, use the brand acos_target and say so on that row.';

/** Largest target accepted (whole percent). Launch products can run over 100%. */
const MAX_TARGET_PCT = 1000;

const VALUE_KEYS = [
  'acos_target_pct',
  'acos_target',
  'target_acos_pct',
  'target_acos',
  'acos_pct',
  'acos',
  'target',
] as const;

const ASIN_ROW_KEYS = ['asin', 'ASIN', 'child_asin', 'parent_asin'] as const;
const SKU_ROW_KEYS = ['sku', 'SKU', 'seller_sku', 'msku'] as const;

type Kind = 'asin' | 'sku';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Parse one target value to a whole percent, or a reason it cannot be read. */
function parseTargetValue(v: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  let n: number | undefined;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const s = v.trim().replace(/%$/, '').trim();
    if (s.length > 0 && /^[+]?\d*\.?\d+$/.test(s)) n = Number(s);
  } else if (isRecord(v)) {
    for (const k of VALUE_KEYS) {
      if (v[k] !== undefined && v[k] !== null) return parseTargetValue(v[k]);
    }
    return { ok: false, reason: `no target value (expected one of ${VALUE_KEYS.join(', ')})` };
  }
  if (n === undefined || !Number.isFinite(n)) {
    return { ok: false, reason: 'not a number' };
  }
  if (n <= 0) return { ok: false, reason: 'target must be above 0' };
  if (n < 1) n = Math.round(n * 100 * 1e6) / 1e6; // 0.25 means 25%
  if (n > MAX_TARGET_PCT) return { ok: false, reason: `target above ${MAX_TARGET_PCT}%` };
  return { ok: true, value: n };
}

function normalizeId(kind: Kind, raw: string): string {
  const t = raw.trim();
  return kind === 'asin' ? t.toUpperCase() : t;
}

function kindOfKey(key: string): Kind | null {
  const k = key.toLowerCase();
  const aboutTarget = k.includes('acos') || k.includes('target');
  if (!aboutTarget) return null;
  if (k.includes('asin')) return 'asin';
  if (k.includes('sku')) return 'sku';
  return null;
}

const NESTED_KEYS: Record<Kind, readonly string[]> = {
  asin: ['by_asin', 'asin', 'asins', 'per_asin'],
  sku: ['by_sku', 'sku', 'skus', 'per_sku'],
};

class Collector {
  readonly by_asin: Record<string, number> = {};
  readonly by_sku: Record<string, number> = {};
  readonly source_paths: string[] = [];
  readonly skipped: SkippedProductTarget[] = [];

  add(kind: Kind, path: string, rawId: string, rawValue: unknown): void {
    const id = normalizeId(kind, rawId);
    if (id.length === 0) {
      this.skipped.push({ path, id: rawId, reason: `empty ${kind.toUpperCase()}` });
      return;
    }
    const parsed = parseTargetValue(rawValue);
    if (!parsed.ok) {
      this.skipped.push({ path, id: rawId, reason: parsed.reason });
      return;
    }
    const map = kind === 'asin' ? this.by_asin : this.by_sku;
    const existing = map[id];
    if (existing !== undefined && existing !== parsed.value) {
      this.skipped.push({
        path,
        id: rawId,
        reason: `conflicts with ${existing}% set earlier for the same ${kind.toUpperCase()}; kept ${existing}%`,
      });
      return;
    }
    map[id] = parsed.value;
  }

  /** Read a map or a list of rows into `kind`. Returns true if it looked like one. */
  readBlock(kind: Kind, path: string, block: unknown): boolean {
    if (Array.isArray(block)) {
      const idKeys: readonly string[] = kind === 'asin' ? ASIN_ROW_KEYS : SKU_ROW_KEYS;
      block.forEach((row, i) => {
        if (!isRecord(row)) {
          this.skipped.push({ path, id: `#${i}`, reason: 'row is not an object' });
          return;
        }
        const idKey = idKeys.find((k) => typeof row[k] === 'string' && (row[k] as string).trim() !== '');
        if (!idKey) {
          this.skipped.push({ path, id: `#${i}`, reason: `row has no ${kind.toUpperCase()}` });
          return;
        }
        this.add(kind, path, row[idKey] as string, row);
      });
      this.source_paths.push(path);
      return true;
    }
    if (isRecord(block)) {
      for (const [id, v] of Object.entries(block)) this.add(kind, path, id, v);
      this.source_paths.push(path);
      return true;
    }
    return false;
  }
}

/**
 * Read the product-level ACoS targets from a parsed context.yaml. Null when
 * the brand has none (no recognised key under `thresholds`), so a brand
 * without product targets gets exactly what it got before.
 */
export function extractProductAcosTargets(context: unknown): ProductAcosTargets | null {
  if (!isRecord(context)) return null;
  const thresholds = context.thresholds;
  if (!isRecord(thresholds)) return null;

  const c = new Collector();
  // Canonical keys first, so their values win any conflict with an alias.
  const keys = Object.keys(thresholds).sort((a, b) => rank(a) - rank(b));
  for (const key of keys) {
    const block = thresholds[key];
    const path = `thresholds.${key}`;
    const kind = kindOfKey(key);
    if (kind) {
      c.readBlock(kind, path, block);
      continue;
    }
    const k = key.toLowerCase();
    if ((k.includes('acos') || k.includes('target')) && isRecord(block)) {
      for (const nk of ['asin', 'sku'] as const) {
        for (const sub of NESTED_KEYS[nk]) {
          if (block[sub] !== undefined) c.readBlock(nk, `${path}.${sub}`, block[sub]);
        }
      }
    }
  }

  if (c.source_paths.length === 0) return null;
  return {
    by_asin: c.by_asin,
    by_sku: c.by_sku,
    source_paths: c.source_paths,
    skipped: c.skipped,
    rule: PRODUCT_TARGET_RULE,
  };
}

function rank(key: string): number {
  if (key === 'acos_target_by_asin') return 0;
  if (key === 'acos_target_by_sku') return 1;
  return 2;
}

export type ProductTargetSource = 'asin' | 'sku' | 'brand';

export interface ProductTargetChoice {
  /** Whole percent, or null when neither a product nor a brand target exists. */
  value: number | null;
  source: ProductTargetSource;
  /** Why the brand target was used, when it was and the brand has product targets. */
  note?: string;
}

/** One advertised product on a row: its ASIN, its SKU, or both. */
export interface ProductRef {
  asin?: string | null;
  sku?: string | null;
}

export const MIXED_ROW_NOTE =
  'products with different targets share this row: brand target used, not split';
export const NO_PRODUCT_NOTE = 'row names no product: brand target used';

/**
 * The per-row rule every target-dependent skill follows (PRODUCT_TARGET_RULE).
 * Pass the products the row advertises. Each product's target is
 * by_asin[asin], else by_sku[sku], else the brand target. When every product
 * on the row lands on the same target, that target is used; when they differ
 * (a mixed campaign or ad group), the brand target is used with a note,
 * because slice 1 does not split spend and sales between products.
 *
 * With no product map at all this returns the brand target and no note,
 * exactly the behaviour before product targets existed.
 */
export function chooseAcosTarget(
  targets: ProductAcosTargets | null | undefined,
  brandTarget: number | null | undefined,
  products: readonly ProductRef[] = [],
): ProductTargetChoice {
  const brand: number | null =
    typeof brandTarget === 'number' && Number.isFinite(brandTarget) ? brandTarget : null;
  if (!targets) return { value: brand, source: 'brand' };

  const per: Array<{ value: number | null; source: ProductTargetSource }> = [];
  for (const p of products) {
    const asin = typeof p.asin === 'string' ? normalizeId('asin', p.asin) : '';
    const sku = typeof p.sku === 'string' ? normalizeId('sku', p.sku) : '';
    if (asin === '' && sku === '') continue;
    const byAsin = asin !== '' ? targets.by_asin[asin] : undefined;
    const bySku = sku !== '' ? targets.by_sku[sku] : undefined;
    if (byAsin !== undefined) per.push({ value: byAsin, source: 'asin' });
    else if (bySku !== undefined) per.push({ value: bySku, source: 'sku' });
    else per.push({ value: brand, source: 'brand' });
  }
  if (per.length === 0) return { value: brand, source: 'brand', note: NO_PRODUCT_NOTE };

  const distinct = new Set(per.map((x) => x.value));
  if (distinct.size > 1) return { value: brand, source: 'brand', note: MIXED_ROW_NOTE };

  // Every product lands on the same value. Name the most specific source.
  const first = per.find((x) => x.source === 'asin') ?? per.find((x) => x.source === 'sku') ?? per[0]!;
  return { value: first.value, source: first.source };
}
