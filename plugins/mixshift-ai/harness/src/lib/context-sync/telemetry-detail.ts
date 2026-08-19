/**
 * Scrub filesystem paths out of telemetry `detail` strings.
 *
 * Non-ENOENT fs errors (EBUSY/EPERM from readLocalDocs, see local.ts) can
 * propagate all the way out to a `detail` field with the raw Node.js error
 * message attached, e.g.:
 *
 *   EBUSY: resource busy or locked, open 'C:\Users\sam\.mixshift\clients\
 *   acme\corpora\notes.md'
 *
 * events.ts's contract for context_sync.* payloads is explicit: brand slugs,
 * per-action doc counts, force flag, duration + outcome — NEVER doc content
 * or file paths (a local path embeds the OS username and this machine's
 * directory layout, neither of which belongs in a shared telemetry table).
 * scrubDetail() is the one place every `detail` value passes through before
 * it reaches a telemetry payload in autosync.ts / push-after-write.ts, so a
 * future error type that leaks a path is caught even when nobody thought to
 * redact it at the specific call site that introduced it.
 *
 * Scope: this is a TELEMETRY-only scrub. The same `detail` value returned to
 * a CLI caller (AutoSyncResult / PushAfterWriteResult / BootstrapResult.push,
 * --json or human output) keeps the real, unscrubbed text — a user debugging
 * their own machine needs the real path; the shared telemetry table never
 * should.
 */

import { homedir } from 'node:os';

/** Detail strings longer than this are truncated — a scrubbed message is a
 *  diagnostic hint, not a transcript. */
const MAX_DETAIL_LENGTH = 300;

/**
 * A path-like token, matched AFTER the home-directory substitution below has
 * already collapsed the common case to `~`:
 *   - a drive-letter root (`C:\...` / `C:/...`), any number of segments, OR
 *   - a bare run of 2+ slash-separated segments (POSIX-style, a leftover
 *     `~\...` remainder, or a UNC-ish path) — 2+ so an ordinary "and/or" or
 *     "50/50" in prose (one separator) is never mistaken for a path.
 * The character class excludes quotes/angle-brackets/whitespace so the match
 * stops at whatever delimiter the surrounding message used to quote the path
 * (Node's fs errors quote with single quotes).
 */
const PATH_TOKEN_RE =
  /[A-Za-z]:[\\/][^\s'"<>]*(?:[\\/][^\s'"<>]+)*|~?(?:[\\/][^\s'"<>]+){2,}/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Never throws: os.homedir() is documented as safe, but this is telemetry
 *  code — a scrubber that itself crashed the write seam would be worse than
 *  the leak it exists to prevent. */
function safeHomedir(): string {
  try {
    return homedir() || '';
  } catch {
    return '';
  }
}

/**
 * Replace the current user's home directory (both slash directions,
 * case-insensitive on win32 — Windows paths are case-insensitive and Node
 * error messages don't normalize casing) with `~`, then collapse any
 * remaining path-like token (drive-letter rooted, or 2+ slash-separated
 * segments — including a `~\...` remainder from the step above) to
 * `<path>`, then cap the result length. Never throws. A plain message with
 * no path-shaped substring passes through byte-for-byte unchanged.
 */
export function scrubDetail(detail: string): string {
  let out = detail;

  const home = safeHomedir();
  if (home) {
    const variants = new Set(
      [home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')].filter((v) => v.length > 0),
    );
    const flags = process.platform === 'win32' ? 'gi' : 'g';
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), flags), '~');
    }
  }

  out = out.replace(PATH_TOKEN_RE, '<path>');

  if (out.length > MAX_DETAIL_LENGTH) {
    out = `${out.slice(0, MAX_DETAIL_LENGTH)}…`;
  }
  return out;
}
