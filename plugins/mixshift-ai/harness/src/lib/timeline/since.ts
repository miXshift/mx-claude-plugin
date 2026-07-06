/**
 * `--since` parsing for `mixshift timeline list`.
 *
 * Accepts either an ISO-8601 timestamp/date ('2026-07-01',
 * '2026-07-01T12:00:00Z') passed through verbatim semantics, or a simple
 * relative form: `<N>h` (hours), `<N>d` (days), `<N>w` (weeks) resolved
 * against the current clock. Anything else is a parse error the command
 * layer surfaces to the user.
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

export function parseSince(input: string, now: Date = new Date()): ParseSinceResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: '--since must not be empty' };
  }

  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, message: `invalid relative --since '${input}'` };
    }
    return { ok: true, iso: new Date(now.getTime() - n * UNIT_MS[unit]!).toISOString() };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      message:
        `invalid --since '${input}' — pass an ISO timestamp (2026-07-01, ` +
        `2026-07-01T12:00:00Z) or a relative form (24h, 7d, 2w)`,
    };
  }
  return { ok: true, iso: parsed.toISOString() };
}
