/**
 * Anonymous install identifier.
 *
 * Generated as a UUID on first telemetry call (or first `mixshift welcome`),
 * persisted to `~/.mixshift/profile.yaml::telemetry.install_id`, and used
 * to group every event from one machine. The install_id is anonymous on its
 * own; it gets linked to the user's email server-side once auth setup
 * completes (via a `user.identified` event).
 *
 * One install_id per `~/.mixshift/` directory — same machine, same OS user,
 * one ID. If a user reinstalls the plugin or wipes their data dir, they get
 * a fresh install_id.
 */

import { randomUUID } from 'node:crypto';
import { loadProfile } from '../profile/load.js';
import { saveProfile } from '../profile/save.js';
import { defaultProfile } from '../profile/schema.js';

/**
 * Returns the install_id for this machine, generating + persisting one if
 * it doesn't exist yet. Safe to call repeatedly — subsequent calls return
 * the same value with `wasJustCreated: false`.
 *
 * The `wasJustCreated` flag is the signal track() uses to enqueue a
 * synthetic `plugin.installed` event alongside the triggering event.
 * This makes `plugin.installed` fire on first-ever harness invocation
 * regardless of which command triggered it — including via SKILL.md
 * emits that pre-create the id before `mixshift welcome` would otherwise
 * have a chance.
 */
export async function getOrCreateInstallId(
  dataDirOverride?: string,
): Promise<{ installId: string; wasJustCreated: boolean }> {
  const { profile, source } = await loadProfile(dataDirOverride);

  // Existing install_id on disk
  if (profile.telemetry?.install_id) {
    return { installId: profile.telemetry.install_id, wasJustCreated: false };
  }

  // Generate + persist
  const newId = randomUUID();
  const next =
    source === 'file'
      ? { ...profile }
      : defaultProfile();

  next.telemetry = {
    ...(next.telemetry ?? { opted_out: false }),
    install_id: newId,
  };

  await saveProfile(next, dataDirOverride);
  return { installId: newId, wasJustCreated: true };
}

/**
 * Read-only accessor — returns the install_id if it exists, undefined
 * otherwise. Use this when you don't want to create one as a side effect.
 */
export async function readInstallId(dataDirOverride?: string): Promise<string | undefined> {
  const { profile } = await loadProfile(dataDirOverride);
  return profile.telemetry?.install_id;
}
