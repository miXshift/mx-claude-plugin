/**
 * On-disk state for the proactive update-notice feature.
 *
 * Two independent readers/writers share this ONE file:
 *   - The SessionStart hook (hooks/session-start.mjs) — a standalone,
 *     zero-dependency Node script that CANNOT import from harness/dist, so it
 *     re-implements this exact shape and the same read/write logic in plain JS.
 *   - The harness (this module), consumed by `mixshift whatsnew --dismiss`.
 *
 * MIRRORED SCHEMA WARNING: if you change `UpdateNoticeState`'s shape, the
 * filename, or the state-dir resolution rule below, you MUST make the
 * matching edit in hooks/session-start.mjs's own copy (search it for
 * "MIRRORED SCHEMA"), and vice versa. The two are never allowed to drift —
 * a shape change on one side without the other silently breaks either the
 * hook's throttling/suppression logic or `whatsnew --dismiss`.
 *
 * State-dir resolution (matches the hook exactly):
 *   1. `CLAUDE_PLUGIN_DATA` env var, if set (used AS-IS, not passed through
 *      resolveDataDir — a plugin-host-provided data dir is already absolute).
 *   2. else `resolveDataDir(dataDirOverride)` (~/.mixshift or
 *      MIXSHIFT_DATA_DIR, or the explicit override).
 */

import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDataDir } from './paths/resolve.js';

export const UPDATE_NOTICE_STATE_FILENAME = 'update-notice-state.json';

/**
 * Strict version-string validator — mirrors hooks/session-start.mjs's own
 * copy exactly (search that file for "isValidVersion"). Version fields in
 * this state file are on-disk and editable by anything with filesystem
 * access, and the hook's copy of this schema feeds a model-directed output
 * channel, so a poisoned value here must never be trusted by either reader.
 * Semver-ish charset only: no whitespace, newlines, backticks, quotes, or
 * other shell/markdown metacharacters; bounded length.
 */
const VERSION_RE = /^[0-9A-Za-z.\-+]{1,64}$/;

function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

export interface UpdateNoticeState {
  /** Version the user last saw this install report as (for detecting an
   *  update between sessions). Null on a brand-new data dir. */
  last_seen_version: string | null;
  /** The most recent "you're on an older version" notice we showed, so we
   *  don't repeat it every session within the throttle window. */
  stale_notice: { version: string; at: string } | null;
  /** Version the user asked to stop being reminded about
   *  (`mixshift whatsnew --dismiss`). Suppresses the stale notice until a
   *  newer version than this ships. */
  dismissed_version: string | null;
  /** Last time we attempted a live marketplace fetch (regardless of
   *  outcome), so an offline host doesn't retry every single session start. */
  last_fetch_attempt_at: string | null;
}

/** Fresh, empty state — used for a brand-new data dir and as the fallback
 *  for a missing or corrupt state file. */
export function emptyUpdateNoticeState(): UpdateNoticeState {
  return {
    last_seen_version: null,
    stale_notice: null,
    dismissed_version: null,
    last_fetch_attempt_at: null,
  };
}

/** Resolve the directory the state file lives in. See module header. */
export function updateNoticeStateDir(dataDirOverride?: string): string {
  return process.env.CLAUDE_PLUGIN_DATA || resolveDataDir(dataDirOverride);
}

export function updateNoticeStatePath(dataDirOverride?: string): string {
  return join(updateNoticeStateDir(dataDirOverride), UPDATE_NOTICE_STATE_FILENAME);
}

/**
 * Load the state file. Missing OR corrupt (unreadable, invalid JSON, wrong
 * shape) collapses to the empty state — never throws. Mirrors the hook's own
 * tolerant read exactly, field by field, so a partially-valid file (e.g. a
 * future field this version doesn't know about, or one bad field) still
 * recovers whatever IS valid rather than discarding the whole file.
 */
export async function loadUpdateNoticeState(
  dataDirOverride?: string,
): Promise<UpdateNoticeState> {
  try {
    const raw = await readFile(updateNoticeStatePath(dataDirOverride), 'utf-8');
    return coerceState(JSON.parse(raw));
  } catch {
    return emptyUpdateNoticeState();
  }
}

function coerceState(parsed: unknown): UpdateNoticeState {
  const p = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const state = emptyUpdateNoticeState();
  if (isValidVersion(p.last_seen_version)) state.last_seen_version = p.last_seen_version;
  if (isValidVersion(p.dismissed_version)) state.dismissed_version = p.dismissed_version;
  if (typeof p.last_fetch_attempt_at === 'string') {
    state.last_fetch_attempt_at = p.last_fetch_attempt_at;
  }
  if (p.stale_notice && typeof p.stale_notice === 'object') {
    const sn = p.stale_notice as Record<string, unknown>;
    if (isValidVersion(sn.version) && typeof sn.at === 'string') {
      state.stale_notice = { version: sn.version, at: sn.at };
    }
  }
  return state;
}

/**
 * Persist the state file atomically (temp file + rename in the same
 * directory), matching the convention used throughout the harness (see
 * profile/save.ts, telemetry/queue.ts). Throws on failure — unlike the hook's
 * best-effort copy, `mixshift whatsnew --dismiss` wants to know if the write
 * didn't happen so it can tell the user instead of silently no-op'ing.
 */
export async function saveUpdateNoticeState(
  state: UpdateNoticeState,
  dataDirOverride?: string,
): Promise<void> {
  const path = updateNoticeStatePath(dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8' });
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
