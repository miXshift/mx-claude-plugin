/**
 * Disk-backed append-only telemetry queue.
 *
 * Every `track()` call writes one JSON line to
 * `~/.mixshift/telemetry/queue.jsonl`. The flusher claims the queue (see
 * claimQueue below), POSTs it in batches, and hands back whatever it could not
 * send.
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
 * Draining (2026-09-28): the flusher CLAIMS the queue with claimQueue(), which
 * atomically renames queue.jsonl to a private in-flight file. Appends from
 * other processes then land in a fresh queue.jsonl, so a concurrent `mixshift`
 * run can no longer have its events clobbered by the flusher's rewrite, and
 * two flushers can no longer pull the same lines. Agents routinely run several
 * mixshift commands in parallel, so both races were live, not theoretical.
 * The older readQueue/overwriteQueue/clearQueue helpers remain for callers
 * and tests that operate on queue.jsonl directly.
 */

import { appendFile, readFile, writeFile, rename, unlink, mkdir, stat, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { telemetryQueuePath } from '../paths/resolve.js';
import { getPluginVersion } from '../plugin-version.js';
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
 * Empty the queue. NOT used by the flusher since 2026-09-28 (it drains through
 * claimQueue, which has no clobber race); kept for direct callers and tests.
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
 * was there. NOT used by the flusher since 2026-09-28 (see claimQueue); kept
 * for direct callers and tests, with the limitation described below.
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

// ---------------------------------------------------------------------------
// Claim-based draining
// ---------------------------------------------------------------------------

const INFLIGHT_PREFIX = 'queue.inflight.';
/** An in-flight file whose claim is older than this belongs to a flusher that died.
 * A live flusher rewrites its file after every batch (each POST times out in
 * seconds; the worst gap, a batch plus row-by-row isolation, is about a minute),
 * so a healthy claim is never this old. Age is measured from the LATER of the
 * file's mtime and the claim time embedded in its name: rename() keeps the old
 * mtime, so an idle queue.jsonl claimed a moment ago would otherwise look ancient. */
const ORPHAN_AGE_MS = 10 * 60 * 1000;
const DEADLETTER_FILENAME = 'deadletter.jsonl';
const DEADLETTER_VERSION_FILENAME = 'deadletter.version';
const DEADLETTER_MAX_BYTES = 5 * 1024 * 1024;

export interface QueueClaim {
  /** Every event this flush owns, oldest first. */
  events: TelemetryEventRecord[];
  /** Persist the not-yet-sent remainder after an accepted batch, so a hard kill
   * later in the flush never resends an accepted batch. Best-effort. */
  checkpoint(unsent: TelemetryEventRecord[]): Promise<void>;
  /** End the claim: hand `unsent` back to queue.jsonl (appended, so concurrent
   * writers are safe) and remove the in-flight file. Best-effort; if the hand-back
   * fails the in-flight file keeps exactly `unsent` and is adopted later. */
  release(unsent: TelemetryEventRecord[]): Promise<void>;
}

/**
 * Take ownership of everything queued: the live queue.jsonl plus any in-flight
 * file orphaned by a flusher that was killed mid-drain.
 *
 * Returns null when there is nothing to send, and 'busy' when a claimed file
 * could not be moved or read (a Windows sharing lock, say). 'busy' leaves every
 * file in place for a later flush, so it can delay events but never drop them.
 * The rule throughout: a file is only ever deleted or overwritten after its
 * current contents have been read and accounted for.
 *
 * Late appends: a writer that opened queue.jsonl before the rename still writes
 * into the claimed file. The claimed file is read in full only after orphan
 * adoption, and before EVERY later overwrite or delete its length is checked
 * again; any bytes beyond what this flush last read or wrote are handed back to
 * queue.jsonl first. What remains is a writer that opened the file before the
 * rename and stalled for longer than a full POST round trip before writing.
 */
export async function claimQueue(
  dataDirOverride?: string,
): Promise<QueueClaim | null | 'busy'> {
  const queuePath = telemetryQueuePath(dataDirOverride);
  const dir = dirname(queuePath);
  const mine = join(dir, `${INFLIGHT_PREFIX}${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.jsonl`);

  await removeStaleTemps(dir);

  const took = await renameWithRetry(queuePath, mine);
  if (took === 'error') return 'busy';

  // Adopt orphans: rename each to a name of our own first, so two flushers can
  // never both adopt the same file (the loser's rename hits ENOENT). The new name
  // carries our fresh claim time, so no third flusher treats it as an orphan.
  const adopted: Array<{ path: string; raw: string }> = [];
  for (const orphan of await findOrphans(dir, mine)) {
    const into = `${mine}.adopted.${randomBytes(4).toString('hex')}`;
    if ((await renameWithRetry(orphan, into)) !== 'ok') continue;
    const raw = await readTextOr(into, null);
    // Unreadable: leave it under its new name; it ages out and is adopted later.
    if (raw !== null) adopted.push({ path: into, raw });
  }

  // Read the claimed live queue only now, after the orphan IO. A write that was
  // in flight at the rename shows up as a last line with no newline, so give it
  // a moment to finish before reading for real (readSettled).
  let liveBuf: Buffer = Buffer.alloc(0);
  if (took === 'ok') {
    const b = await readSettled(mine);
    if (b === null) return 'busy'; // never delete what we could not read
    liveBuf = b;
  }
  let known = liveBuf.length;

  const { events, malformed } = parseJsonl(adopted.reduce((acc, a) => joinJsonl(acc, a.raw), liveBuf.toString('utf-8')));

  /** Append bytes to queue.jsonl on a line of their own: a leading newline so
   * they can never glue onto a torn last line there, and a trailing one. */
  const handBack = async (bytes: Buffer): Promise<boolean> => {
    try {
      await mkdir(dir, { recursive: true });
      const tail = bytes.length && bytes[bytes.length - 1] === 0x0a ? Buffer.alloc(0) : NEWLINE;
      await appendFile(queuePath, Buffer.concat([NEWLINE, bytes, tail]));
      return true;
    } catch {
      return false;
    }
  };

  // Unparseable lines are set aside verbatim; if that is not possible they go back
  // into the queue as they were, never dropped.
  if (malformed.length && !(await deadLetterLines(malformed, dataDirOverride))) {
    if (!(await handBack(Buffer.from(malformed.join('\n') + '\n', 'utf-8')))) return 'busy';
  }

  /** Hand any bytes appended to `mine` since we last read or wrote it back to
   * queue.jsonl. False when that could not be confirmed: the caller must then not
   * overwrite or delete `mine`. */
  const rescueLate = async (): Promise<boolean> => {
    const buf = await readSettled(mine);
    if (buf === null) return took !== 'ok' && known === 0; // nothing of ours ever existed there
    if (buf.length <= known) return true;
    if (!(await handBack(buf.subarray(known)))) return false;
    known = buf.length;
    return true;
  };

  if (events.length === 0) {
    if (took === 'ok' && !(await rescueLate())) return 'busy';
    if (took === 'ok') await unlinkWithRetry(mine);
    for (const a of adopted) await unlinkWithRetry(a.path);
    return null;
  }

  // Make `mine` hold exactly `events` before removing adopted files, so a kill
  // here duplicates at worst and never loses.
  if (adopted.length || malformed.length || took !== 'ok') {
    if (took === 'ok' && !(await rescueLate())) return 'busy';
    const body = toJsonl(events);
    if (!(await atomicWriteOk(mine, body))) return 'busy';
    known = Buffer.byteLength(body, 'utf-8');
  }
  for (const a of adopted) await unlinkWithRetry(a.path);

  return {
    events,
    async checkpoint(unsent) {
      if (!(await rescueLate())) return; // skipping only risks a resend, never loss
      const body = toJsonl(unsent);
      if (await atomicWriteOk(mine, body)) known = Buffer.byteLength(body, 'utf-8');
    },
    async release(unsent) {
      const rescued = await rescueLate();
      if (unsent.length > 0 && !(await handBack(Buffer.from(toJsonl(unsent), 'utf-8')))) {
        // Keep exactly the unsent events in our in-flight file (only when no late
        // bytes are unaccounted for); a later flush adopts it once it ages out.
        if (rescued) await atomicWrite(mine, toJsonl(unsent));
        return;
      }
      // Could not confirm there are no late bytes: keep the file. Adoption later
      // may resend events already accepted (a duplicate), but loses nothing.
      if (rescued) await unlinkWithRetry(mine);
    },
  };
}

/**
 * Keep events the server PERMANENTLY rejected (a 4xx that retrying cannot fix)
 * in `deadletter.jsonl` next to the queue, instead of retrying them forever at
 * the head of the queue, where one bad row would block every event behind it.
 * Nothing is dropped: each line carries the record plus why it was refused, and
 * replayDeadLetter() sends them again after the plugin is updated.
 *
 * Returns false (nothing written) when the file is over its size cap or the
 * write fails; the caller must then keep the records queued.
 */
export async function deadLetterEvents(
  records: TelemetryEventRecord[],
  reason: { status: number; error: string },
  dataDirOverride?: string,
): Promise<boolean> {
  const at = new Date().toISOString();
  return appendDeadLetter(
    records.map((record) => JSON.stringify({ dead_lettered_at: at, status: reason.status, error: reason.error.slice(0, 300), record })),
    dataDirOverride,
  );
}

/** Unparseable queue lines (a torn write, say) are kept verbatim, never dropped. */
async function deadLetterLines(lines: string[], dataDirOverride?: string): Promise<boolean> {
  const at = new Date().toISOString();
  return appendDeadLetter(
    lines.map((raw_line) => JSON.stringify({ dead_lettered_at: at, status: 0, error: 'unparseable queue line', raw_line })),
    dataDirOverride,
  );
}

async function appendDeadLetter(lines: string[], dataDirOverride?: string): Promise<boolean> {
  if (lines.length === 0) return true;
  const path = deadLetterPath(dataDirOverride);
  try {
    const size = await stat(path).then((s) => s.size).catch(() => 0);
    if (size >= DEADLETTER_MAX_BYTES) return false;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, lines.join('\n') + '\n', { encoding: 'utf-8' });
    // Record which version refused these, so they are replayed only after an
    // update, never on every run of the version that just refused them.
    const markerPath = join(dirname(path), DEADLETTER_VERSION_FILENAME);
    if ((await readTextOr(markerPath, '')).trim() === '') await atomicWrite(markerPath, getPluginVersion());
    return true;
  } catch {
    return false;
  }
}

export function deadLetterPath(dataDirOverride?: string): string {
  return join(dirname(telemetryQueuePath(dataDirOverride)), DEADLETTER_FILENAME);
}

/** How many entries are set aside in deadletter.jsonl (0 if none). */
export async function deadLetterCount(dataDirOverride?: string): Promise<number> {
  const raw = await readTextOr(deadLetterPath(dataDirOverride), '');
  return raw.split('\n').filter((l) => l.trim()).length;
}

/**
 * After a plugin UPDATE, move set-aside events back into the queue so they are
 * tried again: a release often fixes whatever made the server refuse them. Rows
 * refused again return to deadletter.jsonl and wait for the next update.
 * Unparseable lines have nothing to resend and stay where they are.
 *
 * Only a NEWER version replays (semver-greater than the version that set the
 * rows aside), so two plugin versions installed side by side cannot take turns
 * replaying everything on every run. The file is claimed by rename first, so two
 * processes never replay the same entries; if anything fails part-way the
 * claimed rows are APPENDED back (never renamed over a file another process may
 * have started meanwhile), and a claim left by a killed process is recovered.
 */
export async function replayDeadLetter(currentVersion: string, dataDirOverride?: string): Promise<number> {
  const path = deadLetterPath(dataDirOverride);
  const dir = dirname(path);
  const markerPath = join(dir, DEADLETTER_VERSION_FILENAME);

  await recoverStaleReplayClaims(dir, path);

  const marker = (await readTextOr(markerPath, '')).trim();
  if (!marker || !isNewerVersion(currentVersion, marker)) return 0;

  const claimed = `${path}.replaying.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
  const took = await renameWithRetry(path, claimed);
  if (took === 'missing') {
    await atomicWrite(markerPath, currentVersion);
    return 0;
  }
  if (took !== 'ok') return 0;
  const raw = await readTextOr(claimed, null);
  if (raw === null) return 0; // left under the claim name; recovered once it ages out

  const replay: TelemetryEventRecord[] = [];
  const keep: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { record?: TelemetryEventRecord };
      if (entry.record && typeof entry.record === 'object') replay.push(entry.record);
      else keep.push(line);
    } catch {
      keep.push(line);
    }
  }

  // Marker first: rows refused again during this version must not be replayed
  // again until the NEXT update.
  await atomicWrite(markerPath, currentVersion);
  try {
    if (replay.length) {
      await mkdir(dir, { recursive: true });
      await appendFile(telemetryQueuePath(dataDirOverride), '\n' + toJsonl(replay), { encoding: 'utf-8' });
    }
  } catch {
    await appendClaimBack(claimed, path, raw);
    return 0;
  }
  if (keep.length) await appendClaimBack(claimed, path, keep.join('\n') + '\n');
  else await unlinkWithRetry(claimed);
  return replay.length;
}

/** Put a claimed dead-letter body back by APPENDING it to deadletter.jsonl, then
 * drop the claim. If the append fails the claim file stays, to be recovered. */
async function appendClaimBack(claimed: string, path: string, body: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, body.endsWith('\n') ? body : body + '\n', { encoding: 'utf-8' });
    await unlinkWithRetry(claimed);
  } catch {
    // keep the claim file; recoverStaleReplayClaims() retries later
  }
}

async function recoverStaleReplayClaims(dir: string, path: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const prefix = `${DEADLETTER_FILENAME}.replaying.`;
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dir, name);
    try {
      if ((await stat(full)).mtimeMs >= cutoff) continue;
      const body = await readTextOr(full, null);
      if (body !== null && body.trim()) await appendClaimBack(full, path, body);
      else if (body !== null) await unlinkWithRetry(full);
    } catch {
      // gone
    }
  }
}

/** a > b for dotted numeric versions ("0.8.16" > "0.8.15"); pre-release tags are
 * compared as plain text after the numbers. Unparseable -> false. */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().split('-', 2);
    const nums = core.split('.').map((x) => Number(x));
    return nums.some((n) => !Number.isFinite(n)) ? null : { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (pa.pre === pb.pre) return false;
  if (!pa.pre) return true; // a release beats its own pre-release
  if (!pb.pre) return false;
  return pa.pre > pb.pre;
}

const NEWLINE = Buffer.from('\n', 'utf-8');

/** Read a file; if its last line has no newline (a write still in progress),
 * wait briefly for it to finish. Returns null when the file cannot be read. */
async function readSettled(path: string): Promise<Buffer | null> {
  let buf = await readBufferOr(path, null);
  for (let i = 0; buf && buf.length > 0 && buf[buf.length - 1] !== 0x0a && i < 4; i++) {
    await new Promise((r) => setTimeout(r, 50));
    buf = await readBufferOr(path, buf);
  }
  return buf;
}

/** Seconds-since-epoch-ms embedded in a claim name, or 0. Names look like
 * queue.inflight.<pid>.<claimMs>.<rand>.jsonl[.adopted.<rand>]. */
function claimTimeOf(name: string): number {
  const ms = Number(name.slice(INFLIGHT_PREFIX.length).split('.')[1]);
  return Number.isFinite(ms) ? ms : 0;
}

async function findOrphans(dir: string, mine: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(INFLIGHT_PREFIX) || name.includes('.tmp.')) continue;
    const full = join(dir, name);
    if (full === mine || full.startsWith(`${mine}.`)) continue;
    try {
      const age = Math.max((await stat(full)).mtimeMs, claimTimeOf(name));
      if (age < cutoff) out.push(full);
    } catch {
      // gone already
    }
  }
  return out.sort();
}

/** A `.tmp.` file is a copy atomicWrite never renamed into place, so the file it
 * was meant to replace is still intact; an old one is safe to delete. */
async function removeStaleTemps(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  for (const name of names) {
    if (!name.includes('.tmp.')) continue;
    const full = join(dir, name);
    try {
      if ((await stat(full)).mtimeMs < cutoff) await unlinkWithRetry(full);
    } catch {
      // gone
    }
  }
}

const TRANSIENT_FS = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 'ok' renamed; 'missing' the source does not exist; 'error' it exists but
 * would not move (Windows sharing/AV locks are transient, so retry briefly). */
async function renameWithRetry(from: string, to: string): Promise<'ok' | 'missing' | 'error'> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rename(from, to);
      return 'ok';
    } catch (err) {
      if (isFileNotFoundError(err)) return 'missing';
      if (!TRANSIENT_FS.has(String((err as { code?: unknown })?.code))) return 'error';
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
  return 'error';
}

async function unlinkWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (err) {
      if (isFileNotFoundError(err)) return;
      if (!TRANSIENT_FS.has(String((err as { code?: unknown })?.code))) return;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

async function readTextOr<T>(path: string, fallback: T): Promise<string | T> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return fallback;
  }
}

async function readBufferOr<T>(path: string, fallback: T): Promise<Buffer | T> {
  try {
    return await readFile(path);
  } catch {
    return fallback;
  }
}

function joinJsonl(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a.endsWith('\n') ? a + b : `${a}\n${b}`;
}

function parseJsonl(raw: string): { events: TelemetryEventRecord[]; malformed: string[] } {
  const events: TelemetryEventRecord[] = [];
  const malformed: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v as TelemetryEventRecord);
      else malformed.push(line);
    } catch {
      malformed.push(line);
    }
  }
  return { events, malformed };
}

function toJsonl(records: TelemetryEventRecord[]): string {
  return records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
}

async function atomicWriteOk(path: string, body: string): Promise<boolean> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmp, body, { encoding: 'utf-8' });
    await rename(tmp, path);
    return true;
  } catch {
    await unlinkWithRetry(tmp);
    return false;
  }
}

/**
 * Bytes waiting to be sent: queue.jsonl plus any in-flight claim files (a flush
 * in progress, or one orphaned by a killed process).
 */
export async function queueSizeBytes(
  dataDirOverride?: string,
): Promise<number> {
  const queuePath = telemetryQueuePath(dataDirOverride);
  let total = 0;
  try {
    total += (await stat(queuePath)).size;
  } catch {
    // no live queue
  }
  try {
    const dir = dirname(queuePath);
    for (const name of await readdir(dir)) {
      if (!name.startsWith(INFLIGHT_PREFIX) || name.includes('.tmp.')) continue;
      try {
        total += (await stat(join(dir, name))).size;
      } catch {
        // gone
      }
    }
  } catch {
    // no telemetry dir
  }
  return total;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
