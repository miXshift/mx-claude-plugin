import { resolveGatewayBaseSafe } from './gateway-url.js';

/**
 * Canonical base URL for the mx-legacy-auth MCP service, plus a small
 * helper to extract the bare hostname for user-facing diagnostics.
 *
 * Lives in its own module so the auth flow, the network classifier, and
 * the `mixshift doctor` preflight all share one source of truth instead
 * of each hard-coding `https://mcp.mixshift.io`.
 */

/** Default service URL. Overridable via `--api-base` on auth commands and
 *  via the saved credentials `datahub.api_base` once a user has signed in. */
export const DEFAULT_API_BASE = 'https://mcp.mixshift.io';

/**
 * Return the bare host (e.g. `mcp.mixshift.io`) for a given api_base. Used
 * in error messages and the allowlist remediation copy, where the host is
 * what the user adds to `sandbox.network.allowedDomains`. Falls back to the
 * default host if the input is missing or unparseable.
 */
export function resolveApiBaseHost(apiBase?: string): string {
  try {
    return new URL(apiBase ?? DEFAULT_API_BASE).host;
  } catch {
    return new URL(DEFAULT_API_BASE).host;
  }
}

/**
 * The service URL to use when the caller passed no explicit `--api-base`:
 * the configured gateway (`MIXSHIFT_GATEWAY_BASE_URL` or `gateway.base_url`,
 * validated by the same https/loopback guard as the metadata fetchers),
 * else DEFAULT_API_BASE. Never throws; a malformed value falls back to the
 * default rather than reaching a request.
 */
export async function resolveDefaultApiBase(): Promise<string> {
  return (await resolveGatewayBaseSafe()) || DEFAULT_API_BASE;
}
