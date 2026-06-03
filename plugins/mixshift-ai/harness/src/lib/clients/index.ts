/**
 * Load + save + filter for `~/.mixshift/clients/index.yaml` — the brand
 * registry. See index-schema.ts for the shape rationale.
 *
 * Operations:
 *   readIndex(dataDirOverride?)              load the file (or empty()), validate
 *   saveIndex(index, dataDirOverride?)       atomic write with mode 0600
 *   buildIndexFromBrands(brands, prevIndex)  pure: discovery output → ClientsIndex
 *   filterIndex(index, mode)                 'active' | 'dormant' | 'all'
 *   isStale(index, ttlMs?)                   true if discovered_at older than TTL
 *
 * The auto-refresh decision (TTL-triggered) lives in the caller — readIndex
 * is intentionally pure I/O so tests can drive it without warehouse creds.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { indexPath } from '../paths/resolve.js';
import { formatZodError } from '../profile/format-error.js';
import {
  clientsIndexSchema,
  emptyIndex,
  type ClientsIndex,
  type IndexBrand,
  type IndexAccount,
} from './index-schema.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface LoadIndexResult {
  index: ClientsIndex;
  /** 'file' when read off disk, 'empty' when the file didn't exist yet. */
  source: 'file' | 'empty';
  path: string;
}

/**
 * Load the brand registry. Returns an empty index (schema-valid, epoch-old)
 * if the file doesn't exist — callers can use isStale() to decide whether
 * to trigger a fresh discovery. Throws only on malformed YAML / schema
 * violations; missing-file is the normal first-run state.
 */
export async function readIndex(
  dataDirOverride?: string,
): Promise<LoadIndexResult> {
  const path = indexPath(dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { index: emptyIndex(), source: 'empty', path };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Brand registry at ${path} is malformed YAML: ${message}\n` +
        `Hint: delete the file and run \`mixshift brand discover\` to recreate it.`,
    );
  }

  const result = clientsIndexSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      formatZodError(result.error, `Brand registry at ${path} is invalid`) +
        `\nHint: delete the file and run \`mixshift brand discover\` to recreate it.`,
    );
  }

  return { index: result.data, source: 'file', path };
}

/**
 * Atomic save with mode 0600 (matches credentials.ts pattern). Validates
 * the index before writing so we never persist a broken file.
 */
export async function saveIndex(
  index: ClientsIndex,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const validated = clientsIndexSchema.parse(index);
  const path = indexPath(dataDirOverride);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const yaml = stringifyYaml(validated, { lineWidth: 0 });
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmpPath, yaml, { encoding: 'utf-8', mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, path);

  return { path };
}

/**
 * Build a fresh registry from a discovery run, carrying forward the
 * cold-start state from the previous index. This is the pure-function
 * core of the persistence path — given the discovery output + (optionally)
 * the prior index, produce the new index. No I/O.
 *
 * Cold-start state preservation rule: if a brand was `cold_started: true`
 * in the prior index, it stays `cold_started: true` even if all its
 * accounts have since gone dormant. This protects against transient
 * access lapses — a brand that pauses then resumes shouldn't lose its
 * cold-start work. Slug match drives the carry-forward.
 */
export function buildIndexFromBrands(
  brands: BrandSuggestion[],
  prev: ClientsIndex | null,
): ClientsIndex {
  const prevBySlug = new Map<string, IndexBrand>();
  if (prev) for (const b of prev.brands) prevBySlug.set(b.slug, b);

  const indexBrands: IndexBrand[] = brands.map((b): IndexBrand => {
    const prior = prevBySlug.get(b.slug);
    const accounts: IndexAccount[] = b.accounts.map((a) => ({
      seller_id: a.seller_id,
      seller_name: a.seller_name,
      merchant_alias: a.merchant_alias,
      account_type: a.account_type,
      marketplace: a.marketplace,
      region: a.region,
      // Raw source flags from the warehouse — preserved so a future
      // "why is this dormant" diagnostic can show the underlying state.
      is_active: a.is_active,
      is_mws_user: a.has_mws, // SP-API access flag (legacy column name)
      // Derived "can MixShift actually use this" flags — what consumers
      // should branch on for default-visibility decisions.
      ads_active: a.ads_active,
      retail_active: a.retail_active,
    }));
    const adsActive = accounts.some((a) => a.ads_active);
    const retailActive = accounts.some((a) => a.retail_active);
    return {
      slug: b.slug,
      display_name: b.display_name,
      ads_active: adsActive,
      retail_active: retailActive,
      is_dormant: !adsActive && !retailActive,
      cold_started: prior?.cold_started ?? false,
      cold_started_at: prior?.cold_started_at ?? null,
      accounts,
    };
  });

  return {
    schema_version: 1,
    discovered_at: new Date().toISOString(),
    brands: indexBrands,
  };
}

/**
 * Filter the registry for display. `'active'` (default) hides dormant
 * brands; `'dormant'` shows only them; `'all'` returns everything.
 * Pure function — caller decides what to do with the result.
 */
export function filterIndex(
  index: ClientsIndex,
  mode: 'active' | 'dormant' | 'all' = 'active',
): IndexBrand[] {
  switch (mode) {
    case 'active':
      return index.brands.filter((b) => !b.is_dormant);
    case 'dormant':
      return index.brands.filter((b) => b.is_dormant);
    case 'all':
      return index.brands;
  }
}

/**
 * True when the registry's `discovered_at` is older than the TTL. Callers
 * that need fresh data (e.g. `mixshift brand list` after a long pause)
 * use this to decide whether to trigger a silent refresh before serving.
 */
export function isStale(
  index: ClientsIndex,
  ttlMs: number = DEFAULT_TTL_MS,
): boolean {
  const discoveredMs = new Date(index.discovered_at).getTime();
  if (!Number.isFinite(discoveredMs)) return true;
  return Date.now() - discoveredMs > ttlMs;
}

/**
 * Mark a brand as cold-started in the registry. Persisted atomically;
 * idempotent (calling twice with the same slug just re-stamps the time).
 * Called from mx-account-cold-start's bootstrapBrand on success.
 */
export async function markBrandColdStarted(
  slug: string,
  dataDirOverride?: string,
): Promise<{ updated: boolean; path: string }> {
  const { index, source, path } = await readIndex(dataDirOverride);
  if (source === 'empty') {
    // Nothing to mark — registry hasn't been populated yet. The next
    // discovery run will pick up the cold-start state from the
    // ~/.mixshift/clients/<slug>/ folder existing. Until then, no-op.
    return { updated: false, path };
  }
  const brand = index.brands.find((b) => b.slug === slug);
  if (!brand) {
    return { updated: false, path };
  }
  brand.cold_started = true;
  brand.cold_started_at = new Date().toISOString();
  await saveIndex(index, dataDirOverride);
  return { updated: true, path };
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

/**
 * Run a fresh warehouse discovery, build the new index (carrying forward
 * cold-start state from the prior index), and persist it. Returns the new
 * index so the caller can render it / use the brand counts.
 *
 * Always queries with includeInactive=true — the index is the FULL picture;
 * display layers filter what they show. Discovery failures bubble up to the
 * caller (typed as a thrown Error); a thrown error LEAVES the prior index
 * intact (we never write a partial state).
 */
export async function runDiscoveryAndPersist(args: {
  dataDirOverride?: string;
}): Promise<{ index: ClientsIndex; previousDiscoveredAt: string | null }> {
  // Lazy imports to keep this module's hot path independent of the SQL stack
  // for environments where the index is just being read.
  const { discoverSellers } = await import('../discovery/seller-query.js');
  const { groupIntoBrands } = await import('../discovery/brand-grouping.js');

  const sellers = await discoverSellers({
    dataDirOverride: args.dataDirOverride,
    includeInactive: true, // capture everything for persistence
  });
  const suggestions = groupIntoBrands(sellers);

  // Load the prior index (if any) for cold-start state carry-forward.
  const prior = await readIndex(args.dataDirOverride);
  const previousDiscoveredAt = prior.source === 'file' ? prior.index.discovered_at : null;

  const nextIndex = buildIndexFromBrands(
    suggestions,
    prior.source === 'file' ? prior.index : null,
  );
  await saveIndex(nextIndex, args.dataDirOverride);

  return { index: nextIndex, previousDiscoveredAt };
}

/**
 * Convenience: counts the index by activity state. Used in welcome's
 * post-auth message and brand list footers.
 */
export function countByActivity(index: ClientsIndex): {
  total: number;
  active: number;
  dormant: number;
  cold_started: number;
} {
  return {
    total: index.brands.length,
    active: index.brands.filter((b) => !b.is_dormant).length,
    dormant: index.brands.filter((b) => b.is_dormant).length,
    cold_started: index.brands.filter((b) => b.cold_started).length,
  };
}
