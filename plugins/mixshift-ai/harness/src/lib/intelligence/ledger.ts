/**
 * Local ledger of async MixShift Intelligence run handles.
 *
 * Same rationale as lib/amazon/pricing-handles.ts: in sandboxed schedulers
 * (Cowork scheduled tasks), each shell call is a separate short-lived process
 * with a hard wall around 45s. A slow `intelligence run` on a large account
 * can outlive that wall and get killed; the --async path survives it ONLY if
 * the runId outlives the process. The server is the source of truth for run
 * state — this ledger writes every async submit to
 * `<dataDir>/intelligence-runs.json` so a LATER call (even a fresh session
 * with no memory of the submit) can list pending handles
 * (`mixshift intelligence runs`) and resume with `poll` / `get`.
 *
 * Anchor `MIXSHIFT_DATA_DIR` to a workspace-mounted folder (the
 * mx-auth-service-setup skill does this) and the ledger survives fresh
 * sandboxes alongside the credentials.
 *
 * Every function here is BEST-EFFORT: the ledger is an ergonomic recovery
 * aid, never worth failing the actual Intelligence call over. Errors are
 * swallowed; a corrupt ledger resets to empty.
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { intelligenceRunsPath } from '../paths/resolve.js';

export interface IntelligenceRunHandle {
  run_id: string;
  /** Catalog id the run was started for, e.g. 'INS-MONTHLY-01'. */
  insight_id: string;
  /** Last status this machine saw; the server is the source of truth. */
  status: string;
  /** Best-effort echo of params.merchant, when the caller's params carried a
   *  simple selector — purely for a human scanning `intelligence runs`; also
   *  used to pick a brand-scoped artifact path when `get` later fetches it. */
  brand?: string;
  seller_id?: string;
  submitted_at: string;
  updated_at: string;
}

/** Newest-first cap. Old handles age out; the server keeps the real history. */
const MAX_HANDLES = 50;

async function loadLedger(path: string): Promise<IntelligenceRunHandle[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is IntelligenceRunHandle =>
        typeof h === 'object' &&
        h !== null &&
        typeof (h as IntelligenceRunHandle).run_id === 'string',
    );
  } catch {
    return [];
  }
}

async function saveLedger(path: string, handles: IntelligenceRunHandle[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(handles, null, 2), 'utf8');
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Cross-process lock
//
// loadLedger -> mutate -> saveLedger is a read-modify-write with no
// synchronization: two CLI processes racing (e.g. two scheduled tasks
// sharing a data dir, or a `run --async` and a `poll` landing at the same
// instant) can each load the same snapshot, both mutate their own copy, and
// whichever saveLedger runs last silently clobbers the other's write. This
// is a minimal mutual-exclusion lock around that critical section — no new
// deps: `open(path, 'wx')` is an atomic exclusive-create (fails with EEXIST
// if the lockfile already exists) on every platform Node supports,
// including Windows/NTFS, which is the same primitive a real lock library
// would use underneath.
//
// The ledger is explicitly disposable (the server, not this file, is the
// durable source of truth for run state — see the module doc above), so a
// lock that can't be acquired logs a warning and lets the caller proceed
// WITHOUT it rather than failing the actual Intelligence command over an
// ergonomic recovery aid.
// ---------------------------------------------------------------------------

const LOCK_RETRY_ATTEMPTS = 15;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_STALE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    t.unref?.();
  });
}

/** True when the lockfile is old enough to be an orphan from a process that
 *  died before reaching its `finally` unlink (rather than a live holder). */
async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const st = await stat(lockPath);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    // Disappeared between the failed open() and this check — the holder
    // just released it; not stale, the next loop iteration will succeed.
    return false;
  }
}

/** Best-effort acquire: true once `<path>.lock` is exclusively ours, false
 *  if every attempt in the retry budget was exhausted (caller proceeds
 *  without the lock either way — see the section doc above). */
async function acquireLock(lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        break; // unexpected (permissions, missing dir, ...) — stop retrying
      }
      if (await isLockStale(lockPath)) {
        // Evict the orphan and retry immediately, without burning a full
        // sleep tick on top of the wait we've already done.
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  console.warn(
    `[intelligence] could not acquire the run ledger lock (${lockPath}) after ` +
      `${LOCK_RETRY_ATTEMPTS} attempts. Continuing without it. Best-effort: the server ` +
      'remains the source of truth for run state.',
  );
  return false;
}

/** Run `fn` holding `<ledgerPath>.lock`, best-effort. `fn` still runs even
 *  when the lock couldn't be acquired (see acquireLock); the lock is only
 *  ever unlinked here if THIS call acquired it. */
async function withLedgerLock<T>(ledgerPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${ledgerPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {});
  const acquired = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    if (acquired) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

/** Record a freshly submitted async run. Best-effort; never throws. */
export async function recordIntelligenceRun(
  input: Omit<IntelligenceRunHandle, 'submitted_at' | 'updated_at'>,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = intelligenceRunsPath(dataDirOverride);
    await withLedgerLock(path, async () => {
      const now = new Date().toISOString();
      const ledger = await loadLedger(path);
      const rest = ledger.filter((h) => h.run_id !== input.run_id);
      await saveLedger(
        path,
        [{ ...input, submitted_at: now, updated_at: now }, ...rest].slice(0, MAX_HANDLES),
      );
    });
  } catch {
    // Ledger is advisory; the submit already succeeded.
  }
}

/** Update the last-seen status after a poll / get. Best-effort; never throws. */
export async function updateIntelligenceRunStatus(
  runId: string,
  status: string,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = intelligenceRunsPath(dataDirOverride);
    await withLedgerLock(path, async () => {
      const ledger = await loadLedger(path);
      const idx = ledger.findIndex((h) => h.run_id === runId);
      if (idx === -1) return;
      ledger[idx] = { ...ledger[idx]!, status, updated_at: new Date().toISOString() };
      await saveLedger(path, ledger);
    });
  } catch {
    // Advisory only.
  }
}

/** List recorded handles, newest first. Never throws; missing file = empty. */
export async function listIntelligenceRuns(
  dataDirOverride?: string,
): Promise<{ runs: IntelligenceRunHandle[]; path: string }> {
  const path = intelligenceRunsPath(dataDirOverride);
  return { runs: await loadLedger(path), path };
}
