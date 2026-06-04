/**
 * Honor the sandbox egress proxy for Node's global `fetch`.
 *
 * Claude Cowork and Claude Code run the harness as a Bash subprocess whose
 * outbound traffic is forced through an HTTP proxy (they set
 * `https_proxy=http://localhost:3128`). Node's global fetch (undici) does
 * NOT read `http_proxy` / `https_proxy` by default before Node 24, so every
 * request would otherwise attempt a direct connection and fail (the sandbox
 * also disables direct DNS). Installing undici's `EnvHttpProxyAgent` as the
 * global dispatcher routes global fetch through the proxy.
 *
 * This does NOT bypass the sandbox: if the proxy's allowlist excludes our
 * host it still returns 403. What it buys us is (a) the allowlisted happy
 * path works without the user manually exporting env vars, and (b) the
 * proxy's 403 reaches us as a classifiable error instead of a murky
 * direct-connection failure (see ./classify.ts).
 *
 * `setGlobalDispatcher` from the installed `undici` package sets the same
 * versioned global dispatcher symbol that Node's built-in fetch reads, so
 * this affects global `fetch` even though we never import undici's own
 * `fetch`.
 */

import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

/**
 * Install the env-driven proxy dispatcher when an HTTP(S) proxy is
 * configured. No-op when no proxy env var is present (normal terminals,
 * unrestricted environments), so it is safe to call unconditionally at
 * startup. Returns true when a dispatcher was installed.
 *
 * We intentionally only key off `http_proxy` / `https_proxy` (lower and
 * upper case). The sandbox also advertises a SOCKS `all_proxy`
 * (`socks5h://localhost:1080`); undici does not speak SOCKS and the HTTP
 * CONNECT proxy is what matters for HTTPS to the service, so we ignore it.
 */
export function installProxyDispatcherIfConfigured(): boolean {
  const hasHttpProxy = Boolean(
    process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.HTTP_PROXY,
  );
  if (!hasHttpProxy) return false;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return true;
}
