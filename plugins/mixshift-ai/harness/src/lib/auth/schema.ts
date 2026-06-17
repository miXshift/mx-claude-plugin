/**
 * Schema for ~/.mixshift/auth/credentials.json.
 *
 * Stored at file mode 0600. Plaintext on disk — see CONTRIBUTING.md for the
 * trust-boundary discussion.
 *
 * Two credential shapes are supported:
 *
 *   - v1 (legacy `mysql` block): raw MySQL credentials + per-user IP
 *     whitelist. Still loadable so existing installs keep working; new
 *     installs prefer v2.
 *
 *   - v2 (`datahub` block): token pair from the mx-legacy-auth MCP service
 *     at https://mcp.mixshift.io. Plugin holds {access, refresh} only;
 *     the service holds the static egress IP whitelisted in AWS. Both
 *     blocks may coexist in a v2 file during the coexistence window —
 *     the consumer (data/query-runner) prefers `datahub` when present.
 */

import { z } from 'zod';

// --- v1 (legacy raw MySQL) -------------------------------------------------

export const mysqlCredsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3306),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
});

// --- v2 (token-based against mx-legacy-auth) -------------------------------
//
// Field semantics (mirror mx-legacy-auth/docs/plugin-integration.md):
//
//   api_base            — service URL, e.g. https://mcp.mixshift.io
//   access_token        — JWT, ~24h TTL; sent as Bearer on every /api/* call
//   refresh_token       — opaque, ~30d TTL; one-time use (replay → revoke
//                         all sessions)
//   expires_at          — ISO-8601 for the access_token. getValidAccessToken
//                         refreshes when within 60s of this value.
//   refresh_expires_at  — ISO-8601 for the refresh_token. Past this, user
//                         must re-run `mixshift auth login`.
//   user_id             — service-side user id (string in the wire format).
//   email               — tenant's shared login (e.g. "ops@marpartners.com").
//                         One per tenant; same value shared by every
//                         employee in that tenant.
//   person_label        — self-attested per-employee actor email. Distinct
//                         from `email`; lets admins see WHO inside the
//                         tenant authenticated, even though they all share
//                         the same MySQL login. Wire-format field name is
//                         `actor` (RFC 8693 delegation); we use
//                         `person_label` locally because that's the UX term.
//   device_label        — defaults to os.hostname(); shows on the login
//                         page so the user can confirm which device they
//                         are authorizing.
//   client_id           — surface attribution. `mx-claude-plugin` for
//                         release, `mx-claude-plugin-dev` during plugin
//                         development. Slug-shaped, server-validated.

export const datahubCredsSchema = z.object({
  api_base: z.url(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.iso.datetime(),
  refresh_expires_at: z.iso.datetime(),
  user_id: z.string().min(1),
  email: z.email(),
  person_label: z.email(),
  device_label: z.string().min(1),
  client_id: z.string().regex(/^[a-z0-9-]{1,64}$/).default('mx-claude-plugin'),
});

// --- service (machine) credentials ------------------------------------------
//
// Admin-issued static client credentials for unattended runs (Cowork
// scheduled tasks, cloud-env automations, CI). Used with the OAuth
// client_credentials grant against {api_base}/oauth/token: the harness
// mints short-lived (~1h) access tokens on demand and caches them next to
// this file. Unlike the datahub block there is NO refresh token and nothing
// rotates on use, so the block works from read-only credential stores and
// fresh sandboxes. Issued + revoked + rotated by a tenant admin at
// {api_base}/admin.

export const serviceCredsSchema = z.object({
  api_base: z.url(),
  client_id: z.string().regex(/^svc_[A-Za-z0-9_-]{8,}$/),
  client_secret: z.string().min(20),
  /** Informational copy of the admin-side label (svc:...); used as the
   *  person_label stand-in for telemetry attribution. */
  label: z.string().min(1).optional(),
});

// --- credentials envelope --------------------------------------------------

export const credentialsSchema = z.object({
  schema_version: z.union([z.literal(1), z.literal(2)]),
  created_at: z.iso.datetime(),
  mysql: mysqlCredsSchema.optional(),
  datahub: datahubCredsSchema.optional(),
  service: serviceCredsSchema.optional(),
});

export type MysqlCreds = z.infer<typeof mysqlCredsSchema>;
export type DatahubCreds = z.infer<typeof datahubCredsSchema>;
export type ServiceCreds = z.infer<typeof serviceCredsSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * Create a fresh credentials envelope at the current schema version. The
 * caller fills in `mysql` or `datahub` (or both during coexistence).
 */
export function newCredentials(): Credentials {
  return {
    schema_version: 2,
    created_at: new Date().toISOString(),
  };
}

/**
 * Type guard — distinguishes the two credential shapes for branching in
 * the query-runner. Datahub creds expose `access_token`; MySQL creds do
 * not.
 */
export function isDatahubCreds(c: MysqlCreds | DatahubCreds): c is DatahubCreds {
  return 'access_token' in c;
}
