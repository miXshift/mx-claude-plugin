import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAsinTitles, normalizeAsins } from './asin-titles.js';
import { runQuery } from './query-runner.js';

vi.mock('./query-runner.js', () => ({ runQuery: vi.fn() }));
const mockedRunQuery = vi.mocked(runQuery);

describe('normalizeAsins', () => {
  it('uppercases, trims, drops blanks, de-dupes, preserves first-seen order', () => {
    expect(normalizeAsins([' b0abc ', 'B0XYZ', 'b0abc', '', '  ', 'B0DEF'])).toEqual([
      'B0ABC',
      'B0XYZ',
      'B0DEF',
    ]);
  });

  it('returns empty for an all-blank list', () => {
    expect(normalizeAsins(['', '   ', '\t'])).toEqual([]);
  });

  it('returns empty (no throw) for a non-array input', () => {
    expect(normalizeAsins(undefined as unknown as string[])).toEqual([]);
    expect(normalizeAsins(null as unknown as string[])).toEqual([]);
  });
});

describe('resolveAsinTitles', () => {
  beforeEach(() => mockedRunQuery.mockReset());

  it('short-circuits with no query when the ASIN list is empty', async () => {
    const r = await resolveAsinTitles({ sellerId: 1, asins: ['', '  '] });
    expect(r).toMatchObject({ ok: true, titles: [], missing: [] });
    expect(mockedRunQuery).not.toHaveBeenCalled();
  });

  it('rejects over-cap batches without hitting the warehouse', async () => {
    const asins = Array.from({ length: 1001 }, (_, i) => `B0${i}`);
    const r = await resolveAsinTitles({ sellerId: 1, asins });
    expect(r.ok).toBe(false);
    expect(mockedRunQuery).not.toHaveBeenCalled();
  });

  it('maps rows to titles and partitions the un-found ASINs into missing', async () => {
    mockedRunQuery.mockResolvedValue({
      ok: true,
      rows: [
        { asin: 'B0ABC', title: 'Widget A', brand: 'Acme' },
        { asin: 'B0XYZ', title: 'Widget X', brand: null },
      ],
      rowCount: 2,
      durationMs: 3,
    });

    const r = await resolveAsinTitles({ sellerId: 42, asins: ['b0abc', 'B0XYZ', 'B0MISSING'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.titles).toEqual([
      { asin: 'B0ABC', title: 'Widget A', brand: 'Acme', source: 'mws_items' },
      { asin: 'B0XYZ', title: 'Widget X', brand: null, source: 'mws_items' },
    ]);
    expect(r.missing).toEqual(['B0MISSING']);
  });

  it('passes seller + deduped ASINs as params twice (outer filter + inner max-ts subquery)', async () => {
    mockedRunQuery.mockResolvedValue({ ok: true, rows: [], rowCount: 0, durationMs: 1 });
    await resolveAsinTitles({ sellerId: 7, asins: ['B0ABC', 'b0abc', 'B0XYZ'] });
    expect(mockedRunQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockedRunQuery.mock.calls[0]!;
    expect(sql).toContain('FROM mws_items');
    expect(sql).toContain('MAX(dtUpdatedOn)');
    // deduped to [B0ABC, B0XYZ], repeated for the two IN-lists, seller before each
    expect(params).toEqual([7, 'B0ABC', 'B0XYZ', 7, 'B0ABC', 'B0XYZ']);
  });

  it('propagates a query failure as a typed failure result', async () => {
    mockedRunQuery.mockResolvedValue({
      ok: false,
      kind: 'access_denied_db',
      message: 'raw',
      friendly: 'You do not have read access to mws_items.',
      durationMs: 2,
    });
    const r = await resolveAsinTitles({ sellerId: 1, asins: ['B0ABC'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.friendly).toMatch(/read access/);
    // kind is preserved so the subcommand can route the exit code like siblings
    expect(r.kind).toBe('access_denied_db');
  });
});
