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
/** The OUTER (statement-final) page LIMIT/OFFSET. With the user's own LIMIT now
 *  kept INSIDE the derived table, the first `LIMIT` in a page SQL can be the
 *  inner one, so these anchor to the trailing `LIMIT n OFFSET m` the pager adds. */
function outerLimitOf(sql: string): number {
  return Number(sql.match(/LIMIT (\d+) OFFSET \d+\s*$/)?.[1] ?? 0);
}
function outerOffsetOf(sql: string): number {
  return Number(sql.match(/OFFSET (\d+)\s*$/)?.[1] ?? 0);
}
function orderByOf(sql: string): string {
  // The OUTER (trailing) ORDER BY only — `[^()]` skips the inner derived-table
  // ORDER BY, which is wrapped in parentheses.
  return sql.match(/ORDER BY ([^()]+?) LIMIT \d+ OFFSET \d+\s*$/)?.[1] ?? '';
}
/** Faithfully sort a row list by a positional outer ORDER BY (e.g. "2 DESC, 1, 2"). */
function applyOrder(
  list: Array<Record<string, unknown>>,
  orderBy: string,
  cols: string[],
): Array<Record<string, unknown>> {
  const parsed = orderBy
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /^(\d+)(?:\s+(asc|desc))?$/i.exec(t)!;
      return { key: cols[Number(m[1]) - 1]!, dir: (m[2] ?? 'ASC').toUpperCase() };
    });
  return [...list].sort((a, b) => {
    for (const { key, dir } of parsed) {
      const av = a[key] as number | string;
      const bv = b[key] as number | string;
      if (av < bv) return dir === 'DESC' ? 1 : -1;
      if (av > bv) return dir === 'DESC' ? -1 : 1;
    }
    return 0;
  });
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

  it('keeps the user LIMIT INSIDE the derived table and stops at N via a short page', async () => {
    const dataCalls: string[] = [];
    const INNER = 12_000; // the user LIMIT — materialized inside the derived table
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      dataCalls.push(pageSql);
      const off = outerOffsetOf(pageSql);
      const lim = outerLimitOf(pageSql);
      return okResult(rows(Math.min(lim, Math.max(0, INNER - off))));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 12000', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(12_000); // stops at N via the derived-table LIMIT
    // The user LIMIT is KEPT inside the wrapped subquery so the correct top-N
    // SET is materialized; the inner LIMIT self-terminates paging (short page).
    for (const c of dataCalls) {
      expect(c).toContain('FROM (SELECT a, b FROM big LIMIT 12000) AS _mx_page');
    }
  });

  it('keeps LIMIT+OFFSET inside the derived table; outer paging starts at 0', async () => {
    const dataCalls: string[] = [];
    const INNER = 8_000; // rows the derived table yields after its own LIMIT/OFFSET
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      dataCalls.push(pageSql);
      const off = outerOffsetOf(pageSql);
      const lim = outerLimitOf(pageSql);
      return okResult(rows(Math.min(lim, Math.max(0, INNER - off))));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 8000 OFFSET 100', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(8_000);
    // The user OFFSET is applied inside the derived table, so outer paging must
    // begin at 0 (never re-apply the offset, which would double-skip rows).
    expect(outerOffsetOf(dataCalls[0]!)).toBe(0);
    for (const c of dataCalls) {
      expect(c).toContain('FROM (SELECT a, b FROM big LIMIT 8000 OFFSET 100) AS _mx_page');
    }
  });

  it('parses the MySQL `LIMIT offset, count` form and keeps it inside the derived table', async () => {
    const dataCalls: string[] = [];
    const INNER = 8_000;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      dataCalls.push(pageSql);
      const off = outerOffsetOf(pageSql);
      const lim = outerLimitOf(pageSql);
      return okResult(rows(Math.min(lim, Math.max(0, INNER - off))));
    };
    const r = await paginateOverCap('SELECT a, b FROM big LIMIT 100, 8000', exec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rowCount).toBe(8_000);
    expect(outerOffsetOf(dataCalls[0]!)).toBe(0);
    for (const c of dataCalls) {
      expect(c).toContain('FROM (SELECT a, b FROM big LIMIT 100, 8000) AS _mx_page');
    }
  });

  it('FINDING 1 (byte-cap trip): an ordered top-N export returns the true top-N by the user order, not the positional-first N', async () => {
    // Base table whose spend is a permutation of id, so "top-N by spend" is a
    // scattered set of ids that is DIFFERENT from the positional-first N (ids
    // 0..K-1). Wide filler forces the byte cap to trip and the pager to shrink.
    const N = 3_000;
    const K = 2_000;
    const FILLER = 'x'.repeat(12_000);
    const SERVER_BYTE_CAP = 10 * 1024 * 1024;
    const cols = ['id', 'spend', 'filler'];
    const base = Array.from({ length: N }, (_, id) => ({ id, spend: (id * 37) % N, filler: FILLER }));
    // The derived table = user's `... ORDER BY spend DESC LIMIT K`.
    const mat = [...base].sort((a, b) => b.spend - a.spend).slice(0, K);

    const collected: Array<Record<string, unknown>> = [];
    let sawInnerLimit = false;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult([mat[0]!]); // probe → 3 cols
      if (pageSql.includes('FROM (SELECT id, spend FROM t ORDER BY spend DESC LIMIT 2000) AS _mx_page')) {
        sawInnerLimit = true;
      }
      const lim = outerLimitOf(pageSql);
      const off = outerOffsetOf(pageSql);
      const ordered = applyOrder(mat, orderByOf(pageSql), cols);
      const page = ordered.slice(off, off + lim);
      const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (bytes > SERVER_BYTE_CAP) return capFailure(); // byte-cap trip → shrink
      return okResult(page);
    };

    const r = await paginateOverCap('SELECT id, spend FROM t ORDER BY spend DESC LIMIT 2000', exec, {
      onPage: (page) => {
        collected.push(...page);
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rowCount).toBe(K);
      // User order preserved → NOT flagged positional.
      expect(r.outputOrderPositional).toBe(false);
    }
    expect(sawInnerLimit).toBe(true); // the user LIMIT stayed inside the derived table
    // The delivered ROW SET (and order) is exactly the user's top-N by spend.
    expect(collected.map((row) => row.id)).toEqual(mat.map((row) => row.id));
    // And it is emphatically NOT the positional-first N (ids 0..K-1).
    const positionalFirst = Array.from({ length: K }, (_, i) => i);
    expect(collected.map((row) => row.id)).not.toEqual(positionalFirst);
    // Sanity: spend is strictly descending across the whole delivered set.
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i]!.spend as number).toBeLessThan(collected[i - 1]!.spend as number);
    }
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

  it('FINDING 1 (positional fallback): a non-carryable ORDER BY still returns the correct SET, flagged positional', async () => {
    // An ORDER BY with a function call cannot be safely carried to the outer
    // paging query, so the pager falls back to positional order. The delivered
    // SET is still correct; only the output order is positional.
    const orders: string[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      orders.push(orderByOf(pageSql));
      if (outerOffsetOf(pageSql) === 0) return okResult(rows(FIRST_PAGE_PROBE_ROWS));
      return okResult(rows(5)); // short page → stop
    };
    const r = await paginateOverCap('SELECT a, b FROM t ORDER BY LOWER(b) DESC', exec);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rowCount).toBe(FIRST_PAGE_PROBE_ROWS + 5);
      expect(r.outputOrderPositional).toBe(true); // could not carry the user order
    }
    expect(orders[0]).toBe('1, 2'); // purely positional outer order
  });

  it('FINDING 5: fails with non-convergence when the iteration guard is exhausted without a short page', async () => {
    // Unbounded query whose pages never shorten (every page returns exactly the
    // requested count) and never reach the MAX_PAGINATED_ROWS ceiling because
    // the byte cap pins each page to a single row. This must FAIL as
    // non-convergence, not silently return a truncated tail as success.
    const W = 200;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult(wideRows(0, 1, W));
      const lim = outerLimitOf(pageSql);
      if (lim > 1) return capFailure(); // force shrink to a 1-row page every time
      return okResult(wideRows(0, 1, W)); // exactly 1 full row → never a short page
    };
    const r = await paginateOverCap('SELECT a, b FROM t', exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/did not converge/i);
  });

  it('still exposes SERVICE_ROW_CAP as the row-cap ceiling', () => {
    expect(PAGE_MAX_ROWS).toBe(SERVICE_ROW_CAP);
    expect(PAGE_BYTE_BUDGET).toBeLessThan(10 * 1024 * 1024);
  });
});
