/**
 * Resolve the plugin root directory (the one containing `shared/`,
 * `skills/`, `bin/`, and `harness/`).
 *
 * We walk up from this module's location until we find a directory that
 * contains a `shared/sql-library/catalog.yaml`. That signals "yes, this
 * is the mixshift-ai plugin root, not just any ancestor."
 *
 * Two reasons we don't trust env vars alone:
 *   1. `CLAUDE_PLUGIN_ROOT` is only set when invoked through Claude Code's
 *      plugin runtime. Direct `mixshift` CLI invocation (terminal /
 *      tests) won't have it.
 *   2. Tests may override the root via env so they can point at a
 *      fixture directory; we still want a deterministic fallback.
 *
 * Resolution order:
 *   1. `MIXSHIFT_PLUGIN_ROOT` env var (test escape hatch)
 *   2. `CLAUDE_PLUGIN_ROOT` env var (Claude Code runtime)
 *   3. Walk up from import.meta.url, look for shared/sql-library marker
 *
 * Callers should cache the result — resolution is sync but does a
 * filesystem walk.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

export function resolvePluginRoot(): string {
  if (cached) return cached;

  const envOverride =
    process.env.MIXSHIFT_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
  if (envOverride && isPluginRoot(envOverride)) {
    cached = envOverride;
    return envOverride;
  }

  // Walk up from this module's directory. From either `harness/src/lib/prefetch/`
  // (tests / dev) or `harness/dist/` (built), the plugin root is 2-4 levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (isPluginRoot(dir)) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Could not locate the mixshift-ai plugin root (looked for ` +
      `shared/sql-library/catalog.yaml). Walked up from ${here}. ` +
      `If you're running tests, set MIXSHIFT_PLUGIN_ROOT.`,
  );
}

/**
 * For tests that need to reset the resolver after pointing it at a
 * temporary fixture directory.
 */
export function resetPluginRootCache(): void {
  cached = undefined;
}

function isPluginRoot(dir: string): boolean {
  try {
    const marker = join(dir, 'shared', 'sql-library', 'catalog.yaml');
    return existsSync(marker) && statSync(marker).isFile();
  } catch {
    return false;
  }
}

/**
 * Helper: resolve a path under the plugin root. Used by sql-library,
 * manifest-loader, etc. to avoid repeating the `join(resolvePluginRoot(), ...)`
 * incantation.
 */
export function pluginPath(...segments: string[]): string {
  return join(resolvePluginRoot(), ...segments);
}
