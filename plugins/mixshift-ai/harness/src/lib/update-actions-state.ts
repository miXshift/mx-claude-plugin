/**
 * On-disk ledger for guided catch-up actions (`mixshift update-actions`).
 *
 * Mirrors lib/update-notice-state.ts's conventions: atomic tmp+rename
 * writes, and a tolerant never-throw load that recovers whatever fields ARE
 * valid from a partially-shaped or corrupt file rather than discarding the
 * whole thing. Unlike update-notice-state.ts, this file has only ONE
 * reader/writer (the harness itself, via the `update-actions` command) — no
 * standalone hook script mirrors this schema, so there is no "MIRRORED
 * SCHEMA" hazard to keep in lockstep here.
 *
 * State-dir resolution (same rule as update-notice-state.ts):
 *   1. `CLAUDE_PLUGIN_DATA` env var, if set (used AS-IS — a plugin-host-
 *      provided data dir is already absolute).
 *   2. else `resolveDataDir(dataDirOverride)` (~/.mixshift or
 *      MIXSHIFT_DATA_DIR, or the explicit override).
 *
 * Every value on disk is plain JSON, editable by anything with filesystem
 * access. `caught_up_to` and every per-action `version` are gated through
 * the shared `isValidVersion()` shape check (same threat model as
 * update-notice-state.ts's `stale_notice.version`); `status` is gated
 * through a fixed enum. A poisoned entry is dropped on load, never trusted
 * verbatim — this file is never echoed into a model-directed channel
 * unvalidated.
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDataDir } from './paths/resolve.js';
import { isValidVersion } from './update-notice-state.js';

export const UPDATE_ACTIONS_LEDGER_FILENAME = 'update-actions-ledger.json';

export type ActionStatus = 'completed' | 'skipped' | 'dismissed' | 'later';

export const ACTION_STATUSES: readonly ActionStatus[] = [
  'completed',
  'skipped',
  'dismissed',
  'later',
];

export function isValidActionStatus(v: unknown): v is ActionStatus {
  return typeof v === 'string' && (ACTION_STATUSES as readonly string[]).includes(v);
}

export interface ActionLedgerEntry {
  status: ActionStatus;
  /** Installed plugin version at the time this status was recorded. */
  version: string;
  at: string; // ISO
}

export interface ActionsLedger {
  /** Version watermark: actions introduced at or before this version never
   *  surface as pending again. Null on a brand-new data dir (nothing
   *  recorded yet). */
  caught_up_to: string | null;
  actions: Record<string, ActionLedgerEntry>;
}

/** Fresh, empty ledger — used for a brand-new data dir and as the fallback
 *  for a missing or corrupt ledger file. */
export function emptyActionsLedger(): ActionsLedger {
  return { caught_up_to: null, actions: {} };
}

/** Resolve the directory the ledger file lives in. See module header. */
export function actionsLedgerDir(dataDirOverride?: string): string {
  return process.env.CLAUDE_PLUGIN_DATA || resolveDataDir(dataDirOverride);
}

export function actionsLedgerPath(dataDirOverride?: string): string {
  return join(actionsLedgerDir(dataDirOverride), UPDATE_ACTIONS_LEDGER_FILENAME);
}

/**
 * Load the ledger file. Missing OR corrupt (unreadable, invalid JSON, wrong
 * shape) collapses to the empty ledger — never throws. Recovers whatever
 * individual action entries ARE valid rather than discarding the whole file
 * over one bad entry.
 */
export async function loadActionsLedger(dataDirOverride?: string): Promise<ActionsLedger> {
  try {
    const raw = await readFile(actionsLedgerPath(dataDirOverride), 'utf-8');
    return coerceLedger(JSON.parse(raw));
  } catch {
    return emptyActionsLedger();
  }
}

function coerceLedger(parsed: unknown): ActionsLedger {
  const p = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const ledger = emptyActionsLedger();
  if (isValidVersion(p.caught_up_to)) ledger.caught_up_to = p.caught_up_to;

  if (p.actions && typeof p.actions === 'object' && !Array.isArray(p.actions)) {
    for (const [id, rawEntry] of Object.entries(p.actions as Record<string, unknown>)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const rec = rawEntry as Record<string, unknown>;
      if (isValidActionStatus(rec.status) && isValidVersion(rec.version) && typeof rec.at === 'string') {
        ledger.actions[id] = { status: rec.status, version: rec.version, at: rec.at };
      }
    }
  }
  return ledger;
}

/**
 * Persist the ledger atomically (temp file + rename in the same directory),
 * matching update-notice-state.ts's saveUpdateNoticeState. Throws on
 * failure — `mixshift update-actions record|catch-up` want to know if the
 * write didn't happen so they can tell the user instead of silently
 * no-op'ing.
 */
export async function saveActionsLedger(
  ledger: ActionsLedger,
  dataDirOverride?: string,
): Promise<void> {
  const path = actionsLedgerPath(dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf-8' });
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Pure mutator: record (or overwrite) one action's status. Idempotent —
 * calling twice with the same args just re-stamps `at`. Returns a NEW
 * ledger object (does not mutate the input) so callers can load, mutate,
 * save in the usual pattern without aliasing surprises.
 */
export function setActionStatus(
  ledger: ActionsLedger,
  id: string,
  status: ActionStatus,
  version: string,
): ActionsLedger {
  return {
    ...ledger,
    actions: {
      ...ledger.actions,
      [id]: { status, version, at: new Date().toISOString() },
    },
  };
}

/**
 * Pure mutator: advance the caught-up watermark. Caller is responsible for
 * validating `version` (e.g. via isValidVersion) before calling — this
 * function does not re-validate, so it can also be used internally with an
 * already-trusted value.
 */
export function setCaughtUpTo(ledger: ActionsLedger, version: string): ActionsLedger {
  return { ...ledger, caught_up_to: version };
}
