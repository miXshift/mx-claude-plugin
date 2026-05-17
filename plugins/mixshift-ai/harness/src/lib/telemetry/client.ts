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
import { readQueue, clearQueue } from './queue.js';
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
 *   - If every batch succeeds, clear the queue.
 *   - If any batch fails, leave the queue intact for the next flush.
 *     (Means we may resend successful batches on retry; Supabase dedup is
 *     downstream by (install_id, event_name, ts) if you care to enforce it.)
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
    } catch (err) {
      // Leave the queue intact for next time.
      return {
        status: 'failed',
        events_sent: sentCount,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  await clearQueue(dataDirOverride);
  return { status: 'sent', events_sent: sentCount };
}

/**
 * POST one batch to Supabase. Throws on non-2xx response or timeout.
 *
 * Supabase PostgREST accepts an array body for bulk insert. The `Prefer:
 * return=minimal` header keeps the response small (we don't need the
 * inserted rows back).
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
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey,
        Authorization: `Bearer ${apikey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(batch),
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
