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
import { intentHeader } from '../auth/intent.js';

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
  schema_version?: number;
  ids?: string[];
  revisions?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PUBLIC_PACK_PATH = '/.well-known/mixshift-query-pack';
const LEGACY_PACK_PATH = '/api/named-query/ids';

/**
 * Fetch the public deployed-pack manifest and diff it against the catalog's
 * `dispatch: named` ids. During the gateway deployment transition, a 404 from
 * the well-known route falls back to the authenticated legacy endpoint when a
 * caller supplied an access token.
 */
export async function checkNamedPackCompat(opts: {
  apiBase: string;
  accessToken?: string;
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
  const apiBase = opts.apiBase.replace(/\/+$/, '');
  try {
    const publicRes = await doFetch(`${apiBase}${PUBLIC_PACK_PATH}`, {
      headers: { ...intentHeader() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (publicRes.ok) {
      manifest = (await publicRes.json()) as PackManifest;
      if (manifest.schema_version !== 1) {
        return unchecked(
          `GET ${PUBLIC_PACK_PATH} returned unsupported schema_version`,
          namedIds.length,
        );
      }
    } else if (publicRes.status === 404 && opts.accessToken) {
      const legacyRes = await doFetch(`${apiBase}${LEGACY_PACK_PATH}`, {
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          ...intentHeader(),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!legacyRes.ok) {
        return unchecked(
          `GET ${LEGACY_PACK_PATH} returned HTTP ${legacyRes.status}`,
          namedIds.length,
        );
      }
      manifest = (await legacyRes.json()) as PackManifest;
    } else {
      return unchecked(
        `GET ${PUBLIC_PACK_PATH} returned HTTP ${publicRes.status}`,
        namedIds.length,
      );
    }
  } catch (err) {
    return unchecked(
      `could not reach ${apiBase}${PUBLIC_PACK_PATH}: ${msg(err)}`,
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
