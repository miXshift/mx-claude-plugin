/**
 * Redact secrets from a captured CLI argument vector before it enters
 * telemetry.
 *
 * Context (feedback #10): during beta we capture the FULL command line on
 * cli.command_run (and plugin.crashed) so reviews can see WHAT users actually
 * run — the ad-hoc SQL, the flags, the subcommands — which the prior
 * "cmd + subcmd only" capture dropped. But argv can also carry SECRETS: a
 * one-time `auth service-setup <code>`, a `--client-secret`, a bearer token.
 * Telemetry must NEVER carry those. This redactor is the safety gate: it keeps
 * business-meaningful args (SQL text, IDs, table names, brand slugs) and
 * replaces only credential material with a placeholder.
 *
 * Design — HIGH-PRECISION, context-first (deliberately NOT entropy-based:
 * entropy heuristics false-positive on legitimate long IDs/ASINs and would
 * silently nuke the very business data we want). Three rules:
 *   1. The VALUE of a secret-named flag: `--client-secret X`, `--secret=X`,
 *      `--token X`, `--password X`, `--api-key X`, `--setup-code X` (+ `=` form).
 *   2. The positional immediately after a subcommand token known to take a
 *      secret (`service-setup <code>`).
 *   3. High-confidence token shapes anywhere: JWTs (`a.b.c` base64url) and
 *      `sk_`/`pk_`/`rk_`-style prefixed secrets.
 * Everything else is preserved verbatim.
 *
 * Known limitation: short secret flags (`-p <pw>`) aren't matched — the CLI
 * uses long flags for anything sensitive. SQL string contents aren't
 * sub-parsed (an inline secret literal inside a quoted query is preserved as
 * part of the query the user chose to run); that's an accepted trade for
 * keeping the query text Sam asked to capture.
 */

const REDACTED = '<redacted>';

/**
 * Flag names whose VALUE is a secret. Tested case-insensitively against the
 * flag with leading dashes stripped. Anchored so `--table-key` (contains
 * "key") does NOT match — only a flag that IS `key` / `api-key` / etc.
 */
const SECRET_FLAG =
  /^(secret|client[-_]?secret|password|passwd|pwd|token|access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|key|credential|credentials|setup[-_]?code|code|auth[-_]?token|bearer)$/i;

/** Subcommand tokens after which the next positional arg is a secret. */
const SECRET_POSITIONAL_AFTER = new Set(['service-setup']);

/** High-confidence secret token shapes (not entropy — exact structure). */
function looksLikeSecretToken(s: string): boolean {
  // JWT: three base64url segments joined by dots.
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/.test(s)) return true;
  // Common prefixed API secrets (sk_live_..., pk_..., rk_...).
  if (/^(sk|pk|rk)_[A-Za-z0-9_-]{12,}$/.test(s)) return true;
  return false;
}

function flagName(arg: string): string {
  return arg.replace(/^-+/, '');
}

/**
 * Return a copy of `argv` with credential material replaced by `<redacted>`.
 * Pure and cheap (single pass over a small array); safe to call on every
 * invocation.
 */
export function redactArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  let redactNext = false;

  for (const arg of argv) {
    // A prior secret-flag / secret-positional marked THIS token as the value.
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
      continue;
    }

    // `--flag=value`
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = flagName(arg.slice(0, eq));
      out.push(SECRET_FLAG.test(name) ? `${arg.slice(0, eq)}=${REDACTED}` : arg);
      continue;
    }

    // `--flag` / `-flag` (value, if any, is the NEXT token)
    if (arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg)) {
      out.push(arg);
      if (SECRET_FLAG.test(flagName(arg))) redactNext = true;
      continue;
    }

    // Positional
    if (looksLikeSecretToken(arg)) {
      out.push(REDACTED);
    } else {
      out.push(arg);
    }
    if (SECRET_POSITIONAL_AFTER.has(arg)) redactNext = true;
  }

  return out;
}

/** Guard so a negative number (`-5`) isn't treated as a flag. */
function isNumericLike(arg: string): boolean {
  return /^-\d/.test(arg);
}
