/**
 * Turn a thrown `fetch` error into an actionable, sandbox-aware message.
 *
 * Node's global fetch (undici) throws a terse `TypeError: fetch failed` and
 * buries the real reason in `err.cause` (an inner error carrying `code`
 * like ENOTFOUND / EAI_AGAIN / ECONNREFUSED, or a proxy 403 when the
 * request was routed through a sandbox egress proxy). The harness used to
 * surface only the top-level "fetch failed", which tells the user nothing.
 *
 * The dominant real-world cause is the Claude Cowork / Claude Code sandbox:
 * all Bash-subprocess egress is forced through a deny-by-default proxy
 * (`localhost:3128`), and if `mcp.mixshift.io` is not on that environment's
 * allowlist the proxy refuses the CONNECT with 403. Before the proxy is
 * honored the same block shows up as a direct-DNS ENOTFOUND/EAI_AGAIN
 * (the sandbox disables direct name resolution). We classify both.
 */

interface FetchErrorish {
  name?: string;
  message?: string;
  cause?: { code?: string; message?: string } | undefined;
}

/**
 * Classify a network-level fetch failure into a user-facing message, or
 * return `null` when the error is NOT a recognizable network failure (for
 * example an application-level `HTTP 400` Error thrown by a handler after a
 * successful connection — those carry their own descriptive message and
 * should not be masked).
 */
export function describeFetchFailure(err: unknown, host: string): string | null {
  const e = (err ?? {}) as FetchErrorish;
  const topMessage = String(e.message ?? '');
  const cause = e.cause ?? {};
  const code = String(cause.code ?? '');
  const causeMessage = String(cause.message ?? '');

  const isTimeout =
    e.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT';
  const isAbort = e.name === 'AbortError';
  // undici surfaces network failures as `TypeError: fetch failed` with the
  // real reason on `.cause`. Anything else with a `.cause` is also treated
  // as a transport-level failure worth classifying.
  const isFetchFailure = topMessage === 'fetch failed' || Boolean(e.cause);

  if (!isFetchFailure && !isTimeout && !isAbort) return null;

  // Proxy refused the host on CONNECT (sandbox egress allowlist). The 403
  // can land in either the cause message or, depending on undici version,
  // the top-level message.
  if (/\b403\b/.test(causeMessage) || /\b403\b/.test(topMessage)) {
    return (
      `The sandbox blocked ${host}. Your environment's egress allowlist ` +
      `does not include it. On Claude Cowork, an org admin must add ` +
      `${host} under Organization settings > Capabilities > Code execution, ` +
      `then start a new conversation. On standalone Claude Code, add it to ` +
      `~/.claude/settings.json under sandbox.network.allowedDomains. ` +
      `Run \`mixshift doctor\` for the full remediation.`
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return (
      `Could not resolve ${host}. If you are in a sandbox (Claude Cowork ` +
      `or Claude Code), outbound traffic must go through its egress proxy ` +
      `and ${host} must be allowlisted. Run \`mixshift doctor\` for the ` +
      `full remediation.`
    );
  }

  if (code === 'ECONNREFUSED') {
    return `Connection to ${host} was refused.`;
  }

  if (isTimeout || isAbort) {
    return `Timed out connecting to ${host}.`;
  }

  // Unclassified transport failure: the connection never completed but the
  // cause didn't match a code we special-case above. In Claude Cowork / Claude
  // Code this is overwhelmingly the sandbox egress allowlist silently dropping
  // the connection — it surfaces with assorted or empty codes (we've seen a
  // bare `0`), which is exactly why it slipped past the branches above and used
  // to dead-end on a useless "Network error … 0". Lead with that cause + the
  // doctor, but stay honest about a genuine outage / offline machine.
  const raw = code || causeMessage || '';
  const detail = raw && raw !== '0' ? ` (${raw})` : '';
  return (
    `Could not reach ${host}${detail}. In Claude Cowork or Claude Code this is ` +
    `almost always the sandbox egress allowlist: ${host} has to be allowed ` +
    `(an org admin adds it under Organization settings > Capabilities > Code ` +
    `execution; on standalone Claude Code add it to ~/.claude/settings.json ` +
    `under sandbox.network.allowedDomains). Otherwise the service may be down ` +
    `or you're offline. Run \`mixshift doctor\` for the full diagnosis.`
  );
}

/**
 * Always returns a string: the classified network message when the error
 * is a transport failure, otherwise the error's own message. Use this at
 * catch sites that need to render something regardless of error type.
 */
export function networkErrorMessage(err: unknown, host: string): string {
  return describeFetchFailure(err, host) ?? extractMessage(err);
}

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
