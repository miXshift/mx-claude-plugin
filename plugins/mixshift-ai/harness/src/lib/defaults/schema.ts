/**
 * Schema for the plugin-shipped defaults file
 * (plugins/mixshift-ai/.mixshift-defaults.yaml).
 *
 * These are MixShift deployment values — webhook URL, MySQL connection
 * defaults, credential-retrieval instructions, telemetry endpoint, etc. —
 * that every user receives with the plugin install. Distinct from the
 * user's per-install profile.yaml.
 *
 * Adding a field:
 *   1. Add to the YAML at plugins/mixshift-ai/.mixshift-defaults.yaml
 *   2. Add to the corresponding Zod sub-object here
 *   3. Add a default value in the parent .default({...}) block so the
 *      schema parses even when the YAML field is missing
 */

import { z } from 'zod';

const mysqlDefaults = z.object({
  host: z.string().default('db.mydashapplications.studio'),
  port: z.number().int().min(1).max(65535).default(3306),
  database: z.string().default('dashamazon'),
});

const credentialRetrieval = z.object({
  url_default: z.string().default('https://www.mydashapplications.com/database-admin'),
  url_tenant_pattern: z
    .string()
    .default('https://<your-company>.mydashapplications.com/database-admin'),
  master_password: z.string().default(''),
  notes: z.string().default(''),
});

export const defaultsSchema = z.object({
  schema_version: z.literal(1),
  auth: z
    .object({
      ip_whitelist_webhook: z.url().or(z.literal('')).default(''),
      public_ip_lookup_url: z.url().default('https://api.ipify.org?format=json'),
      mysql: mysqlDefaults.default({
        host: 'db.mydashapplications.studio',
        port: 3306,
        database: 'dashamazon',
      }),
      credential_retrieval: credentialRetrieval.default({
        url_default: 'https://www.mydashapplications.com/database-admin',
        url_tenant_pattern: 'https://<your-company>.mydashapplications.com/database-admin',
        master_password: '',
        notes: '',
      }),
    })
    .default({
      ip_whitelist_webhook: '',
      public_ip_lookup_url: 'https://api.ipify.org?format=json',
      mysql: {
        host: 'db.mydashapplications.studio',
        port: 3306,
        database: 'dashamazon',
      },
      credential_retrieval: {
        url_default: 'https://www.mydashapplications.com/database-admin',
        url_tenant_pattern: 'https://<your-company>.mydashapplications.com/database-admin',
        master_password: '',
        notes: '',
      },
    }),
  telemetry: z
    .object({
      // Supabase REST endpoint for the events table. Empty = "configured off"
      // (events buffered locally, never flushed). See internal/SUPABASE-SETUP.md.
      endpoint: z.string().default(''),
      // Supabase anon key. Empty = "configured off" same as endpoint.
      apikey: z.string().default(''),
      batch_size: z.number().int().positive().default(50),
      flush_interval_ms: z.number().int().positive().default(60_000),
    })
    .default({
      endpoint: '',
      apikey: '',
      batch_size: 50,
      flush_interval_ms: 60_000,
    }),
});

export type PluginDefaults = z.infer<typeof defaultsSchema>;
