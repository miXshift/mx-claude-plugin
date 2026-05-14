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
      return result.data;
    } catch (err) {
      if (isFileNotFoundError(err)) continue;
      throw err;
    }
  }

  // No defaults file found — return schema defaults so the harness still
  // works for development / tests with no real deployment config.
  return defaultsSchema.parse({ schema_version: 1 });
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
