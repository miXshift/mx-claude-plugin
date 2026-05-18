/**
 * Load the plugin-shipped defaults file
 * (plugins/mixshift-ai/.mixshift-defaults.yaml).
 *
 * The defaults file ships in the plugin install directory. We find it by
 * walking up from this module's location to the plugin root. If the file
 * is missing or invalid we fall back to schema-baked defaults so the
 * harness still works for tests / development.
 *
 * Resolution priority (used by callers, not this module):
 *   1. CLI flag
 *   2. Env var
 *   3. User profile (~/.mixshift/profile.yaml)
 *   4. This file
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { defaultsSchema, type PluginDefaults } from './schema.js';
import { formatZodError } from '../profile/format-error.js';

export async function loadPluginDefaults(
  overridePath?: string,
): Promise<PluginDefaults> {
  const candidates = overridePath ? [overridePath] : candidatePaths();

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = parseYaml(raw);
      const result = defaultsSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          formatZodError(result.error, `Plugin defaults at ${path} are invalid`),
        );
      }
      return applyEnvOverrides(result.data);
    } catch (err) {
      if (isFileNotFoundError(err)) continue;
      throw err;
    }
  }

  // No defaults file found — return schema defaults so the harness still
  // works for development / tests with no real deployment config.
  return applyEnvOverrides(defaultsSchema.parse({ schema_version: 1 }));
}

/**
 * Layer environment-variable overrides on top of the parsed defaults.
 *
 * Why this exists: some defaults are MixShift-deployment-specific (the
 * Discord webhook URL, the Supabase telemetry endpoint) but shouldn't be
 * committed to a public repo as plaintext credentials. We ship empty
 * placeholders in `.mixshift-defaults.yaml` and let env vars carry the
 * real values at runtime. This keeps the public repo free of secret-
 * shaped strings while preserving the "plugin just works" UX for
 * customers running through MixShift's deployment pipeline.
 *
 * Recognized env vars (all optional):
 *   MIXSHIFT_DISCORD_WEBHOOK        Discord webhook for ops alerts:
 *                                   IP whitelist requests, user feedback,
 *                                   table-access requests, plugin crashes.
 *                                   Until Supabase fan-out is live (see
 *                                   internal/SUPABASE-SETUP.md §10), this
 *                                   is how MixShift's internal team gets
 *                                   real-time alerts.
 *   MIXSHIFT_TELEMETRY_ENDPOINT     Supabase REST endpoint for events.
 *   MIXSHIFT_TELEMETRY_APIKEY       Supabase anon key (safe to embed —
 *                                   designed for client embedding, RLS does
 *                                   the security work).
 *
 * Values can come from the shell environment OR from a `.env.local` file
 * loaded at CLI startup (see lib/env/load-dotenv.ts).
 */
function applyEnvOverrides(defaults: PluginDefaults): PluginDefaults {
  const env = process.env;

  // Webhook override (Discord URLs are secrets — never ship in repo).
  if (env.MIXSHIFT_DISCORD_WEBHOOK) {
    defaults.auth.discord_webhook = env.MIXSHIFT_DISCORD_WEBHOOK;
  }

  // Telemetry endpoint + apikey overrides. Useful for local Supabase
  // testing without bumping a plugin version. Also covers the scenario
  // where the shipped defaults ship empty (telemetry "configured off")
  // and a tester wants to point at a sandbox project.
  if (env.MIXSHIFT_TELEMETRY_ENDPOINT) {
    defaults.telemetry.endpoint = env.MIXSHIFT_TELEMETRY_ENDPOINT;
  }
  if (env.MIXSHIFT_TELEMETRY_APIKEY) {
    defaults.telemetry.apikey = env.MIXSHIFT_TELEMETRY_APIKEY;
  }

  return defaults;
}

/**
 * Returns candidate paths for the defaults file, walking up from this
 * module's location. When bundled (dist/) we look in dist/ and the plugin
 * root. When running from source (src/) we look in src/, src/lib/, the
 * harness root, and the plugin root.
 */
function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  let dir = here;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, '.mixshift-defaults.yaml'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
