import { loadPluginDefaults } from '../defaults/load.js';

/**
 * Resolve + validate the gateway base URL used for plugin-metadata fetches
 * (CHANGELOG, marketplace.json, actions.yaml — see changelog.ts,
 * version-check.ts, update-actions.ts).
 *
 * This is the SSRF guard. `raw` comes from .mixshift-defaults.yaml's
 * `gateway.base_url` (or the MIXSHIFT_GATEWAY_BASE_URL env override) — not
 * attacker-controlled the way a fetched manifest is, but a config value
 * should never turn into an arbitrary-host fetch just because it stopped
 * being empty. COPIES the exact allow-rule from update-actions.ts's
 * actionsUrl(): https, or http on loopback (127.0.0.1 / localhost — a test/
 * dev affordance only). Anything else — a bare host, `http://evil.com`,
 * `ftp:`, malformed input — resolves to '' ("no gateway configured"), and
 * callers fall through to their existing GitHub-raw fallback.
 */
export function resolveGatewayBase(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return stripTrailingSlash(raw);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
      return stripTrailingSlash(raw);
    }
  } catch {
    // malformed — fall through
  }
  return '';
}

/**
 * Load the configured gateway base and validate it, NEVER throwing. Wraps
 * loadPluginDefaults() — which throws on a present-but-corrupt/locked defaults
 * file (only ENOENT is swallowed) — so the metadata fetchers keep their
 * never-throw contract: a bad defaults file resolves to '' and the caller
 * falls through to its GitHub-raw fallback instead of crashing whatsnew /
 * version-check / mx-update.
 */
export async function resolveGatewayBaseSafe(): Promise<string> {
  try {
    const { gateway } = await loadPluginDefaults();
    return resolveGatewayBase(gateway.base_url);
  } catch {
    return '';
  }
}

/** A trailing slash on the configured base would double up against the
 *  leading slash each caller appends (`${base}/plugin/changelog`). */
function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
