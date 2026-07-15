import { describe, it, expect } from 'vitest';
import {
  paginateOverCap,
  isServiceCapFailure,
  SERVICE_ROW_CAP,
  PAGE_MAX_ROWS,
  PAGE_BYTE_BUDGET,
  FIRST_PAGE_PROBE_ROWS,
  type DataQueryResult,
} from './query-runner.js';

/** n synthetic 2-column narrow rows. */
function rows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ a: i, b: 'x' }));
}

/** n synthetic rows whose second column is `width` bytes wide. */
function wideRows(off: number, n: number, width: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ a: off + i, b: 'x'.repeat(width) }));
}

const okResult = (
  r: Array<Record<string, unknown>>,
): DataQueryResult<Record<string, unknown>> => ({
  ok: true,
  rows: r,
  rowCount: r.length,
  durationMs: 1,
});

const capFailure = (): DataQueryResult<Record<string, unknown>> => ({
  ok: false,
  kind: 'unknown',
  message: 'Query result serializes to 10.4 MB; service cap of 10.0 MB.',
  friendly: '',
  durationMs: 1,
});

function limitOf(sql: string): number {
  return Number(sql.match(/LIMIT (\d+)/)?.[1] ?? 0);
}
function offsetOf(sql: string): number {
  return Number(sql.match(/OFFSET (\d+)/)?.[1] ?? 0);
}

describe('isServiceCapFailure', () => {
  it('matches the gateway cap rejection across both phrasings/fields', () => {
    expect(
      isServiceCapFailure({
        ok: false,
        kind: 'unknown',
        message: 'Query returned 57464 rows; service cap is 50000.',
        friendly: '',
        durationMs: 1,
      }),
    ).toBe(true);
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
  it('pages with a stable order, a conservative first probe, then concatenates', async () => {
    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1)); // column probe → 2 cols
      if (offsetOf(pageSql) === 0) return okResult(rows(FIRST_PAGE_PROBE_ROWS)); // full first page
      return okResult(rows(3)); // second page short → stop
    };
    const r = await paginateOverCap('SELECT a, b FROM t WHERE x = ?', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(FIRST_PAGE_PROBE_ROWS + 3);
    expect(calls.length).toBe(3); // probe + 2 pages
    // Stable, deterministic order by every output column (2) by position.
    expect(calls[1]).toContain('ORDER BY 1, 2');
    // First data page is the conservative probe size, NOT the 50k row cap.
    expect(calls[1]).toContain(`LIMIT ${FIRST_PAGE_PROBE_ROWS} OFFSET 0`);
    // Having measured narrow rows, the next page jumps to the row cap.
    expect(calls[2]).toContain(`LIMIT ${PAGE_MAX_ROWS} OFFSET ${FIRST_PAGE_PROBE_ROWS}`);
  });

  it('returns a single short page without over-fetching', async () => {
    let pages = 0;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      pages += 1;
      return okResult(rows(120)); // < probe size → done after one page
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(120);
    expect(pages).toBe(1);
  });

  it('sizes pages from the observed byte width (byte budget), not a fixed row count', async () => {
    // ~1 KB rows: the budget should target ~8 MB / ~1 KB ≈ 8k rows per page,
    // well under the 50k row cap. This is the byte-budget behavior.
    const WIDTH = 1024;
    const TOTAL = 30_000;
    const sizes: number[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(wideRows(0, 1, WIDTH));
      const lim = limitOf(pageSql);
      const off = offsetOf(pageSql);
      sizes.push(lim);
      const give = Math.min(lim, Math.max(0, TOTAL - off));
      return okResult(wideRows(off, give, WIDTH));
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(TOTAL);
    expect(sizes[0]).toBe(FIRST_PAGE_PROBE_ROWS); // conservative first probe
    // Subsequent pages are budget-derived, between the probe size and the cap.
    expect(sizes[1]).toBeGreaterThan(FIRST_PAGE_PROBE_ROWS);
    expect(sizes[1]).toBeLessThan(PAGE_MAX_ROWS);
    // Sanity: the budget-derived size is near 8 MB / ~1 KB.
    expect(sizes[1]).toBeGreaterThan(6_000);
    expect(sizes[1]).toBeLessThan(9_000);
  });

  it('shrinks page size below the retired 1000-row floor for ultra-wide rows and completes', async () => {
    // Simulate a gateway that rejects any page serializing to more than the
    // byte budget. Rows are ~12 KB, so only a few hundred fit per page — the
    // exact case the old 1000-row floor turned into an outright failure.
    const SERVER_BYTE_CAP = 10 * 1024 * 1024;
    const WIDTH = 12_000;
    const TOTAL = 2_000;
    const requested: number[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(wideRows(0, 1, WIDTH));
      const lim = limitOf(pageSql);
      const off = offsetOf(pageSql);
      requested.push(lim);
      const give = Math.min(lim, Math.max(0, TOTAL - off));
      const page = wideRows(off, give, WIDTH);
      const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (bytes > SERVER_BYTE_CAP) return capFailure();
      return okResult(page);
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(TOTAL);
    // It shrank the request well below the retired 1000-row floor.
    expect(Math.min(...requested)).toBeLessThan(1_000);
  });

  it('honors a user outer LIMIT as a hard cap and strips it from the paged subquery', async () => {
    const dataCalls: string[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      dataCalls.push(pageSql);
      // Pretend the table is effectively infinite: always fill the page.
      return okResult(rows(limitOf(pageSql)));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 12000', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(12_000); // capped at the user LIMIT, not run forever
    // The user LIMIT is stripped from the wrapped subquery — no LIMIT inside
    // the derived table (which would re-limit non-deterministically per page).
    for (const c of dataCalls) {
      expect(c).toContain('FROM (SELECT a, b FROM big) AS _mx_page');
    }
  });

  it('honors LIMIT with OFFSET: paging starts at the user offset and caps the count', async () => {
    const offsets: number[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      offsets.push(offsetOf(pageSql));
      return okResult(rows(limitOf(pageSql)));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 8000 OFFSET 100', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(8_000);
    expect(offsets[0]).toBe(100); // paging begins at the user OFFSET
  });

  it('parses the MySQL `LIMIT offset, count` form', async () => {
    const offsets: number[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      offsets.push(offsetOf(pageSql));
      return okResult(rows(limitOf(pageSql)));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 100, 8000', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(8_000);
    expect(offsets[0]).toBe(100);
  });

  it('streams pages via onPage without buffering (returned rows array is empty)', async () => {
    const seen: Array<[number, number]> = [];
    const collected: Array<Record<string, unknown>> = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      if (offsetOf(pageSql) === 0) return okResult(rows(FIRST_PAGE_PROBE_ROWS));
      return okResult(rows(42));
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec, {
      onPage: (page, idx) => {
        seen.push([idx, page.length]);
        collected.push(...page);
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rowCount).toBe(FIRST_PAGE_PROBE_ROWS + 42);
      expect(r.rows).toEqual([]); // streamed, not buffered
    }
    expect(seen).toEqual([[0, FIRST_PAGE_PROBE_ROWS], [1, 42]]);
    expect(collected.length).toBe(FIRST_PAGE_PROBE_ROWS + 42);
  });

  it('applies a caller maxRows cap (combined with any user LIMIT)', async () => {
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      return okResult(rows(limitOf(pageSql)));
    };
    const r = await paginateOverCap('SELECT a, b FROM big', exec, { maxRows: 7_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(7_000);
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

  it('still exposes SERVICE_ROW_CAP as the row-cap ceiling', () => {
    expect(PAGE_MAX_ROWS).toBe(SERVICE_ROW_CAP);
    expect(PAGE_BYTE_BUDGET).toBeLessThan(10 * 1024 * 1024);
  });
});
