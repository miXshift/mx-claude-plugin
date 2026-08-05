/**
 * Per-brand context-sync state ledger.
 *
 * Lives at <brandDir>/.context-sync-state.json (see paths/resolve.ts) and
 * records, per doc key, the server revision + content hash observed at the
 * last successful sync. The engine compares against it to distinguish
 * "locally edited" from "server moved" (see engine.ts verdict matrix).
 *
 * The ledger is TENANT-BOUND: revisions are small integers scoped to one
 * server-side store, so a ledger recorded against org A compared to org B's
 * manifest can coincide revision-for-revision and silently misclassify
 * either side. `identity` records the server+tenant the entries belong to;
 * on a mismatch the ledger is treated as empty (docs degrade to untracked —
 * hash-identity self-heal or diverged, fail safe).
 *
 * Mirrors the pricing-handles ledger pattern: BEST-EFFORT throughout.
 * State loss degrades a future status to 'diverged' at worst — it must
 * never fail a sync. loadState returns a safe default on missing/corrupt
 * files; saveState swallows write errors. Neither throws outward.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadCredentials } from '../auth/credentials.js';
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
  schema: 2;
  /**
   * Server + tenant identity the entries were recorded against (see
   * resolveLedgerIdentity). Absent on schema-1 files written before the
   * field existed — those are trusted as-is and adopt the current identity
   * on the next save.
   */
  identity?: string;
  /**
   * ISO-8601 timestamp of the last preflight auto-sync ATTEMPT for this
   * brand (see autosync.ts). Schema-tolerant like `identity`: absent on
   * files written before the field existed, and preserved across identity
   * rebinds — the throttle limits attempts per brand per window regardless
   * of tenant, so a stale stamp only ever means FEWER attempts.
   */
  last_autosync_at?: string;
  /**
   * Structural-events sync stamp (#37499): content hash of the brand's
   * context.yaml structural_events block at the last FULLY-successful stake
   * sync, plus when. The auto-publish seam skips its stake leg when the
   * hash is unchanged (zero network on the common no-events-changed write).
   * Advisory like everything here: a stale/absent stamp only ever means one
   * extra sync, and the server's idempotency keys make that a no-op.
   * Identity-bound like `docs` — dropped on a tenant rebind (a hash proves
   * sync to THAT tenant's timeline only).
   */
  stakes?: { last_synced_hash: string; last_synced_at: string };
  docs: Record<string, ContextSyncDocState>;
}

export function emptyState(identity?: string | null): ContextSyncState {
  return { schema: 2, ...(identity ? { identity } : {}), docs: {} };
}

/**
 * Resolve the server+tenant identity the ledger is bound to, WITHOUT a
 * network call: `<api_base>#<user_id>` from the stored datahub credentials
 * (interactive sign-ins), else `<api_base>#<client_id>` from the service
 * block (unattended installs) — the same precedence the sync client uses
 * for api_base. Returns null when no credentials exist or the file is
 * unreadable; identity checks are skipped in that case (the sync client
 * fails with its own friendly error long before a verdict matters).
 */
export async function resolveLedgerIdentity(
  dataDirOverride?: string,
): Promise<string | null> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    if (credentials?.datahub) {
      return `${credentials.datahub.api_base}#${credentials.datahub.user_id}`;
    }
    if (credentials?.service) {
      return `${credentials.service.api_base}#${credentials.service.client_id}`;
    }
    return null;
  } catch {
    // Malformed credentials are the auth layer's problem, not the ledger's.
    return null;
  }
}

/**
 * Load the ledger for one brand. Missing file, unreadable file, malformed
 * JSON, or a wrong shape all return the empty default — never throws.
 *
 * `currentIdentity` (from resolveLedgerIdentity) binds the read: when the
 * stored identity differs, the ledger belongs to another server/tenant and
 * is treated as EMPTY for verdict purposes; the identity is overwritten on
 * the next save. A ledger without a stored identity (schema-1 era) or a
 * null/undefined currentIdentity skips the check.
 */
export async function loadState(
  brandSlug: string,
  dataDirOverride?: string,
  currentIdentity?: string | null,
): Promise<ContextSyncState> {
  try {
    const raw = await readFile(contextSyncStatePath(brandSlug, dataDirOverride), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      ((parsed as { schema?: unknown }).schema !== 1 &&
        (parsed as { schema?: unknown }).schema !== 2) ||
      typeof (parsed as ContextSyncState).docs !== 'object' ||
      (parsed as ContextSyncState).docs === null
    ) {
      return emptyState(currentIdentity);
    }
    const storedAutosyncAt = (parsed as { last_autosync_at?: unknown }).last_autosync_at;
    const lastAutosyncAt =
      typeof storedAutosyncAt === 'string' ? storedAutosyncAt : undefined;
    const storedIdentity = (parsed as { identity?: unknown }).identity;
    if (
      typeof storedIdentity === 'string' &&
      typeof currentIdentity === 'string' &&
      storedIdentity !== currentIdentity
    ) {
      // Different server/tenant: org A's revisions say nothing about org
      // B's manifest. Fail safe — verdicts run as if untracked. The
      // autosync stamp survives the rebind (attempt limiting is not
      // tenant-bound; see the field doc above).
      return {
        ...emptyState(currentIdentity),
        ...(lastAutosyncAt !== undefined ? { last_autosync_at: lastAutosyncAt } : {}),
      };
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
    // Stake-sync stamp (#37499): same explicit reconstruction as docs — a
    // malformed value degrades to "no stamp" (one extra idempotent sync).
    const storedStakes = (parsed as { stakes?: unknown }).stakes;
    const stakes =
      typeof storedStakes === 'object' &&
      storedStakes !== null &&
      typeof (storedStakes as { last_synced_hash?: unknown }).last_synced_hash === 'string' &&
      typeof (storedStakes as { last_synced_at?: unknown }).last_synced_at === 'string'
        ? {
            last_synced_hash: (storedStakes as { last_synced_hash: string }).last_synced_hash,
            last_synced_at: (storedStakes as { last_synced_at: string }).last_synced_at,
          }
        : undefined;
    const identity =
      currentIdentity ?? (typeof storedIdentity === 'string' ? storedIdentity : undefined);
    return {
      schema: 2,
      ...(identity ? { identity } : {}),
      ...(lastAutosyncAt !== undefined ? { last_autosync_at: lastAutosyncAt } : {}),
      ...(stakes !== undefined ? { stakes } : {}),
      docs,
    };
  } catch {
    return emptyState(currentIdentity);
  }
}

/**
 * Persist the ledger atomically (tmp + rename). Best-effort: a failed save
 * is swallowed — the worst outcome is a stale ledger, which the verdict
 * matrix degrades to 'diverged', never data loss. A failed rename unlinks
 * the tmp file so nothing litters the brand dir (the state basename is
 * dot-prefixed, so the tmp never enters doc enumeration either way).
 *
 * The tmp suffix carries a random component: pid + timestamp alone collide
 * when two saves in the same process land in the same millisecond, and an
 * interleaved write/rename could then put mixed bytes in place.
 *
 * Returns true when the ledger actually reached disk. Callers that GATE on
 * persistence branch on it (autosync must skip its network attempt when
 * the throttle stamp could not be recorded — otherwise a read-only brand
 * dir would stall every skill step for the full budget with zero signal);
 * sync-flow callers ignore it.
 */
export async function saveState(
  brandSlug: string,
  state: ContextSyncState,
  dataDirOverride?: string,
): Promise<boolean> {
  try {
    const path = contextSyncStatePath(brandSlug, dataDirOverride);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
      await rename(tmpPath, path);
      return true;
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  } catch {
    // Advisory ledger — never worth failing the sync over.
    return false;
  }
}
