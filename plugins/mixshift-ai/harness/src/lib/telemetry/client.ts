/**
 * Telemetry HTTP client.
 *
 * Sends batched events to Supabase's PostgREST `/rest/v1/events` endpoint.
 * Uses Node 20+'s built-in `fetch`. Wraps everything in a timeout so a
 * misconfigured endpoint can't hang the CLI.
 *
 * Best-effort: never throws. On failure, events stay queued and the next
 * CLI invocation will retry them.
 */

import { loadPluginDefaults } from '../defaults/load.js';
import { getPluginVersion } from '../plugin-version.js';
import { claimQueue, deadLetterEvents, replayDeadLetter } from './queue.js';
import type { TelemetryEventRecord } from './events.js';

const DEFAULT_TIMEOUT_MS = 5_000;
/** One flush stops starting new batches after this long; the rest wait for the next run. */
const FLUSH_BUDGET_MS = 5_000;

export interface FlushResult {
  status: 'sent' | 'no_endpoint' | 'no_events' | 'failed';
  events_sent: number;
  /** Events the server permanently rejected, kept in deadletter.jsonl. */
  dead_lettered?: number;
  /** Which events were set aside and why (status 0 = could not be serialized). */
  set_aside?: SetAside[];
  /** Refused events kept queued because deadletter.jsonl is full. */
  requeued?: number;
  error?: string;
}

export interface SetAside {
  event_name: string;
  status: number;
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** A non-2xx answer from the telemetry endpoint. */
export class TelemetryHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'TelemetryHttpError';
  }
}

/**
 * Statuses that mean "this payload will never be accepted": malformed or
 * unstorable rows. Retrying them only blocks every event queued behind them.
 * Deliberately NOT here: 401/403/404 (a key or endpoint problem on our side,
 * which a later release or config fix clears), 408/425/429 and 5xx (transient).
 */
const PERMANENT_REJECTION = new Set([400, 409, 413, 422]);

function isPermanentRejection(err: unknown): err is TelemetryHttpError {
  return err instanceof TelemetryHttpError && PERMANENT_REJECTION.has(err.status);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drain the local queue and POST events to Supabase. Returns a status object
 * describing the outcome. Never throws.
 *
 * Flush strategy:
 *   - CLAIM the queue (claimQueue: an atomic rename to a private in-flight
 *     file). Events other processes append meanwhile go to a fresh queue.jsonl,
 *     so nothing they write can be overwritten by this flush.
 *   - POST them in batches of `defaults.telemetry.batch_size`.
 *   - After EACH batch is accepted, checkpoint the in-flight file with only the
 *     events not yet sent, so an accepted batch is never resent even if this
 *     process is killed later in the flush.
 *   - A PERMANENT rejection (400/409/413/422: the row itself cannot be stored)
 *     is isolated row by row. Rows that still fail alone go to deadletter.jsonl
 *     with the reason and the flush continues, so one unstorable row can no
 *     longer block every event behind it forever.
 *   - Any other failure (network, timeout, 5xx, 429, auth/endpoint) stops the
 *     flush and hands the unsent remainder back to queue.jsonl for next time.
 *
 * At-least-once caveat: a batch the server actually committed but whose
 * response we never saw (connection dropped after the DB write) is treated
 * as failed here, so its events stay queued and get resent → a duplicate
 * row. That is an inherent property of at-least-once delivery over an
 * unreliable network and is OUT OF SCOPE for this function; downstream dedup
 * by (install_id, event_name, ts) is the backstop if it matters. What this
 * function DOES guarantee is that a cleanly-accepted batch (2xx seen) is
 * never deterministically resent because a *different* batch failed.
 */
export async function flushQueue(
  dataDirOverride?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FlushResult> {
  const defaults = await loadPluginDefaults();
  const { endpoint, apikey, batch_size } = defaults.telemetry;

  if (!endpoint || !apikey) {
    return { status: 'no_endpoint', events_sent: 0 };
  }

  // A release often fixes whatever made the server refuse a row, so once per
  // plugin version the set-aside rows go back into the queue for another try.
  await replayDeadLetter(getPluginVersion(), dataDirOverride).catch(() => 0);

  const claim = await claimQueue(dataDirOverride);
  if (claim === 'busy') {
    return { status: 'failed', events_sent: 0, error: 'telemetry queue is busy (could not claim it); left in place for the next run' };
  }
  if (claim === null) {
    return { status: 'no_events', events_sent: 0 };
  }

  // Rows kept queued because the dead-letter file could not take them (full, or
  // unwritable). They go back to the END of queue.jsonl, behind newer events.
  const requeue: TelemetryEventRecord[] = [];
  const setAside: SetAside[] = [];
  let sentCount = 0;

  const putAside = async (rec: TelemetryEventRecord, status: number, error: string): Promise<void> => {
    let kept = false;
    try {
      kept = await deadLetterEvents([rec], { status, error }, dataDirOverride);
    } catch {
      kept = false;
    }
    if (kept) setAside.push({ event_name: cap(String(rec.event_name ?? '?'), 128), status });
    else requeue.push(rec);
  };

  const summary = (): Partial<FlushResult> => ({
    ...(setAside.length ? { dead_lettered: setAside.length, set_aside: setAside } : {}),
    ...(requeue.length ? { requeued: requeue.length } : {}),
  });

  const fail = async (unsent: TelemetryEventRecord[], err: unknown): Promise<FlushResult> => {
    await claim.release([...unsent, ...requeue]);
    return { status: 'failed', events_sent: sentCount, ...summary(), error: errText(err) };
  };

  // Prepare every row before any POST. A row that cannot even be serialized
  // would otherwise throw inside the POST, read as a transient failure, and sit
  // at the head of the queue forever.
  const events: Array<{ rec: TelemetryEventRecord; wire: Record<string, unknown> }> = [];
  for (const rec of claim.events) {
    try {
      const wire = normalizeRecord(rec);
      JSON.stringify(wire);
      events.push({ rec, wire });
    } catch (err) {
      await putAside(rec, 0, `could not serialize: ${errText(err)}`);
    }
  }
  const recs = (from: number) => events.slice(from).map((e) => e.rec);

  // Bounds on one flush, which runs at the end of every command: a time budget,
  // and a circuit breaker for when EVERY row is refused (a request-shape change
  // on the server, say), where isolating row by row would only burn time.
  const startedAt = Date.now();
  let allRefusedStreak = 0;

  for (let i = 0; i < events.length; i += batch_size) {
    if (i > 0 && Date.now() - startedAt > FLUSH_BUDGET_MS) {
      await claim.release([...recs(i), ...requeue]);
      return {
        status: 'sent',
        events_sent: sentCount,
        ...summary(),
        error: `time budget reached; ${events.length - i} event(s) stay queued for the next run`,
      };
    }
    if (allRefusedStreak >= 2) {
      return fail(recs(i), new Error('the server refused every event in two batches in a row; treating it as systemic and keeping the rest queued'));
    }
    const refusedBefore = setAside.length + requeue.length;
    const batch = events.slice(i, i + batch_size);
    try {
      await postBatch(endpoint, apikey, batch.map((e) => e.wire), timeoutMs);
      sentCount += batch.length;
      allRefusedStreak = 0;
    } catch (err) {
      if (!isPermanentRejection(err)) return fail(recs(i), err);
      // One unstorable row rejects the whole batch, so find it: resend each row
      // alone. Rows that are fine go through; rows refused on their own are kept
      // in deadletter.jsonl.
      for (let j = 0; j < batch.length; j++) {
        const one = batch[j]!;
        if (j > 0 && Date.now() - startedAt > FLUSH_BUDGET_MS) {
          await claim.release([...batch.slice(j).map((e) => e.rec), ...recs(i + batch_size), ...requeue]);
          return {
            status: 'sent',
            events_sent: sentCount,
            ...summary(),
            error: `time budget reached; ${batch.length - j + Math.max(0, events.length - i - batch_size)} event(s) stay queued for the next run`,
          };
        }
        try {
          if (batch.length === 1) throw err;
          await postBatch(endpoint, apikey, [one.wire], timeoutMs);
          sentCount++;
        } catch (rowErr) {
          if (!isPermanentRejection(rowErr)) {
            return fail([...batch.slice(j).map((e) => e.rec), ...recs(i + batch_size)], rowErr);
          }
          await putAside(one.rec, rowErr.status, rowErr.message);
        }
      }
      const refusedHere = setAside.length + requeue.length - refusedBefore;
      allRefusedStreak = refusedHere === batch.length ? allRefusedStreak + 1 : 0;
    }
    await claim.checkpoint([...recs(i + batch_size), ...requeue]);
  }

  await claim.release(requeue);
  const note = [
    setAside.length ? `${setAside.length} event(s) the server refused were set aside in deadletter.jsonl (retried after the next plugin update)` : '',
    requeue.length ? `${requeue.length} refused event(s) stay queued because deadletter.jsonl is full` : '',
  ].filter(Boolean).join('; ');
  return { status: 'sent', events_sent: sentCount, ...summary(), ...(note ? { error: note } : {}) };
}

/**
 * POST one batch to Supabase. Throws on non-2xx response or timeout.
 *
 * Supabase PostgREST accepts an array body for bulk insert. Two `Prefer`
 * directives matter:
 *   - `return=minimal` — keeps the response small (no inserted rows back).
 *   - `missing=default` — tells PostgREST to fill in missing columns with
 *      their default (NULL where the column is nullable). Without this,
 *      heterogeneous batches 400 with PGRST102 "All object keys must match"
 *      because JSON.stringify drops `undefined` values — so an event with
 *      a skill_id and one without serialize with different key sets, even
 *      though both are valid rows in the events table.
 *
 * Belt-and-suspenders, we also normalize each record below so missing
 * optional fields become explicit `null`s. Either alone would work; both
 * gives us defense if a future PostgREST version interprets `Prefer` more
 * strictly.
 */
async function postBatch(
  endpoint: string,
  apikey: string,
  normalized: Record<string, unknown>[],
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${apikey}`,
        Prefer: 'return=minimal, missing=default',
      },
      body: JSON.stringify(normalized),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<unreadable>');
      throw new TelemetryHttpError(
        `Supabase responded ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`,
        resp.status,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize a record so every event in a batch has the same key set.
 * Missing optional lifted fields become `null` (which PostgREST inserts as
 * SQL NULL via the table's nullable columns). Without this, `JSON.stringify`
 * silently drops `undefined` values and PostgREST's PGRST102 trips on
 * mismatched key sets across rows.
 *
 * We list every optional key explicitly rather than coercing in a loop so
 * adding a new lifted field to `TelemetryEventRecord` is an obvious diff
 * here too — keeps the contract surface visible.
 *
 * 2026-09-28: the result is also made STORABLE. Postgres rejects a whole
 * batch for one NUL character or unpaired UTF-16 surrogate anywhere in a text
 * or jsonb value (both reach payload from error messages and argv), and for a
 * fractional or out-of-range number in an integer column. A rejected batch used
 * to be retried forever at the head of the queue, so those values are repaired
 * here: NUL removed, lone surrogates replaced with U+FFFD, integer columns
 * rounded (or nulled when not a finite int4).
 */
export function normalizeRecord(rec: TelemetryEventRecord): Record<string, unknown> {
  const row = storable({
    event_name: capText(rec.event_name, 128),
    install_id: capText(rec.install_id, 64),
    email: rec.email ?? null,
    // Null on pre-auth events and on queue entries written by harnesses
    // that didn't yet send the field.
    person_label: rec.person_label ?? null,
    plugin_version: rec.plugin_version,
    install_path: rec.install_path,
    // Surface added in 0.5.1 — older queue.jsonl entries that pre-date the
    // field land here with `surface: undefined` and get coerced to null.
    // Once the queue drains, every new event carries the surface.
    surface: rec.surface ?? null,
    os: rec.os,
    node_version: rec.node_version,
    // user_agent column has always existed; populated since the beta-richness
    // pass (feedback #10). Older queued entries coerce to null.
    user_agent: rec.user_agent ?? null,
    ts: rec.ts,
    payload: rec.payload ?? {},
    skill_id: rec.skill_id ?? null,
    duration_ms: toInt4(rec.duration_ms),
    outcome: rec.outcome ?? null,
    query_id: rec.query_id ?? null,
    query_table: rec.query_table ?? null,
    row_count: toInt4(rec.row_count),
    error_class: rec.error_class ?? null,
    trigger_phrase: rec.trigger_phrase ?? null,
  }) as Record<string, unknown>;
  // The ingest endpoint refuses a request over 256 KB, so a single huge event
  // could never be delivered. Keep the row, drop the oversized payload body, and
  // say so in the payload itself.
  const bytes = Buffer.byteLength(JSON.stringify(row), 'utf-8');
  if (bytes > MAX_ROW_BYTES) {
    const p = row.payload;
    row.payload = {
      payload_truncated: true,
      original_row_bytes: bytes,
      keys: p && typeof p === 'object' ? Object.keys(p as object).slice(0, 50).map((k) => k.slice(0, 100)) : [],
    };
    // Every other column is short by nature; if the row is somehow still too
    // big, trim them too rather than send a row that can never be accepted.
    if (Buffer.byteLength(JSON.stringify(row), 'utf-8') > MAX_ROW_BYTES) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'string' && v.length > 1024) row[k] = v.slice(0, 1024);
      }
    }
  }
  return row;
}

/** Stay well under the ingest endpoint's 256 KB request cap. */
const MAX_ROW_BYTES = 200_000;
/** One string field never needs more than this; longer values are cut. */
const MAX_STRING_CHARS = 32_768;

function capText(v: unknown, max: number): unknown {
  return typeof v === 'string' && v.length > max ? v.slice(0, max) : v;
}

const INT4_MAX = 2_147_483_647;

/** An integer column value Postgres will accept, or null. */
export function toInt4(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r > INT4_MAX || r < -INT4_MAX - 1 ? null : r;
}

// NUL, plus a high surrogate not followed by a low one, or a low surrogate not
// preceded by a high one.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

function storableString(s: string): string {
  if (s.length > MAX_STRING_CHARS) s = s.slice(0, MAX_STRING_CHARS) + '...[truncated]';
  return s.replace(UNSTORABLE, (m) => (m === '\u0000' ? '' : REPLACEMENT_CHAR));
}

/** Deep copy with every string (keys included) made storable in Postgres text/jsonb. */
export function storable(v: unknown): unknown {
  if (typeof v === 'string') return storableString(v);
  if (Array.isArray(v)) return v.map(storable);
  if (v && typeof v === 'object') {
    // Keep what JSON.stringify would have sent (a Date becomes its ISO string).
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return storable(toJSON.call(v));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[storableString(k)] = storable(val);
    return out;
  }
  return v;
}
