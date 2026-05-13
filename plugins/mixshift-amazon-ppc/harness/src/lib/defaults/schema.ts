/**
 * Schema for the plugin-shipped defaults file
 * (plugins/mixshift-amazon-ppc/.mixshift-defaults.yaml).
 *
 * These are MixShift deployment values — webhook URL, telemetry endpoint,
 * etc. — that every user receives with the plugin install. Distinct from
 * the user's per-install profile.yaml.
 */

import { z } from 'zod';

export const defaultsSchema = z.object({
  schema_version: z.literal(1),
  auth: z
    .object({
      ip_whitelist_webhook: z.url().or(z.literal('')).default(''),
      public_ip_lookup_url: z.url().default('https://api.ipify.org?format=json'),
    })
    .default({
      ip_whitelist_webhook: '',
      public_ip_lookup_url: 'https://api.ipify.org?format=json',
    }),
  telemetry: z
    .object({
      endpoint: z.string().default(''),
      batch_size: z.number().int().positive().default(50),
      flush_interval_ms: z.number().int().positive().default(60_000),
    })
    .default({
      endpoint: '',
      batch_size: 50,
      flush_interval_ms: 60_000,
    }),
});

export type PluginDefaults = z.infer<typeof defaultsSchema>;
