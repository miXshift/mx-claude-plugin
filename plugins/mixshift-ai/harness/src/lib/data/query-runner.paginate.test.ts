import { describe, it, expect } from 'vitest';
import {
  paginateOverCap,
  isServiceCapFailure,
  SERVICE_ROW_CAP,
  type DataQueryResult,
} from './query-runner.js';

/** n synthetic 2-column rows. */
function rows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ a: i, b: 'x' }));
}

const okResult = (
  r: Array<Record<string, unknown>>,
): DataQueryResult<Record<string, unknown>> => ({
  ok: true,
  rows: r,
  rowCount: r.length,
  durationMs: 1,
});

describe('isServiceCapFailure', () => {
  it('matches the gateway cap rejection across both phrasings/fields', () => {
    // Raw `message` phrasing (what runQuery actually receives).
    expect(
      isServiceCapFailure({
        ok: false,
        kind: 'unknown',
        message: 'Query returned 57464 rows; service cap is 50000.',
        friendly: '',
        durationMs: 1,
      }),
    ).toBe(true);
    // `friendly` phrasing with a generic `message`.
    expect(
      isServiceCapFailure({
        ok: false,
        kind: 'unknown',
        message: 'Query failed',
        friendly: 'Query returned 57,464 rows, which exceeds the service cap of 50,000.',
        durationMs: 1,
      }),
    ).toBe(true);
    expect(
      isServiceCapFailure({ ok: false, kind: 'timeout', message: 'timed out', friendly: 'timed out', durationMs: 1 }),
    ).toBe(false);
    expect(isServiceCapFailure(okResult(rows(3)))).toBe(false);
  });
});

describe('paginateOverCap', () => {
  it('pages a cap-exceeding SELECT with a stable order and concatenates', async () => {
    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1)); // column probe → 2 cols
      if (/OFFSET 0$/.test(pageSql)) return okResult(rows(SERVICE_ROW_CAP)); // full page → more
      return okResult(rows(3)); // OFFSET 50000 → short page → stop
    };
    const r = await paginateOverCap('SELECT a, b FROM t WHERE x = ?', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(SERVICE_ROW_CAP + 3);
    expect(calls.length).toBe(3); // probe + 2 pages
    // Stable, deterministic order by every output column (2) by position.
    expect(calls[1]).toContain('ORDER BY 1, 2');
    expect(calls[1]).toContain(`LIMIT ${SERVICE_ROW_CAP} OFFSET 0`);
    expect(calls[2]).toContain(`OFFSET ${SERVICE_ROW_CAP}`);
  });

  it('returns a single short page without over-fetching', async () => {
    let pages = 0;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      pages += 1;
      return okResult(rows(120)); // < cap → done after one page
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(120);
    expect(pages).toBe(1);
  });

  it('shrinks the page size when a page trips the byte cap, then continues', async () => {
    const limits: number[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1)); // column probe
      const lim = Number(pageSql.match(/LIMIT (\d+)/)?.[1] ?? 0);
      limits.push(lim);
      // Full-size page trips the 10 MB byte cap; the halved window fits.
      if (lim > SERVICE_ROW_CAP / 2) {
        return {
          ok: false,
          kind: 'unknown',
          message: 'Query result serializes to 10.4 MB; service cap is 10.0 MB.',
          friendly: '',
          durationMs: 1,
        } as DataQueryResult<Record<string, unknown>>;
      }
      return okResult(rows(120)); // short page at the smaller size → done
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(120);
    expect(limits).toContain(SERVICE_ROW_CAP); // tried full size
    expect(limits).toContain(SERVICE_ROW_CAP / 2); // shrank, then succeeded
  });

  it('refuses to paginate a non-SELECT statement', async () => {
    const r = await paginateOverCap('UPDATE t SET x = 1', async () => okResult([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not a\s+SELECT/i);
  });

  it('bubbles up a page-level failure instead of returning partial data', async () => {
    const exec = async (pageSql: string) =>
      /LIMIT 1$/.test(pageSql)
        ? okResult(rows(1))
        : ({ ok: false, kind: 'timeout', message: 'timed out', friendly: 'timed out', durationMs: 1 } as DataQueryResult<Record<string, unknown>>);
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });
});
