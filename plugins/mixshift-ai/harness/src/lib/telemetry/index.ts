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
import { EventName, type TrackInput, type TelemetryEventRecord } from './events.js';
import { loadProfile } from '../profile/load.js';
import { loadCredentials } from '../auth/credentials.js';
import { getPluginVersion } from '../plugin-version.js';
import { detectSurface } from './surface.js';

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

    const { installId, wasJustCreated } = await getOrCreateInstallId(dataDirOverride);
    const { profile } = await loadProfile(dataDirOverride);
    const pluginVersion = getPluginVersion();
    const installPath = detectInstallPath();
    const surface = detectSurface(readSurfaceFlag());
    const os = detectOs();
    const nowIso = new Date().toISOString();
    const userEmail = profile.user?.email;
    // Auto-resolve person_label from datahub creds when caller didn't pass
    // one. Best-effort — pre-auth events / corrupted creds files fall
    // through silently. Keeps the per-employee actor visible on
    // QueryExecuted / QueryFailed without every caller threading it through.
    const datahubPersonLabel = await readDatahubPersonLabelBestEffort(
      dataDirOverride,
    );

    // If this is the first time install_id has been created on this
    // machine, enqueue a synthetic plugin.installed event ALONGSIDE the
    // triggering event. This decouples plugin.installed firing from
    // "which command runs first" — previously, a SKILL.md emit like
    // `mixshift telemetry emit skill.invoked` would create the install_id
    // as a side effect and suppress plugin.installed for the subsequent
    // `mixshift welcome` run. Now plugin.installed fires whenever
    // install_id is genuinely new, regardless of trigger.
    //
    // Guarded so direct `track(PluginInstalled)` callers (none today, but
    // future-proofing) don't double-fire.
    if (wasJustCreated && input.event_name !== EventName.PluginInstalled) {
      const synthetic: TelemetryEventRecord = {
        event_name: EventName.PluginInstalled,
        install_id: installId,
        email: userEmail,
        person_label: datahubPersonLabel,
        plugin_version: pluginVersion,
        install_path: installPath,
        surface,
        os,
        node_version: process.version,
        ts: nowIso,
        // Marker so analytics can distinguish "synthetic on first-track"
        // from a hypothetical future direct track(PluginInstalled) call.
        payload: { synthetic: true, triggered_by: input.event_name },
      };
      await enqueueEvent(synthetic, dataDirOverride);
    }

    const record: TelemetryEventRecord = {
      event_name: input.event_name,
      install_id: installId,
      email: input.email ?? userEmail,
      person_label: input.person_label ?? datahubPersonLabel,
      plugin_version: pluginVersion,
      install_path: installPath,
      surface,
      os,
      node_version: process.version,
      ts: nowIso,
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

/**
 * Read the `--surface` CLI flag from argv if present. Returns undefined when
 * not set so `detectSurface` falls through to env-based detection. We parse
 * argv directly rather than threading the Commander option through every
 * telemetry call site — simpler and the flag's exact position varies (could
 * be at root or after a subcommand).
 */
function readSurfaceFlag(): string | undefined {
  const idx = process.argv.indexOf('--surface');
  if (idx >= 0 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  // Also support --surface=<value> form
  const eq = process.argv.find((a) => a.startsWith('--surface='));
  if (eq) return eq.slice('--surface='.length);
  return undefined;
}

/**
 * Best-effort lookup of the datahub `person_label` (per-employee actor)
 * from the credentials file. Returns undefined when:
 *   - no credentials file yet
 *   - credentials file is malformed
 *   - no datahub block present (pre-auth or legacy mysql-only install)
 *
 * Never throws. Wraps the file I/O so a missing or broken credentials
 * file can't take down telemetry.
 */
async function readDatahubPersonLabelBestEffort(
  dataDirOverride?: string,
): Promise<string | undefined> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    return credentials?.datahub?.person_label;
  } catch {
    return undefined;
  }
}

// Re-exports
export { isTelemetryEnabled, getTelemetryStatus, markConsentAcknowledged, setOptedOut, hasAcknowledgedConsent } from './consent.js';
export { getOrCreateInstallId, readInstallId } from './identity.js';
export { EventName } from './events.js';
export type { TrackInput, TelemetryEventRecord, Outcome, EventNameValue } from './events.js';
export type { FlushResult } from './client.js';
