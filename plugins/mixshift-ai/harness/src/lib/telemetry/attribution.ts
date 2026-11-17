/**
 * Structured actor attribution for telemetry events.
 *
 * Every event answers WHO the actor is: a uniform `actor` object is
 * stamped into payload on every event:
 *
 *   { kind: 'human' | 'service' | 'anonymous', ...identity }
 *
 * Human actors are already identifiable via the lifted `email` (tenant
 * login) + `person_label` (the person's work email) columns; we still stamp
 * `kind:'human'` (+ user_id, the TENANT id) for uniform filtering, plus
 * `identity` / `verified`, which say how the person was identified: verified
 * by Google or Microsoft member sign-in, or self-attested under the shared
 * login (see ActorIdentity). Service-credential events
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
 * How the actor was identified.
 *  - 'member_sign_in': the access token carries `idv: 'member'`. The gateway
 *    issued it after the person signed in with Google or Microsoft as a listed
 *    member of their organization, and person_label is that verified address.
 *  - 'shared_login': a decodable token without `idv`. person_label is the
 *    work email the person typed at sign-in on the shared team login
 *    (self-attested).
 *  - 'stored_label': the token could not be decoded or carries no actor, so
 *    person_label is the copy stored on this machine (self-attested).
 *  - 'service_credential': a machine credential; person_label is its label.
 */
export type ActorIdentity = 'member_sign_in' | 'shared_login' | 'stored_label' | 'service_credential';

/**
 * The identity block stamped onto `payload.actor`. Fields are populated as
 * available; a service credential on a fresh install (pre-P2, or before its
 * first token mint of this version) carries only kind + svc_label +
 * svc_client_id until the mint attribution lands in the cache.
 */
export interface Actor {
  kind: ActorKind;
  /**
   * The TENANT id (token `sub`, the org's login account), human path. Not a
   * person id: everyone on one shared login has the same user_id. email +
   * person_label are lifted columns.
   */
  user_id?: string;
  /** How the actor was identified (human and service paths). */
  identity?: ActorIdentity;
  /**
   * Human path: true only for 'member_sign_in'. This is what the plugin read
   * from its own token; the ingest does not re-check it yet.
   */
  verified?: boolean;
  /** The organization a member signed in to (token `org` claim); member sign-in only. */
  org_id?: string;
  /**
   * Columns the caller of track() set explicitly to a value different from
   * the token-derived one. A person_label override makes `verified` false.
   */
  overridden?: Array<'email' | 'person_label'>;
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
      const identity: ActorIdentity =
        claims.actor === undefined ? 'stored_label' : claims.idv === 'member' ? 'member_sign_in' : 'shared_login';
      return {
        personLabel: claims.actor ?? datahub.person_label,
        tenantEmail: claims.email ?? datahub.email,
        // A human session present => not automation, even if a service block
        // also exists on this data dir (preserves prior semantics).
        automation: false,
        actor: {
          kind: 'human',
          user_id: claims.user_id ?? datahub.user_id,
          identity,
          verified: identity === 'member_sign_in',
          ...(identity === 'member_sign_in' && claims.org ? { org_id: claims.org } : {}),
        },
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
          identity: 'service_credential',
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
