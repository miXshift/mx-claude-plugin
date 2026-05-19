/**
 * Zod schema for ~/.mixshift/profile.yaml.
 *
 * Profile holds user-scoped, one-time-set preferences. Brand contexts
 * are separate (in shared/clients/<brand>/context.yaml). See
 * docs/productization/BRAND-MANAGEMENT.md.
 *
 * Schema is intentionally permissive on optional sections so the file
 * can grow without breaking existing installs. Required fields fail
 * closed.
 */

import { z } from 'zod';

const surfaceEnum = z.enum(['claude_code', 'cowork', 'chat']);

const outputAdapterEnum = z.enum([
  'local-html',
  'inline-markdown',
  'google-doc',
  'csv',
  'terminal',
]);

/**
 * Per-skill output config. Either a single adapter (applied to every surface)
 * or a per-surface map.
 */
const perSkillOutputSchema = z.union([
  outputAdapterEnum,
  z.object({
    claude_code: outputAdapterEnum.optional(),
    cowork: outputAdapterEnum.optional(),
    chat: outputAdapterEnum.optional(),
  }),
]);

export const profileSchema = z.object({
  schema_version: z.literal(1),

  user: z
    .object({
      email: z.email().optional(),
    })
    .default({}),

  credential_store: z.enum(['plaintext', 'keychain']).default('plaintext'),

  output: z
    .object({
      default_by_surface: z
        .object({
          claude_code: outputAdapterEnum.default('local-html'),
          cowork: outputAdapterEnum.default('inline-markdown'),
          chat: outputAdapterEnum.default('inline-markdown'),
        })
        .default({
          claude_code: 'local-html',
          cowork: 'inline-markdown',
          chat: 'inline-markdown',
        }),
      per_skill: z.record(z.string(), perSkillOutputSchema).default({}),
    })
    .default({
      default_by_surface: {
        claude_code: 'local-html',
        cowork: 'inline-markdown',
        chat: 'inline-markdown',
      },
      per_skill: {},
    }),

  // User-curated brand state. Distinct from the warehouse-derived registry
  // at ~/.mixshift/clients/index.yaml (which lists every brand the user
  // can see). `brands.key` is the focused subset the user actually works
  // with day-to-day — agency managers with 200+ accounts use this to point
  // portfolio skills at the 5-10 brands they own, instead of scanning
  // every account. Each entry must match a slug present in the registry;
  // validation happens at write time in lib/clients/key-brands.ts.
  brands: z
    .object({
      key: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    })
    .default({ key: [] }),

  telemetry: z
    .object({
      // Anonymous machine identifier — UUID generated on first run, immutable.
      // Used to group events from one install before the user has set up auth.
      // Linked to user.email server-side once auth setup completes.
      install_id: z.uuid().optional(),
      // ISO timestamp when the consent notice was shown. Absent = not yet shown.
      // The first-run notice prints whenever this is absent; setting it suppresses
      // future prints.
      acknowledged_at: z.iso.datetime().optional(),
      // User-set opt-out via `mixshift telemetry opt-out`. When true, no events
      // are queued or sent (the env var MIXSHIFT_TELEMETRY=0 has the same effect
      // but doesn't persist).
      opted_out: z.boolean().default(false),
      // Last plugin version we observed on this machine. Used to fire a
      // plugin.updated telemetry event when the running version differs.
      // Bumped after each emit. Absent on installs that pre-date this field —
      // no plugin.updated event is fired for the first observation; the value
      // is just captured for next time.
      last_plugin_version: z.string().optional(),
    })
    .default({ opted_out: false }),

  ui: z
    .object({
      port: z.number().int().min(1).max(65535).default(8080),
      password_hash: z.string().optional(),
    })
    .default({ port: 8080 }),
});

export type Profile = z.infer<typeof profileSchema>;
export type Surface = z.infer<typeof surfaceEnum>;
export type OutputAdapter = z.infer<typeof outputAdapterEnum>;

/**
 * Default profile used when no file exists yet. Used by `profile show` to
 * surface defaults rather than erroring on first run, and by `auth setup`
 * as the starting point for the onboarding flow.
 */
export function defaultProfile(): Profile {
  return profileSchema.parse({ schema_version: 1 });
}
