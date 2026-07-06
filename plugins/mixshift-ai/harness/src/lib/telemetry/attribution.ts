/**
 * Structured actor attribution for telemetry events.
 *
 * Beta stance (see internal/TELEMETRY-ATTRIBUTION.md + memory
 * feedback_beta_telemetry_aggressive): every event must answer WHO the actor
 * is. We stamp a uniform `actor` object into payload on every event:
 *
 *   { kind: 'human' | 'service' | 'anonymous', ...identity }
 *
 * Human actors are already identifiable via the lifted `email` (shared tenant
 * login) + `person_label` (per-employee work email) columns; we still stamp
 * `kind:'human'` (+ user_id) for uniform filtering. Service credentials had NO
 * owner/org/purpose on their events before this — only `svc:<label>` — which is
 * the gap feedback #10 exists to close. We stamp the svc label + client_id
 * always (P1, from the on-disk creds); the owning tenant + minted-by + purpose
 * are enriched at emit time from the service-token attribution cache once the
 * token mint surfaces them (P2).
 *
 * Everything here is best-effort and never throws — telemetry must never break
 * a user command.
 */

import { loadCredentials } from '../auth/credentials.js';
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
      return {
        personLabel: datahub.person_label,
        // A human session present => not automation, even if a service block
        // also exists on this data dir (preserves prior semantics).
        automation: false,
        actor: { kind: 'human', user_id: datahub.user_id },
      };
    }

    if (service) {
      const enriched = await readServiceAttributionCache(
        service.client_id,
        dataDirOverride,
      );
      return {
        personLabel: service.label ?? service.client_id,
        automation: true,
        actor: {
          kind: 'service',
          svc_label: service.label,
          svc_client_id: service.client_id,
          ...enriched,
        },
      };
    }

    return { personLabel: undefined, automation: false, actor: { kind: 'anonymous' } };
  } catch {
    return { personLabel: undefined, automation: false, actor: { kind: 'anonymous' } };
  }
}
