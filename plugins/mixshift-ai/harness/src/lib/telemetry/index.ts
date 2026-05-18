/**
 * Public telemetry API.
 *
 * Two functions matter:
 *
 *   track(input)              Best-effort: enqueue an event. Never throws.
 *                             Returns a promise that resolves once the
 *                             event has been appended to the local queue
 *                             (NOT when it's been sent to Supabase).
 *
 *   maybeFlush()              Async drain of the queue. Called automatically
 *                             at the top of CLI invocations. Best-effort.
 *
 * Plus accessors re-exported from sibling modules:
 *
 *   isTelemetryEnabled()      Final gate — env var + opt-out + configured
 *   getTelemetryStatus()      Human-readable state for `telemetry status`
 *   markConsentAcknowledged() Set the consent-shown timestamp
 *   setOptedOut()             Persist opt-in/out
 *   getOrCreateInstallId()    Generate / read the anonymous install ID
 */

import { platform, release } from 'node:os';
import { isTelemetryEnabled } from './consent.js';
import { getOrCreateInstallId } from './identity.js';
import { enqueueEvent } from './queue.js';
import { flushQueue, type FlushResult } from './client.js';
import type { TrackInput, TelemetryEventRecord } from './events.js';
import { loadProfile } from '../profile/load.js';
import { getPluginVersion } from '../plugin-version.js';

/**
 * Track an event. Best-effort:
 *   - If telemetry is disabled (env / opt-out / not configured), no-op.
 *   - If queue write fails, eat the error silently — never bubble up.
 *
 * Returns once the event is on disk (or skipped). Doesn't wait for network
 * send — that happens via flushQueue() at the start of the next invocation.
 */
export async function track(
  input: TrackInput,
  dataDirOverride?: string,
): Promise<void> {
  try {
    const enabled = await isTelemetryEnabled(dataDirOverride);
    if (!enabled) return;

    const installId = await getOrCreateInstallId(dataDirOverride);
    const { profile } = await loadProfile(dataDirOverride);

    const record: TelemetryEventRecord = {
      event_name: input.event_name,
      install_id: installId,
      email: input.email ?? profile.user?.email,
      plugin_version: getPluginVersion(),
      install_path: detectInstallPath(),
      os: detectOs(),
      node_version: process.version,
      ts: new Date().toISOString(),
      payload: input.payload ?? {},
      skill_id: input.skill_id,
      duration_ms: input.duration_ms,
      outcome: input.outcome,
      query_id: input.query_id,
      query_table: input.query_table,
      row_count: input.row_count,
      error_class: input.error_class,
      trigger_phrase: input.trigger_phrase,
    };

    await enqueueEvent(record, dataDirOverride);
  } catch {
    // Telemetry is never allowed to break user commands.
  }
}

/**
 * Try to drain the queue. Best-effort. Called near the start of each CLI
 * invocation so events from a prior invocation get a fresh chance to send.
 */
export async function maybeFlush(
  dataDirOverride?: string,
): Promise<FlushResult> {
  try {
    const enabled = await isTelemetryEnabled(dataDirOverride);
    if (!enabled) return { status: 'no_endpoint', events_sent: 0 };
    return await flushQueue(dataDirOverride);
  } catch (err) {
    return {
      status: 'failed',
      events_sent: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Detect which install host invoked us. The plugin runtime sets
 * `CLAUDE_PLUGIN_ROOT` for both Claude Code and Cowork. We can't reliably
 * tell those two apart from the harness without more signal, so we surface
 * "plugin-host" generically — surface differentiation can come later via a
 * `--surface` flag the wrapper passes through. CLI-direct invocations
 * (no plugin runtime) report "cli".
 */
function detectInstallPath(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'plugin-host';
  return 'cli';
}

function detectOs(): string {
  return `${platform()}-${release()}`;
}

// Re-exports
export { isTelemetryEnabled, getTelemetryStatus, markConsentAcknowledged, setOptedOut, hasAcknowledgedConsent } from './consent.js';
export { getOrCreateInstallId, readInstallId } from './identity.js';
export { EventName } from './events.js';
export type { TrackInput, TelemetryEventRecord, Outcome, EventNameValue } from './events.js';
export type { FlushResult } from './client.js';
