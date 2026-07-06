/**
 * Redact secrets from a captured CLI argument vector before it enters
 * telemetry.
 *
 * Context (feedback #10): during beta we capture the FULL command line on
 * cli.command_run (and plugin.crashed) so reviews can see WHAT users actually
 * run — the ad-hoc SQL, the flags, the subcommands — which the prior
 * "cmd + subcmd only" capture dropped. But argv can also carry SECRETS: a
 * one-time `auth service-setup --setup-code <code>`, a token. Telemetry must
 * NEVER carry those. This redactor is the safety gate: it keeps
 * business-meaningful args (SQL text, IDs, table names, brand slugs) and
 * replaces only credential material with a placeholder.
 *
 * Design — HIGH-PRECISION, context-first (deliberately NOT entropy-based:
 * entropy heuristics false-positive on legitimate long IDs/ASINs and would
 * silently nuke the very business data we want). Two rules:
 *   1. The VALUE of a secret-named flag: `--setup-code X`, `--client-secret X`,
 *      `--token X`, `--password X`, `--api-key X` (and the `--flag=value` form).
 *      Every current CLI secret is a flag value, so this is the primary rule.
 *   2. High-confidence token SHAPES anywhere a positional appears: JWTs
 *      (`a.b.c` base64url), `sk_`/`pk_`/`rk_`-prefixed secrets, and the
 *      service-credential setup-code shape (`SVC-XXXX-XXXX`). Defense-in-depth.
 *
 * NOTE: we deliberately do NOT redact "the next positional after subcommand X".
 * There is no bare-positional secret argument in the CLI (setup codes come via
 * `--setup-code`), and such a state machine both LEAKED the setup code (it
 * consumed the `--setup-code` flag token, exposing the value) and OVER-redacted
 * the public `--client-id` value — the feedback #10 red-team findings.
 *
 * Known limitation: short secret flags (`-p <pw>`) aren't matched — the CLI
 * uses long flags for anything sensitive. String contents aren't sub-parsed
 * (a secret literal embedded inside a quoted `--body` JSON or a `data query`
 * SQL string is preserved as part of the text the user chose to run); that is
 * an accepted trade documented in docs/privacy.md, and users are advised not to
 * inline raw credentials into query/body strings.
 */

const REDACTED = '<redacted>';

/**
 * Flag names whose VALUE is a secret. Tested case-insensitively against the
 * flag with leading dashes stripped. Anchored so `--table-key` (contains
 * "key") and `--client-secret-file` (a PATH, not the secret) do NOT match —
 * only a flag that IS `key` / `client-secret` / `setup-code` / etc.
 */
const SECRET_FLAG =
  /^(secret|client[-_]?secret|password|passwd|pwd|token|access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|key|credential|credentials|setup[-_]?code|auth[-_]?token|bearer)$/i;

/** High-confidence secret token shapes (exact structure, not entropy). */
function looksLikeSecretToken(s: string): boolean {
  // JWT: three base64url segments joined by dots.
  if (/^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}$/.test(s)) return true;
  // Common prefixed API secrets (sk_live_..., pk_..., rk_...).
  if (/^(sk|pk|rk)_[A-Za-z0-9_-]{12,}$/.test(s)) return true;
  // Service-credential setup-code shape (SVC-XXXX-XXXX). Case-sensitive and
  // hyphenated, so it never collides with the lowercase underscore `svc_`
  // client_id, which is PUBLIC and must be preserved.
  if (/^SVC-[A-Z0-9]{2,}(-[A-Z0-9]{2,})*$/.test(s)) return true;
  return false;
}

function flagName(arg: string): string {
  return arg.replace(/^-+/, '');
}

/**
 * Return a copy of `argv` with credential material replaced by `<redacted>`.
 * Pure and cheap (single pass over a small array); safe to call on every
 * invocation and cannot throw.
 */
export function redactArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  // Set by a secret-named flag: the IMMEDIATE next token is that flag's value.
  let redactNextValue = false;

  for (const arg of argv) {
    if (redactNextValue) {
      out.push(REDACTED);
      redactNextValue = false;
      continue;
    }

    // `--flag=value`
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      const name = flagName(arg.slice(0, eq));
      out.push(SECRET_FLAG.test(name) ? `${arg.slice(0, eq)}=${REDACTED}` : arg);
      continue;
    }

    // `--flag` / `-flag`: a secret-named flag arms redaction of its value (the
    // next token). A non-secret flag is preserved and arms nothing, so a
    // following positional-shaped flag value (e.g. `--client-id svc_...`) is
    // NOT swallowed.
    if (arg.startsWith('-') && arg.length > 1 && !isNumericLike(arg)) {
      out.push(arg);
      if (SECRET_FLAG.test(flagName(arg))) redactNextValue = true;
      continue;
    }

    // Positional: redact only if it matches a known secret shape.
    out.push(looksLikeSecretToken(arg) ? REDACTED : arg);
  }

  return out;
}

/** Guard so a negative number (`-5`) isn't treated as a flag. */
function isNumericLike(arg: string): boolean {
  return /^-\d/.test(arg);
}
