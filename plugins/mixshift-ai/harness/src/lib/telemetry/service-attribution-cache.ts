/**
 * Reads service-credential attribution (owning tenant, minted-by, purpose,
 * scopes) that the token mint persisted alongside the cached access token.
 *
 * The mint (getServiceAccessToken -> doMintServiceToken in
 * lib/auth/credentials.ts) writes service-token-cache.json. Once the
 * mx-legacy-auth /oauth/token client_credentials response carries an
 * `attribution` block (P2), that block is persisted into the same cache file so
 * telemetry can stamp payload.actor with owner + minted_by + purpose at emit
 * time — even offline on subsequent invocations, and even if the registry row
 * is later deleted.
 *
 * Best-effort: returns {} when the cache is missing, malformed, belongs to a
 * different client_id, or predates the attribution field (P1).
 */

import { readFile } from 'node:fs/promises';
import { serviceTokenCachePath } from '../auth/credentials.js';

export interface ServiceAttribution {
  /** Owning-tenant user id from the registry (mcp_service_credentials.user_id). */
  owner_user_id?: string;
  /** Who minted the credential at /admin (registry created_by). */
  minted_by?: string;
  /** Human-readable purpose/label (registry label). */
  purpose?: string;
  /** Granted scopes on the credential. */
  scopes?: string[];
  /** Egress IP observed by the auth server at the last token mint — the
   *  automation's client IP, which a direct-insert telemetry client can't
   *  otherwise capture. */
  client_ip?: string;
}

export async function readServiceAttributionCache(
  clientId: string | undefined,
  dataDirOverride?: string,
): Promise<ServiceAttribution> {
  try {
    const raw = await readFile(serviceTokenCachePath(dataDirOverride), 'utf-8');
    const parsed = JSON.parse(raw) as {
      client_id?: string;
      attribution?: ServiceAttribution;
    };
    const a = parsed.attribution;
    if (!a || typeof a !== 'object') return {};
    // Only trust attribution that belongs to the configured client — a
    // re-pointed credential must not inherit the old owner.
    if (clientId && parsed.client_id && parsed.client_id !== clientId) return {};
    return {
      owner_user_id: typeof a.owner_user_id === 'string' ? a.owner_user_id : undefined,
      minted_by: typeof a.minted_by === 'string' ? a.minted_by : undefined,
      purpose: typeof a.purpose === 'string' ? a.purpose : undefined,
      scopes: Array.isArray(a.scopes)
        ? a.scopes.filter((s): s is string => typeof s === 'string')
        : undefined,
      client_ip: typeof a.client_ip === 'string' ? a.client_ip : undefined,
    };
  } catch {
    return {};
  }
}
