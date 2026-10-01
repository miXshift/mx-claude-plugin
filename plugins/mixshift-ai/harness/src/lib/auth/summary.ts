/**
 * Read-only summary of the local sign-in state, shared by `mixshift doctor`
 * and `mixshift auth status`.
 *
 * Reads the credentials file only. No network, no token refresh, no prompt.
 * (loadCredentials itself may rewrite a v1 file as v2, the same silent
 * migration every command does; nothing else is written.)
 */

import { loadCredentials } from './credentials.js';
import type { Credentials } from './schema.js';
import { credentialsPath } from '../paths/resolve.js';
import { decodeAccessTokenClaims } from './token-claims.js';

export type AuthKind = 'interactive' | 'service' | 'legacy_mysql' | 'none';

export interface AuthSummary {
  signedIn: boolean;
  kind: AuthKind;
  email?: string;
  personLabel?: string;
  apiBase?: string;
  clientId?: string;
  label?: string;
  database?: string;
  accessExpiresAt?: string;
  accessExpired?: boolean;
  refreshExpiresAt?: string;
  /** True when the sign-in cannot be renewed any more (refresh token past its expiry). */
  refreshExpired?: boolean;
  /** Identity claims decoded locally from the access token (what the server and telemetry use). */
  tokenActor?: string;
  tokenEmail?: string;
  /** The credentials file exists but cannot be read (malformed, invalid, or a failed migration write). */
  unreadable?: boolean;
  credentialsPath?: string;
}

export async function summarizeAuth(dataDirOverride?: string): Promise<AuthSummary> {
  let credentials: Credentials | null = null;
  try {
    credentials = (await loadCredentials(dataDirOverride)).credentials;
  } catch {
    // A malformed creds file must not break a diagnostic; treat as signed-out.
    return { signedIn: false, kind: 'none', unreadable: true, credentialsPath: credentialsPath(dataDirOverride) };
  }
  if (!credentials) return { signedIn: false, kind: 'none' };

  // datahub (human session) wins when both exist — the more specific intent.
  if (credentials.datahub) {
    const d = credentials.datahub;
    const claims = decodeAccessTokenClaims(d.access_token);
    return {
      signedIn: true,
      kind: 'interactive',
      email: d.email,
      personLabel: d.person_label,
      apiBase: d.api_base,
      accessExpiresAt: d.expires_at,
      accessExpired: Date.parse(d.expires_at) <= Date.now(),
      refreshExpiresAt: d.refresh_expires_at,
      refreshExpired: Date.parse(d.refresh_expires_at) <= Date.now(),
      tokenActor: claims.actor,
      tokenEmail: claims.email,
    };
  }
  if (credentials.service) {
    return {
      signedIn: true,
      kind: 'service',
      apiBase: credentials.service.api_base,
      clientId: credentials.service.client_id,
      label: credentials.service.label,
    };
  }
  if (credentials.mysql) {
    return {
      signedIn: true,
      kind: 'legacy_mysql',
      database: credentials.mysql.database,
    };
  }
  return { signedIn: false, kind: 'none' };
}
