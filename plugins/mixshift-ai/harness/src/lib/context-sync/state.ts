/**
 * Per-brand context-sync state ledger.
 *
 * Lives at <brandDir>/.context-sync-state.json (see paths/resolve.ts) and
 * records, per doc key, the server revision + content hash observed at the
 * last successful sync. The engine compares against it to distinguish
 * "locally edited" from "server moved" (see engine.ts verdict matrix).
 *
 * Mirrors the pricing-handles ledger pattern: BEST-EFFORT throughout.
 * State loss degrades a future status to 'diverged' at worst — it must
 * never fail a sync. loadState returns a safe default on missing/corrupt
 * files; saveState swallows write errors. Neither throws outward.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contextSyncStatePath } from '../paths/resolve.js';

export interface ContextSyncDocState {
  /** Server revision adopted at last sync. */
  server_revision: number;
  /** sha256 of the local file content at last sync. */
  last_synced_hash: string;
  /** ISO-8601 timestamp of the last sync touch. */
  last_synced_at: string;
}

export interface ContextSyncState {
  schema: 1;
  docs: Record<string, ContextSyncDocState>;
}

export function emptyState(): ContextSyncState {
  return { schema: 1, docs: {} };
}

/**
 * Load the ledger for one brand. Missing file, unreadable file, malformed
 * JSON, or a wrong shape all return the empty default — never throws.
 */
export async function loadState(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<ContextSyncState> {
  try {
    const raw = await readFile(contextSyncStatePath(brandSlug, dataDirOverride), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as ContextSyncState).schema !== 1 ||
      typeof (parsed as ContextSyncState).docs !== 'object' ||
      (parsed as ContextSyncState).docs === null
    ) {
      return emptyState();
    }
    const docs: Record<string, ContextSyncDocState> = {};
    for (const [key, value] of Object.entries((parsed as ContextSyncState).docs)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof value.server_revision === 'number' &&
        typeof value.last_synced_hash === 'string' &&
        typeof value.last_synced_at === 'string'
      ) {
        docs[key] = {
          server_revision: value.server_revision,
          last_synced_hash: value.last_synced_hash,
          last_synced_at: value.last_synced_at,
        };
      }
    }
    return { schema: 1, docs };
  } catch {
    return emptyState();
  }
}

/**
 * Persist the ledger atomically (tmp + rename). Best-effort: a failed save
 * is swallowed — the worst outcome is a stale ledger, which the verdict
 * matrix degrades to 'diverged', never data loss. A failed rename unlinks
 * the tmp file so nothing litters the brand dir (the state basename is
 * dot-prefixed, so the tmp never enters doc enumeration either way).
 */
export async function saveState(
  brandSlug: string,
  state: ContextSyncState,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = contextSyncStatePath(brandSlug, dataDirOverride);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
      await rename(tmpPath, path);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  } catch {
    // Advisory ledger — never worth failing the sync over.
  }
}
