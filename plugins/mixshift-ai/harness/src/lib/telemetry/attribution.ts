/**
 * Structured actor attribution for telemetry events.
 *
 * Every event answers WHO the actor is: a uniform `actor` object is
 * stamped into payload on every event:
 *
 *   { kind: 'human' | 'service' | 'anonymous', ...identity }
 *
 * Human actors are already identifiable via the lifted `email` (tenant
 * login) + `person_label` (self-attested work email) columns; we still stamp
 * `kind:'human'` (+ user_id) for uniform filtering. Service-credential events
 * previously carried only `svc:<label>`. We stamp the svc label + client_id
 * always (P1, from the on-disk creds); the owning tenant + minted-by + purpose
 * are enriched at emit time from the service-token attribution cache once the
 * token mint surfaces them (P2).
 *
 * Everything here is best-effort and never throws — telemetry must never break
 * a user command.
 */

import { loadCredentials } from '../auth/credentials.js';
import { decodeAccessTokenClaims } from '../auth/token-claims.js';
import { readServiceAttributionCache } from './service-attribution-cache.js';

export type ActorKind = 'human' | 'service' | 'anonymous';

/**
 * The identity block stamped onto `payload.actor`. Fields are populated as
 * available; a service credential on a fresh install (pre-P2, or before its
 * first token mint of this version) carries only kind + svc_label +
 * svc_client_id until the mint attribution lands in the cache.
 */
export interface Actor {
  kind: ActorKind;
  /** datahub user_id (human path). email + person_label are lifted columns. */
  user_id?: string;
  /** service credential label, e.g. 'ppc_placement_mod_key'. */
  svc_label?: string;
  /** service credential client id, svc_... */
  svc_client_id?: string;
  /** owning-tenant user id from the registry (P2, via mint response). */
  owner_user_id?: string;
  /** who minted the credential at /admin, from registry created_by (P2). */
  minted_by?: string;
  /** human-readable purpose/label from the registry (P2). */
  purpose?: string;
  /** granted scopes on the service credential (P2). */
  scopes?: string[];
  /** egress IP observed at the last token mint (service path, P2). */
  client_ip?: string;
}

export interface Attribution {
  /** Backward-compatible person_label: human work email, else svc label/id. */
  personLabel: string | undefined;
  /**
   * The TENANT's shared login email (the `email` telemetry column). Distinct
   * from personLabel (the actor). Sourced from the access-token `email` claim
   * so the event carries the org login, not the per-employee actor. Undefined
   * for service credentials (their tokens carry no tenant email) and anonymous.
   */
  tenantEmail: string | undefined;
  /** True when a service credential is configured and no human session wins. */
  automation: boolean;
  /** Structured actor stamped onto payload.actor for every event. */
  actor: Actor;
}

/**
 * Resolve attribution from on-disk credentials (+ the service attribution
 * cache for service enrichment). A datahub (human) session always wins over a
 * co-present service block: a human session is the more specific intent (same
 * rule as getValidAccessToken).
 */
export async function resolveAttribution(
  dataDirOverride?: string,
): Promise<Attribution> {
  try {
    const { credentials } = await loadCredentials(dataDirOverride);
    const datahub = credentials?.datahub;
    const service = credentials?.service;

    if (datahub) {
      // The access token is the source of truth for WHO acted. Prefer its
      // claims over the locally-stored copies, which can diverge from the
      // token (see token-claims.ts): `actor` is the per-employee actor
      // (person_label), `email` the tenant login, `sub`/`user_id` the tenant
      // id. Fall back to the stored fields when the token is absent/opaque.
      const claims = decodeAccessTokenClaims(datahub.access_token);
      return {
        personLabel: claims.actor ?? datahub.person_label,
        tenantEmail: claims.email ?? datahub.email,
        // A human session present => not automation, even if a service block
        // also exists on this data dir (preserves prior semantics).
        automation: false,
        actor: { kind: 'human', user_id: claims.user_id ?? datahub.user_id },
      };
    }

    if (service) {
      const enriched = await readServiceAttributionCache(
        service.client_id,
        dataDirOverride,
      );
      return {
        personLabel: service.label ?? service.client_id,
        // Service tokens carry no tenant login email (email: '' server-side),
        // and the fan-out renders automation from svc_label/owner, not email.
        tenantEmail: undefined,
        automation: true,
        actor: {
          kind: 'service',
          svc_label: service.label,
          svc_client_id: service.client_id,
          ...enriched,
        },
      };
    }

    return { personLabel: undefined, tenantEmail: undefined, automation: false, actor: { kind: 'anonymous' } };
  } catch {
    return { personLabel: undefined, tenantEmail: undefined, automation: false, actor: { kind: 'anonymous' } };
  }
}
