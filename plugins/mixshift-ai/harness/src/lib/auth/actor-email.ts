/**
 * Resolve the best-known actor email for attributing a deliberate, solicited
 * user action (feedback) WITHOUT ever blocking that action when no email is on
 * file.
 *
 * Resolution order:
 *   1. profile.user.email            — set during onboarding / mirrored from login
 *   2. credentials.datahub.person_label — self-attested per-employee actor email
 *   3. undefined                     — caller proceeds ANONYMOUSLY, does NOT abort
 *
 * Why this exists: `mixshift feedback` used to throw at a hard email gate when
 * profile.user.email was empty (e.g. a service-credential or token session that
 * never mirrored an email into the profile). That silently dropped the user's
 * message — it survived only as a generic `cli.command_run` row. Feedback is a
 * solicited send; losing it is worse than sending it unattributed (the event
 * still groups by install_id, and identity can be backfilled).
 *
 * A successfully loaded datahub block always carries `person_label` (the schema
 * requires it), so that is the credential-store identity. Service (machine)
 * credentials carry no email at all, so unattended runs resolve to undefined
 * here and the caller sends anonymously.
 *
 * Never throws: a missing OR malformed profile/credentials file degrades to the
 * next source (or undefined), so this can sit in front of a must-not-fail path.
 */

import { loadProfile } from '../profile/load.js';
import { loadCredentials } from './credentials.js';

export async function resolveActorEmail(
  dataDirOverride?: string,
): Promise<string | undefined> {
  const profileEmail = await loadProfile(dataDirOverride)
    .then((r) => r.profile.user?.email)
    .catch(() => undefined);
  if (profileEmail) return profileEmail;

  const credentials = await loadCredentials(dataDirOverride)
    .then((r) => r.credentials)
    .catch(() => undefined);
  return credentials?.datahub?.person_label ?? undefined;
}
