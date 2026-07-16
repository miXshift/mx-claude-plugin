/**
 * Client-side `x-mixshift-intent` header for usage → outcome attribution.
 *
 * The gateway (mx-legacy-auth, mcp.mixshift.io) records this OPTIONAL
 * request header into its usage-metering rollups (mcp_api_usage.intent) — a
 * caller-attested workflow label tying a request back to the SKILL (or other
 * workflow) that drove it, so usage can later be joined to outcomes.
 *
 * ATTRIBUTION ONLY. The gateway never consults this header for authorization
 * or access control — that is the Bearer token's job, exclusively. A missing,
 * malformed, or forged intent value can only make an attribution stat wrong;
 * it can never grant or deny a request.
 *
 * Resolution precedence (highest first):
 *   1. `MIXSHIFT_INTENT` — explicit override, for callers that want a label
 *      distinct from "which skill is running" (e.g. a sub-workflow name).
 *   2. `MIXSHIFT_SKILL_ID` — the harness's existing "which skill is driving
 *      the CLI" convention (see lib/timeline/ads-emit.ts, commands/ads.ts
 *      help text). Skills set this before invoking the harness.
 *   3. Neither set (or both empty, per the shell `FOO=` == unset convention
 *      already used by resolveClientId) → the header is omitted entirely,
 *      never sent empty.
 *
 * Client-side sanitization MIRRORS the server's sanitizer exactly: trim,
 * lowercase, then require the whole value to match [a-z0-9_.:-]{1,64}. This
 * serves two purposes — we never send a header the server will just drop,
 * and a malformed or hostile env value (CR/LF header-injection attempts,
 * control characters, oversized strings) can never reach the wire, because
 * anything outside that charset — including whitespace and newlines — fails
 * the full-string match and falls back to {}.
 */

const INTENT_HEADER = 'x-mixshift-intent';
const INTENT_PATTERN = /^[a-z0-9_.:-]{1,64}$/;

/** Shell convention (mirrors resolveClientId in ./client-id.ts): an env var
 *  set to the empty string (`FOO=`) is treated as unset, not as
 *  "explicitly empty", so it falls through to the next precedence tier. */
function normalize(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * Build the intent header for one gateway request, or `{}` when no intent
 * is known or the resolved value fails the mirrored sanitizer. Pure and
 * exception-free by contract — safe to spread unconditionally into any
 * fetch's headers:
 *
 *   headers: { Authorization: `Bearer ${bearer}`, ...intentHeader() }
 *
 * Never throws. Never returns a header the server-side sanitizer would drop.
 */
export function intentHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = normalize(env.MIXSHIFT_INTENT) ?? normalize(env.MIXSHIFT_SKILL_ID);
  if (raw === undefined) return {};

  const candidate = raw.trim().toLowerCase();
  if (!INTENT_PATTERN.test(candidate)) return {};

  return { [INTENT_HEADER]: candidate };
}
