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

import { appendFile, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
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
 * Truncate the queue to empty. Called after a successful flush.
 *
 * NOTE: there's an inherent race here — between readQueue() and clearQueue(),
 * new events may have been appended by a different CLI process. To avoid
 * losing those events, callers should pass `keepFromOffset` (the byte size
 * of the queue file when readQueue was called) — anything written past that
 * offset is preserved. We don't currently do this in the simple flush path
 * because concurrent CLI runs are rare; revisit if it becomes a problem.
 */
export async function clearQueue(
  dataDirOverride?: string,
): Promise<void> {
  const path = telemetryQueuePath(dataDirOverride);
  try {
    await writeFile(path, '', { encoding: 'utf-8' });
  } catch {
    // ignore
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
