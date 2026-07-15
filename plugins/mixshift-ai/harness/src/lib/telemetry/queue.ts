/**
 * Disk-backed append-only telemetry queue.
 *
 * Every `track()` call writes one JSON line to
 * `~/.mixshift/telemetry/queue.jsonl`. The flusher reads the queue, POSTs
 * batches to Supabase, and atomically truncates on success.
 *
 * Why disk-backed: CLI processes are short-lived. If we batched in memory
 * the events would be lost on every exit. Append-only JSONL lets every
 * invocation contribute events; the next invocation drains them.
 *
 * Why JSONL (not JSON-array): append is O(1), no need to read-modify-write
 * the whole file. Each line is a self-contained event record.
 *
 * Concurrency: two concurrent CLI invocations both appending is safe because
 * POSIX `O_APPEND` writes are atomic for small payloads (well under the
 * PIPE_BUF limit). On Windows, Node's fs.appendFile also acquires an
 * exclusive write lock per-call so concurrent appends serialize cleanly.
 *
 * Drain race: if two flushers run simultaneously they could both pull the
 * same lines and double-send. We accept this rare case rather than add a
 * lockfile — duplicate events show up as duplicate rows in Supabase which
 * is filterable downstream. (And in practice the harness runs single-shot
 * per CLI command, so concurrent drains are unusual.)
 */

import { appendFile, readFile, writeFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { telemetryQueuePath } from '../paths/resolve.js';
import type { TelemetryEventRecord } from './events.js';

/**
 * Append one event record to the queue. Fast — does not flush, does not
 * wait for the network. The append is `O_APPEND` so concurrent CLI runs
 * cooperate safely.
 */
export async function enqueueEvent(
  record: TelemetryEventRecord,
  dataDirOverride?: string,
): Promise<void> {
  const path = telemetryQueuePath(dataDirOverride);
  const line = JSON.stringify(record) + '\n';
  try {
    await appendFile(path, line, { encoding: 'utf-8' });
  } catch (err) {
    if (isFileNotFoundError(err)) {
      // First call — create the dir, then retry. We don't proactively mkdir
      // on every call because the dir typically exists after first run.
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, { encoding: 'utf-8' });
    } else {
      // Telemetry is best-effort. Never throw out of the track() path —
      // user commands must not fail because of a busted queue file.
      // Eat the error silently. (Tests can inspect the queue directly.)
    }
  }
}

/**
 * Read every queued event. Returns an empty array if the queue file doesn't
 * exist yet. Skips malformed lines (best-effort drain).
 */
export async function readQueue(
  dataDirOverride?: string,
): Promise<TelemetryEventRecord[]> {
  const path = telemetryQueuePath(dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) return [];
    return [];
  }
  if (!raw.trim()) return [];

  const events: TelemetryEventRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as TelemetryEventRecord;
      events.push(ev);
    } catch {
      // Malformed line — skip silently. Could log to stderr if --verbose.
    }
  }
  return events;
}

/**
 * Empty the queue. Called after a successful flush.
 *
 * The on-disk write is ATOMIC (temp file + rename; see atomicWrite below), so
 * a hard kill mid-clear can never leave a torn or partially-written file — a
 * concurrent reader sees either the full old contents or the empty file.
 *
 * KNOWN LIMITATION (deferred): there's an inherent concurrent-append race —
 * between readQueue() and clearQueue(), new events may have been appended by a
 * different CLI process, and this whole-file overwrite clobbers them. To avoid
 * losing those events, callers would pass `keepFromOffset` (the byte size of
 * the queue file when readQueue was called) so anything written past that
 * offset is preserved. We don't do this today because concurrent CLI runs are
 * rare; the offset-preserving clear (plus a lockfile) is the proper fix and is
 * deferred. See overwriteQueue's doc comment.
 */
export async function clearQueue(
  dataDirOverride?: string,
): Promise<void> {
  await atomicWrite(telemetryQueuePath(dataDirOverride), '');
}

/**
 * Overwrite the queue file with exactly `records` (JSONL), replacing whatever
 * was there. Used by the flusher to drop already-accepted batches from the
 * persisted queue after each successful POST, so a mid-flush failure can't
 * leave an accepted batch behind to be resent next invocation.
 *
 * ATOMIC on disk: the rewrite goes to a unique temp file in the same directory
 * and is then rename()d over the queue (see atomicWrite below). rename() is
 * atomic on a single filesystem, so a hard kill mid-write can no longer leave
 * the queue empty or torn with the not-yet-sent tail lost — a reader (or the
 * next invocation) sees either the full previous contents or the full new
 * tail, never a partial file.
 *
 * Best-effort: never throws (matches clearQueue). If the write fails the queue
 * keeps its previous contents, which at worst means an accepted batch is
 * resent later — an at-least-once outcome, never data loss.
 *
 * KNOWN LIMITATION (deferred): the atomic write closes the torn-file window
 * but NOT the concurrent-append race. This is a whole-file rewrite built from
 * the in-memory readQueue() snapshot with no offset preservation, so an event
 * appended by a *concurrent* `mixshift` process between readQueue() and this
 * rewrite is truncated away (clobbered). This is a pre-existing, accepted race
 * — the harness runs single-shot per command, so concurrent drains are
 * unusual (see the module comment and clearQueue's `keepFromOffset` note). The
 * atomic-write change here does not fix it and marginally extends its window.
 * The proper fix is an offset-preserving clear plus a lockfile; it is
 * intentionally DEFERRED, not addressed by this change.
 */
export async function overwriteQueue(
  records: TelemetryEventRecord[],
  dataDirOverride?: string,
): Promise<void> {
  const path = telemetryQueuePath(dataDirOverride);
  const body = records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  await atomicWrite(path, body);
}

/**
 * Overwrite `path` atomically: write `body` to a unique temp file in the same
 * directory, then rename() it over the target. rename() is atomic within a
 * single filesystem, so a concurrent reader — or a process hard-killed
 * mid-write — never observes a truncated or half-written file; it sees either
 * the whole old file or the whole new file. Matches the temp-then-rename
 * pattern used throughout the harness (e.g. saveBrain in brain/read.ts,
 * auth/credentials.ts, profile/save.ts).
 *
 * Best-effort: never throws (telemetry must not fail user commands). On any
 * failure the previous file contents survive intact (the rename never
 * happened), and we make a best-effort attempt to remove the temp file so a
 * failed write leaves no `.tmp` sibling behind.
 */
async function atomicWrite(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, body, { encoding: 'utf-8' });
    await rename(tmp, path);
  } catch {
    // Swallow — see caller doc comments (previous contents survive,
    // at-least-once). Clean up the temp file on a best-effort basis.
    try {
      await unlink(tmp);
    } catch {
      // ignore
    }
  }
}

/**
 * Size of the queue file in bytes (for the rare debug case).
 */
export async function queueSizeBytes(
  dataDirOverride?: string,
): Promise<number> {
  try {
    const s = await stat(telemetryQueuePath(dataDirOverride));
    return s.size;
  } catch {
    return 0;
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
