/**
 * Local, verification-free decode of the identity claims carried by a
 * mx-legacy-auth access token (a JWT).
 *
 * Why this exists: telemetry attribution must reflect WHO the token actually
 * belongs to — the tenant login (`email` claim) and the per-employee actor
 * (`actor` claim, RFC 8693 delegation). Those are minted server-side and are
 * the source of truth. The plugin previously attributed from separately-passed
 * / mirrored LOCAL values (`datahub.person_label`, `profile.user.email`), which
 * can diverge from the token:
 *   - the two-phase device flow passes `--person-label` to init AND poll
 *     independently, so the value saved locally can differ from the `actor`
 *     the service actually stamped into the token (observed: a session whose
 *     token carried the correct individual actor while the local copy held the
 *     shared tenant login);
 *   - `email` was sourced from `profile.user.email`, which login mirrors from
 *     person_label — so the telemetry `email` column carried the actor, not the
 *     tenant, collapsing `email == person_label`.
 * Reading the claims straight off the token removes both seams and
 * self-corrects already-installed sessions on their next event (no re-login),
 * as long as the token itself is non-collapsed (post-2026-07-04 guard).
 *
 * This is a READ of identity claims for attribution only — never an
 * authorization decision — so no signature verification is needed (and the
 * plugin holds no public key). It never throws: any malformed/absent token
 * yields `{}` and callers fall back to the stored fields.
 */

export interface AccessTokenClaims {
  /** JWT `sub` (falls back to a legacy `user_id` claim) — the tenant/datahub id. */
  user_id?: string;
  /** JWT `email` claim — the tenant's shared login email. */
  email?: string;
  /** JWT `actor` claim — the self-attested per-employee actor (person_label). */
  actor?: string;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Decode the identity claims from a JWT access token's payload segment.
 * Base64url-decodes the middle segment and reads `sub`/`user_id`, `email`,
 * and `actor`. Returns `{}` for any missing/malformed input — never throws.
 */
export function decodeAccessTokenClaims(
  token: string | undefined | null,
): AccessTokenClaims {
  try {
    if (!token) return {};
    const parts = token.split('.');
    if (parts.length < 2 || !parts[1]) return {};
    // base64url → base64 (Buffer tolerates missing '=' padding).
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    if (!json) return {};
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return {};
    return {
      user_id: nonEmptyString(obj.sub) ?? nonEmptyString(obj.user_id),
      email: nonEmptyString(obj.email),
      actor: nonEmptyString(obj.actor),
    };
  } catch {
    return {};
  }
}
