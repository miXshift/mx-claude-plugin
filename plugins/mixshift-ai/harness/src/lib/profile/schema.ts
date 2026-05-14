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

  telemetry: z
    .object({
      enabled: z.boolean().default(true),
      user_id: z.string().optional(),
    })
    .default({ enabled: true }),

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
