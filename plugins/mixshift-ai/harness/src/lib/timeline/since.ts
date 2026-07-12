/**
 * Relative/ISO time-window parsing for `mixshift timeline list` (`--since`
 * and `--until`).
 *
 * Accepts either an ISO-8601 timestamp/date ('2026-07-01',
 * '2026-07-01T12:00:00Z') passed through verbatim semantics, or a simple
 * relative form: `<N>h` (hours), `<N>d` (days), `<N>w` (weeks) resolved
 * against the current clock. Anything else is a parse error the command
 * layer surfaces to the user.
 *
 * `flag` only labels the error messages (defaults to '--since'); the parse
 * rules are identical for both edges, so `--until` reuses this verbatim.
 */

export type ParseSinceResult =
  | { ok: true; iso: string }
  | { ok: false; message: string };

const RELATIVE_RE = /^(\d+)([hdw])$/i;

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseSince(
  input: string,
  now: Date = new Date(),
  flag: string = '--since',
): ParseSinceResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: `${flag} must not be empty` };
  }

  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: `invalid relative ${flag} '${input}'` };
    }
    // ECMAScript time values are only valid within +/-8.64e15 ms of the
    // epoch; beyond that Date#toISOString throws RangeError. A huge N
    // (e.g. '99999999999d') must come back as a parse error, not a throw.
    const t = now.getTime() - n * UNIT_MS[unit]!;
    if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) {
      return {
        ok: false,
        message: `${flag} '${input}' is too large to be a real time window`,
      };
    }
    return { ok: true, iso: new Date(t).toISOString() };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message:
        `invalid ${flag} '${input}': pass an ISO timestamp (2026-07-01, ` +
        `2026-07-01T12:00:00Z) or a relative form (24h, 7d, 2w)`,
    };
  }
  return { ok: true, iso: parsed.toISOString() };
}
