/**
 * Read the plugin version from the canonical source:
 * `<plugin-root>/.claude-plugin/plugin.json::version`.
 *
 * Why this exists: prior to this module, four sites in the harness read
 * `harness/package.json::version` (a workspace-internal value pinned at
 * `0.0.1`) or hardcoded the literal `'0.0.1'`. Both diverged from the
 * actual customer-facing plugin version (`0.3.x` / `0.4.x` / etc., declared
 * in plugin.json + marketplace.json). Every telemetry event reported the
 * wrong version, every Discord webhook posted the wrong version, and
 * `mixshift --version` lied to the user.
 *
 * Plugin.json is the single source of truth because:
 *   - It's what Cowork / Claude Code read to identify the plugin install.
 *   - It's what `.claude-plugin/marketplace.json` mirrors (marketplace ships
 *     the same value for the install-flow display).
 *   - Bumping it in one place is the natural "release" gesture.
 *
 * Sync filesystem access is intentional. The file is ~200 bytes and read
 * once per process (memoized below); blocking briefly at CLI startup is
 * acceptable. The async alternative would force every call site to await
 * a Promise just to log a version string in a structured event payload.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginRoot } from './prefetch/plugin-root.js';

let cached: string | undefined;

/**
 * Returns the plugin version string from plugin.json. Memoized; reads from
 * disk at most once per process. Falls back to `'0.0.0-unknown'` if the
 * file is missing or unparseable so callers don't have to handle errors —
 * a broken plugin.json is a build-system problem, not a runtime one.
 */
export function getPluginVersion(): string {
  if (cached) return cached;
  try {
    const path = join(resolvePluginRoot(), '.claude-plugin', 'plugin.json');
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) {
      cached = parsed.version;
      return cached;
    }
  } catch {
    // Fall through to the sentinel below — never throw out of a version
    // accessor; telemetry callsites would be the most-affected place.
  }
  cached = '0.0.0-unknown';
  return cached;
}

/**
 * Test-only escape hatch to reset the memoized cache between cases that
 * point at different fixture plugin.json files. Not exported for production.
 */
export function __resetPluginVersionCache(): void {
  cached = undefined;
}
