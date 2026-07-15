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
import { readQueue, overwriteQueue } from './queue.js';
import type { TelemetryEventRecord } from './events.js';

const DEFAULT_TIMEOUT_MS = 5_000;

export interface FlushResult {
  status: 'sent' | 'no_endpoint' | 'no_events' | 'failed';
  events_sent: number;
  error?: string;
}

/**
 * Drain the local queue and POST events to Supabase. Returns a status object
 * describing the outcome. Never throws.
 *
 * Flush strategy:
 *   - Read all queued events.
 *   - POST them in batches of `defaults.telemetry.batch_size`.
 *   - After EACH batch is accepted, rewrite the queue with only the events
 *     that haven't been sent yet, so an accepted batch is removed from disk
 *     immediately. A later batch failure then leaves only the un-sent events
 *     behind — the accepted ones are never resent on the next invocation.
 *   - If any batch fails, stop and return 'failed' (callers still learn the
 *     flush was incomplete); the queue already holds exactly the un-sent tail.
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

  const events = await readQueue(dataDirOverride);
  if (events.length === 0) {
    return { status: 'no_events', events_sent: 0 };
  }

  let sentCount = 0;
  for (let i = 0; i < events.length; i += batch_size) {
    const batch = events.slice(i, i + batch_size);
    try {
      await postBatch(endpoint, apikey, batch, timeoutMs);
      sentCount += batch.length;
      // Batch accepted: persist only the not-yet-sent tail. If a later batch
      // fails, the queue already excludes this (and every prior) accepted
      // batch, so we won't resend it. overwriteQueue is best-effort and never
      // throws; if the rewrite itself fails the batch may be resent later
      // (at-least-once), never lost.
      await overwriteQueue(events.slice(i + batch_size), dataDirOverride);
    } catch (err) {
      // Stop here. The queue holds exactly the un-sent tail (this batch plus
      // everything after it), thanks to the per-batch rewrite above.
      return {
        status: 'failed',
        events_sent: sentCount,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // All batches accepted; the final overwriteQueue already emptied the queue.
  return { status: 'sent', events_sent: sentCount };
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
  batch: TelemetryEventRecord[],
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const normalized = batch.map(normalizeRecord);
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
      throw new Error(
        `Supabase responded ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`,
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
 */
export function normalizeRecord(rec: TelemetryEventRecord): Record<string, unknown> {
  return {
    event_name: rec.event_name,
    install_id: rec.install_id,
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
    duration_ms: rec.duration_ms ?? null,
    outcome: rec.outcome ?? null,
    query_id: rec.query_id ?? null,
    query_table: rec.query_table ?? null,
    row_count: rec.row_count ?? null,
    error_class: rec.error_class ?? null,
    trigger_phrase: rec.trigger_phrase ?? null,
  };
}
