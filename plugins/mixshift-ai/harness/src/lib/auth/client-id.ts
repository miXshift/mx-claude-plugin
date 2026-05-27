/**
 * Resolve the `client_id` for surface attribution against mx-legacy-auth.
 *
 * The service validates that `client_id` is slug-shaped (`[a-z0-9-]{1,64}`)
 * server-side, but we mirror the check here to fail fast with a clear
 * message rather than a 400 from /auth/login.
 *
 * Resolution precedence (highest first):
 *
 *   1. CLI flag (`--client-id`) — one-off override per invocation.
 *   2. `MIXSHIFT_PLUGIN_CLIENT_ID` env var — dev workflow. Developers
 *      working against prod with the shared test account set this to
 *      `mx-claude-plugin-dev` in their shell so their sessions are
 *      identifiable in Supabase by `client_id = 'mx-claude-plugin-dev'`.
 *   3. Default `mx-claude-plugin` — release builds. Zero config.
 */

const CLIENT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const DEFAULT_CLIENT_ID = 'mx-claude-plugin';
const ENV_VAR_NAME = 'MIXSHIFT_PLUGIN_CLIENT_ID';

export function resolveClientId(cliFlag?: string): string {
  // Shell convention: an empty env var (`FOO=`) is treated as unset, not
  // as "explicitly empty". So normalize an empty-string env var to
  // undefined before the fallback chain.
  const envRaw = process.env[ENV_VAR_NAME];
  const envValue = envRaw && envRaw.length > 0 ? envRaw : undefined;

  const raw = cliFlag ?? envValue ?? DEFAULT_CLIENT_ID;
  if (!CLIENT_ID_PATTERN.test(raw)) {
    const source = cliFlag
      ? '--client-id'
      : envValue
        ? `${ENV_VAR_NAME} env var`
        : 'default';
    throw new Error(
      `Invalid client_id "${raw}" (from ${source}). ` +
        `Must match [a-z0-9-]{1,64}. ` +
        `Common values: mx-claude-plugin, mx-claude-plugin-dev.`,
    );
  }
  return raw;
}
