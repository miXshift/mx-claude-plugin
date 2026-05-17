/**
 * Telemetry consent management.
 *
 * Two pieces of state live in profile.yaml:
 *
 *   telemetry.acknowledged_at    ISO timestamp; set the first time the
 *                                user sees the FYI notice. Absent = notice
 *                                hasn't been shown yet (print it on next CLI run).
 *   telemetry.opted_out          boolean; user ran `mixshift telemetry opt-out`.
 *
 * Plus one runtime override:
 *
 *   MIXSHIFT_TELEMETRY=0         environment variable disables telemetry
 *                                for the duration of one CLI invocation,
 *                                without persisting to profile.
 *
 * `isTelemetryEnabled()` is the single check every telemetry callsite goes
 * through. It returns false if the env var is set, if the profile says
 * opted_out, or if the plugin defaults don't have an endpoint+apikey
 * configured.
 */

import { loadProfile } from '../profile/load.js';
import { saveProfile } from '../profile/save.js';
import { defaultProfile } from '../profile/schema.js';
import { loadPluginDefaults } from '../defaults/load.js';

/**
 * Returns true when telemetry events should be queued + flushed. Returns
 * false when telemetry is disabled by any of:
 *   - MIXSHIFT_TELEMETRY=0 env var
 *   - profile.telemetry.opted_out = true
 *   - plugin defaults missing endpoint or apikey ("configured off")
 */
export async function isTelemetryEnabled(
  dataDirOverride?: string,
): Promise<boolean> {
  // Env var: hardest off. Recognized values: 0, false, off, no, disabled.
  const envVal = process.env.MIXSHIFT_TELEMETRY;
  if (envVal !== undefined) {
    const v = envVal.toLowerCase().trim();
    if (v === '0' || v === 'false' || v === 'off' || v === 'no' || v === 'disabled') {
      return false;
    }
  }

  // Profile: persistent opt-out.
  const { profile } = await loadProfile(dataDirOverride);
  if (profile.telemetry?.opted_out) {
    return false;
  }

  // Defaults: configured off (endpoint or apikey empty).
  const defaults = await loadPluginDefaults();
  if (!defaults.telemetry.endpoint || !defaults.telemetry.apikey) {
    return false;
  }

  return true;
}

/**
 * Returns true when the consent FYI notice has already been shown to the
 * user (and they've therefore "agreed by using the plugin"). False on first
 * run — caller is expected to print the notice and then call
 * markConsentAcknowledged().
 */
export async function hasAcknowledgedConsent(
  dataDirOverride?: string,
): Promise<boolean> {
  const { profile } = await loadProfile(dataDirOverride);
  return !!profile.telemetry?.acknowledged_at;
}

/**
 * Persists "user has seen the consent notice" with the current timestamp.
 * Idempotent — calling repeatedly doesn't reset the timestamp, only sets
 * it the first time.
 */
export async function markConsentAcknowledged(
  dataDirOverride?: string,
): Promise<void> {
  const { profile, source } = await loadProfile(dataDirOverride);
  if (profile.telemetry?.acknowledged_at) return;

  const next = source === 'file' ? { ...profile } : defaultProfile();
  next.telemetry = {
    ...(next.telemetry ?? { opted_out: false }),
    acknowledged_at: new Date().toISOString(),
  };
  await saveProfile(next, dataDirOverride);
}

/**
 * Persist `opted_out = true` (called by `mixshift telemetry opt-out`).
 */
export async function setOptedOut(
  optedOut: boolean,
  dataDirOverride?: string,
): Promise<void> {
  const { profile, source } = await loadProfile(dataDirOverride);
  const next = source === 'file' ? { ...profile } : defaultProfile();
  next.telemetry = {
    ...(next.telemetry ?? { opted_out: false }),
    opted_out: optedOut,
  };
  await saveProfile(next, dataDirOverride);
}

/**
 * Human-readable summary of the current telemetry state — used by
 * `mixshift telemetry status` and the welcome screen.
 */
export interface TelemetryStatus {
  /** Final answer: is telemetry going to fire right now? */
  enabled: boolean;
  /** Why it's enabled / disabled. */
  reason: string;
  /** Install ID if one exists on disk. */
  install_id?: string;
  /** Timestamp of consent acknowledgement (if any). */
  acknowledged_at?: string;
  /** True if the persistent opt-out flag is set. */
  opted_out: boolean;
  /** True if MIXSHIFT_TELEMETRY env var is forcing it off. */
  env_override: boolean;
  /** True if defaults have a usable endpoint + apikey. */
  configured: boolean;
}

export async function getTelemetryStatus(
  dataDirOverride?: string,
): Promise<TelemetryStatus> {
  const envVal = process.env.MIXSHIFT_TELEMETRY?.toLowerCase().trim();
  const envOverride =
    envVal === '0' || envVal === 'false' || envVal === 'off' || envVal === 'no' || envVal === 'disabled';

  const { profile } = await loadProfile(dataDirOverride);
  const defaults = await loadPluginDefaults();
  const configured = !!defaults.telemetry.endpoint && !!defaults.telemetry.apikey;
  const optedOut = !!profile.telemetry?.opted_out;

  let enabled = true;
  let reason = 'enabled';
  if (envOverride) {
    enabled = false;
    reason = 'disabled via MIXSHIFT_TELEMETRY env var';
  } else if (optedOut) {
    enabled = false;
    reason = 'disabled via `mixshift telemetry opt-out`';
  } else if (!configured) {
    enabled = false;
    reason = 'telemetry endpoint not configured in plugin defaults';
  }

  return {
    enabled,
    reason,
    install_id: profile.telemetry?.install_id,
    acknowledged_at: profile.telemetry?.acknowledged_at,
    opted_out: optedOut,
    env_override: envOverride,
    configured,
  };
}
