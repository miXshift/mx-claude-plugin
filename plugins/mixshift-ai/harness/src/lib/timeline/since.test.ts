import { describe, it, expect } from 'vitest';
import { parseSince } from './since.js';

const NOW = new Date('2026-07-05T12:00:00.000Z');

describe('parseSince', () => {
  it('resolves relative hours/days/weeks against the clock', () => {
    expect(parseSince('24h', NOW)).toEqual({
      ok: true,
      iso: '2026-07-04T12:00:00.000Z',
    });
    expect(parseSince('7d', NOW)).toEqual({
      ok: true,
      iso: '2026-06-28T12:00:00.000Z',
    });
    expect(parseSince('2w', NOW)).toEqual({
      ok: true,
      iso: '2026-06-21T12:00:00.000Z',
    });
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(parseSince(' 24H ', NOW)).toEqual({
      ok: true,
      iso: '2026-07-04T12:00:00.000Z',
    });
  });

  it('passes ISO dates and timestamps through as ISO', () => {
    expect(parseSince('2026-07-01T00:00:00.000Z', NOW)).toEqual({
      ok: true,
      iso: '2026-07-01T00:00:00.000Z',
    });
    const dateOnly = parseSince('2026-07-01', NOW);
    expect(dateOnly.ok).toBe(true);
    if (dateOnly.ok) expect(dateOnly.iso).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects garbage, empty, and zero-quantity inputs', () => {
    for (const bad of ['yesterday', '', '   ', '0d', '5x', 'd7']) {
      const r = parseSince(bad, NOW);
      expect(r.ok, `input '${bad}' should be rejected`).toBe(false);
    }
  });
});
