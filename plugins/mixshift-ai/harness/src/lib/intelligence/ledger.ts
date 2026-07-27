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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/** Record a freshly submitted async run. Best-effort; never throws. */
export async function recordIntelligenceRun(
  input: Omit<IntelligenceRunHandle, 'submitted_at' | 'updated_at'>,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = intelligenceRunsPath(dataDirOverride);
    const now = new Date().toISOString();
    const ledger = await loadLedger(path);
    const rest = ledger.filter((h) => h.run_id !== input.run_id);
    await saveLedger(
      path,
      [{ ...input, submitted_at: now, updated_at: now }, ...rest].slice(0, MAX_HANDLES),
    );
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
    const ledger = await loadLedger(path);
    const idx = ledger.findIndex((h) => h.run_id === runId);
    if (idx === -1) return;
    ledger[idx] = { ...ledger[idx]!, status, updated_at: new Date().toISOString() };
    await saveLedger(path, ledger);
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
