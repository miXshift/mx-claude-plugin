/**
 * Local ledger of async pricing run handles.
 *
 * Why this exists: in sandboxed schedulers (Cowork scheduled tasks), each
 * shell call is a separate short-lived process with a hard wall around 45s.
 * A sync pricing batch can outlive the wall and get killed; the --async path
 * survives it ONLY if the runId outlives the process. The server already
 * persists every run (mcp_legacy_report_runs), so the runId is the one
 * thing standing between a killed process and full recovery. This module
 * writes every async submit to `<dataDir>/pricing-runs.json` so a LATER
 * call — even a fresh session with no memory of the submit — can list
 * pending handles (`mixshift amazon pricing runs`) and resume with
 * poll-run / get-run-result.
 *
 * Anchor `MIXSHIFT_DATA_DIR` to a workspace-mounted folder (the
 * mx-auth-service-setup skill does this) and the ledger survives fresh
 * sandboxes alongside the credentials.
 *
 * Every function here is BEST-EFFORT: the ledger is an ergonomic recovery
 * aid, never worth failing the actual pricing operation over. Errors are
 * swallowed; corrupt ledgers reset to empty.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pricingRunsPath } from '../paths/resolve.js';

export interface PricingRunHandle {
  run_id: string;
  /** CLI operation that started the run. */
  operation: 'foep_batch' | 'competitive_summary_batch';
  items_total: number;
  /** Last status this machine saw; the server is the source of truth. */
  status: string;
  legacy_seller_id?: string;
  marketplace?: string;
  submitted_at: string;
  updated_at: string;
}

/** Newest-first cap. Old handles age out; the server keeps the real history. */
const MAX_HANDLES = 50;

async function loadLedger(path: string): Promise<PricingRunHandle[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (h): h is PricingRunHandle =>
        typeof h === 'object' && h !== null && typeof (h as PricingRunHandle).run_id === 'string',
    );
  } catch {
    return [];
  }
}

async function saveLedger(path: string, handles: PricingRunHandle[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(handles, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Record a freshly submitted async run. Best-effort; never throws. */
export async function recordPricingRun(
  input: Omit<PricingRunHandle, 'submitted_at' | 'updated_at'>,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = pricingRunsPath(dataDirOverride);
    const now = new Date().toISOString();
    const ledger = await loadLedger(path);
    const rest = ledger.filter((h) => h.run_id !== input.run_id);
    await saveLedger(path, [{ ...input, submitted_at: now, updated_at: now }, ...rest].slice(0, MAX_HANDLES));
  } catch {
    // Ledger is advisory; the submit already succeeded.
  }
}

/** Update the last-seen status after a poll / result fetch. Best-effort; never throws. */
export async function updatePricingRunStatus(
  runId: string,
  status: string,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const path = pricingRunsPath(dataDirOverride);
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
export async function listPricingRuns(
  dataDirOverride?: string,
): Promise<{ runs: PricingRunHandle[]; path: string }> {
  const path = pricingRunsPath(dataDirOverride);
  return { runs: await loadLedger(path), path };
}
