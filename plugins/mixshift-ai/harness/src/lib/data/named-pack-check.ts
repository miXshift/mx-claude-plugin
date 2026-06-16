/**
 * Runtime check: do this build's `dispatch: named` catalog ids resolve
 * against the DEPLOYED query pack on the auth service?
 *
 * Extracted so `mixshift doctor` and the release gate
 * (scripts/check-named-pack.mjs) can share one fetch+diff path instead of
 * drifting. This lib answers "which named ids are missing"; callers own
 * credential resolution, logging, and exit-code policy.
 *
 * Never throws — a diagnostic must not crash. Any failure to verify returns
 * `checked: false` with a `reason`, and `ok: true` (nothing is KNOWN broken,
 * so an offline box or a fresh sign-in shouldn't read as a hard failure).
 */

import { loadCatalog } from '../prefetch/sql-library.js';

export interface NamedPackResult {
  /** False when we couldn't run the check (no named ids, or fetch failed). */
  checked: boolean;
  /** True when no catalog `dispatch: named` id is missing from the pack. */
  ok: boolean;
  /** Catalog ids that are NOT in the deployed pack (the skew that bites). */
  missing: string[];
  /** Count of `dispatch: named` ids in THIS build's catalog. */
  total: number;
  /** Per-id SQL revision hash from the deployed manifest (id -> rev). */
  revisions: Record<string, string>;
  /** Set when `checked === false`: why we couldn't verify. */
  reason?: string;
}

interface PackManifest {
  ids?: string[];
  revisions?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetch the deployed pack manifest (`GET {apiBase}/api/named-query/ids`) and
 * diff it against the catalog's `dispatch: named` ids. Pure over
 * (apiBase, accessToken): callers resolve credentials however they like.
 */
export async function checkNamedPackCompat(opts: {
  apiBase: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<NamedPackResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let namedIds: string[];
  try {
    const catalog = await loadCatalog();
    namedIds = catalog.queries
      .filter((q) => q.dispatch === 'named')
      .map((q) => q.id)
      .sort();
  } catch (err) {
    return unchecked(`could not load the SQL catalog: ${msg(err)}`);
  }

  if (namedIds.length === 0) {
    return unchecked('no dispatch:named queries in this build', 0);
  }

  let manifest: PackManifest;
  try {
    const res = await doFetch(`${opts.apiBase}/api/named-query/ids`, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return unchecked(
        `GET /api/named-query/ids returned HTTP ${res.status}`,
        namedIds.length,
      );
    }
    manifest = (await res.json()) as PackManifest;
  } catch (err) {
    return unchecked(
      `could not reach ${opts.apiBase}/api/named-query/ids: ${msg(err)}`,
      namedIds.length,
    );
  }

  const deployed = new Set(manifest.ids ?? []);
  const revisions = manifest.revisions ?? {};
  const missing = namedIds.filter((id) => !deployed.has(id));

  return {
    checked: true,
    ok: missing.length === 0,
    missing,
    total: namedIds.length,
    revisions,
  };
}

function unchecked(reason: string, total = 0): NamedPackResult {
  return { checked: false, ok: true, missing: [], total, revisions: {}, reason };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
