/**
 * Schema for ~/.mixshift/auth/credentials.json.
 *
 * Stored at file mode 0600. Plaintext on disk — see CONTRIBUTING.md and
 * BRAND-MANAGEMENT.md for the trust-boundary discussion. IP whitelist is
 * the effective second factor: even if creds leak, they can't be used
 * from a non-whitelisted IP.
 *
 * v2 (Data Hub) will replace mysql{...} with datahub{token,...}.
 */

import { z } from 'zod';

export const mysqlCredsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(3306),
  user: z.string().min(1),
  password: z.string(),
  database: z.string().min(1),
});

export const credentialsSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.iso.datetime(),
  mysql: mysqlCredsSchema.optional(),
  // v2 placeholder:
  // datahub: z.object({ token: z.string(), api_base: z.url() }).optional(),
});

export type MysqlCreds = z.infer<typeof mysqlCredsSchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

export function newCredentials(): Credentials {
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
  };
}
