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

  it('NO user ORDER BY + bare LIMIT N: strips the LIMIT, pages a positional total order, delivers a deterministic complete first-N with no dupes', async () => {
    // A bare `LIMIT N` with NO ORDER BY (the `data export --max-rows N` shape).
    // Keeping the LIMIT inside would let the DB pick an arbitrary N-row set that
    // varies per page re-execution. The pager must STRIP the LIMIT and page the
    // unlimited inner query under a positional total order, honoring N as a cap.
    const M = 30_000; // base table size, larger than N
    const N = 12_000; // the user's bare LIMIT
    const cols = ['a', 'b'];
    // `a` is a permutation of 0..M-1 (gcd(7, 30000)=1), scrambled vs insertion
    // order, so "first N under ORDER BY 1,2" is a real reordering (and unique).
    const base = Array.from({ length: M }, (_, i) => ({ a: (i * 7) % M, b: `k${i % 5}` }));

    const dataCalls: string[] = [];
    const run = async (): Promise<Array<Record<string, unknown>>> => {
      const got: Array<Record<string, unknown>> = [];
      const exec = async (pageSql: string) => {
        if (/LIMIT 1$/.test(pageSql)) return okResult([base[0]!]); // probe → 2 cols
        dataCalls.push(pageSql);
        // Underlying row source is FIXED; the OUTER positional order governs
        // which rows land in each OFFSET window.
        const ordered = applyOrder(base, orderByOf(pageSql), cols);
        return okResult(ordered.slice(outerOffsetOf(pageSql), outerOffsetOf(pageSql) + outerLimitOf(pageSql)));
      };
      const r = await paginateOverCap('SELECT a, b FROM big LIMIT 12000', exec, {
        onPage: (page) => {
          got.push(...page);
        },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.rowCount).toBe(N); // N honored as a hard row cap
        expect(r.outputOrderPositional).toBe(true); // no user order → positional
        expect(r.boundaryTiesMayVary).toBeFalsy(); // positional total order is tie-free
      }
      return got;
    };

    const collected = await run();
    // The user's bare LIMIT is STRIPPED from the inner query (not kept inside),
    // and every page runs under the positional total order `ORDER BY 1, 2`.
    for (const c of dataCalls) {
      expect(c).toContain('FROM (SELECT a, b FROM big) AS _mx_page');
      expect(c).not.toContain('LIMIT 12000)'); // the user LIMIT is gone from the derived table
      expect(orderByOf(c)).toBe('1, 2');
    }
    // Delivered set is EXACTLY the first N under the imposed positional total
    // order — complete, no skips, no duplicates.
    const expected = applyOrder(base, '1, 2', cols).slice(0, N);
    expect(collected).toEqual(expected);
    expect(new Set(collected.map((r) => r.a)).size).toBe(N); // no duplicate rows

    // Re-running the identical query yields the identical set (deterministic
    // across page re-executions, which is the whole point of the total order).
    const collected2 = await run();
    expect(collected2).toEqual(collected);
  });

  it('ignores an ORDER BY that appears only inside a SQL comment (picks the no-ORDER-BY strategy)', async () => {
    // A comment containing the words "ORDER BY" must NOT be mistaken for a real
    // top-level clause: doing so would keep the LIMIT inside the derived table
    // (the has-ORDER-BY path) and page a non-total order nondeterministically.
    // With no REAL order, the pager must take the strip-and-positional path.
    const M = 20_000;
    const N = 8_000;
    const cols = ['a', 'b'];
    const base = Array.from({ length: M }, (_, i) => ({ a: (i * 7) % M, b: `k${i % 5}` }));
    const dataCalls: string[] = [];
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult([base[0]!]);
      dataCalls.push(pageSql);
      const ordered = applyOrder(base, orderByOf(pageSql), cols);
      return okResult(ordered.slice(outerOffsetOf(pageSql), outerOffsetOf(pageSql) + outerLimitOf(pageSql)));
    };
    const got: Array<Record<string, unknown>> = [];
    // Block comment (not a line comment, which would comment out the wrapping);
    // it contains "ORDER BY a DESC" but the statement has no real ORDER BY.
    const r = await paginateOverCap(
      'SELECT a, b FROM big /* ORDER BY a DESC */ LIMIT 8000',
      exec,
      { onPage: (page) => { got.push(...page); } },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rowCount).toBe(N);
      // The comment's ORDER BY was ignored → no-ORDER-BY strategy → positional.
      expect(r.outputOrderPositional).toBe(true);
      expect(r.boundaryTiesMayVary).toBeFalsy();
    }
    for (const c of dataCalls) {
      expect(c).not.toContain('LIMIT 8000)'); // bare LIMIT stripped from the inner query
      expect(orderByOf(c)).toBe('1, 2'); // paged under the imposed positional total order
    }
    expect(got).toEqual(applyOrder(base, '1, 2', cols).slice(0, N));
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

  it('FINDING 1 (row-cap trip): an ordered top-N returns the true top-N by the user order, not the positional-first N', async () => {
    // Row-cap sibling of the byte-cap test above: an ordered `... ORDER BY spend
    // DESC LIMIT K` paged over the ordinary (non-shrinking) path. The delivered
    // SET must be the user's true top-N by spend, not the positional-first N.
    const NBASE = 200;
    const K = 120;
    const cols = ['id', 'spend'];
    // spend is a permutation of id (gcd(37,200)=1), so top-N by spend is a
    // scattered id set distinct from ids 0..K-1.
    const base = Array.from({ length: NBASE }, (_, id) => ({ id, spend: (id * 37) % NBASE }));
    const mat = [...base].sort((a, b) => b.spend - a.spend).slice(0, K);

    const collected: Array<Record<string, unknown>> = [];
    let sawInnerLimit = false;
    const exec = async (pageSql: string) => {
      if (/LIMIT 1$/.test(pageSql)) return okResult([mat[0]!]); // probe → 2 cols
      if (pageSql.includes('FROM (SELECT id, spend FROM t ORDER BY spend DESC LIMIT 120) AS _mx_page')) {
        sawInnerLimit = true;
      }
      const ordered = applyOrder(mat, orderByOf(pageSql), cols);
      return okResult(ordered.slice(outerOffsetOf(pageSql), outerOffsetOf(pageSql) + outerLimitOf(pageSql)));
    };

    const r = await paginateOverCap('SELECT id, spend FROM t ORDER BY spend DESC LIMIT 120', exec, {
      onPage: (page) => {
        collected.push(...page);
      },
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rowCount).toBe(K);
      expect(r.outputOrderPositional).toBe(false); // user ORDER BY carried
      expect(r.boundaryTiesMayVary).toBe(true); // capped result + user ORDER BY
    }
    expect(sawInnerLimit).toBe(true); // the user LIMIT stayed INSIDE the derived table
    // Delivered SET + order is EXACTLY the user's top-N by spend...
    expect(collected.map((row) => row.id)).toEqual(mat.map((row) => row.id));
    // ...and emphatically NOT the positional-first N (ids 0..K-1).
    const positionalFirst = Array.from({ length: K }, (_, i) => i);
    expect(collected.map((row) => row.id)).not.toEqual(positionalFirst);
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

// ---------------------------------------------------------------------------
// Track B: the gateway cap rejection can carry actualRowCount/actualBytes. When
// present, the pager sizes its FIRST page from the real bytes/row instead of
// starting at FIRST_PAGE_PROBE_ROWS and halving down on a wide result.
// ---------------------------------------------------------------------------

describe('paginateOverCap size hint (Track B)', () => {
  it('sizes the first data page from a byte hint, skipping the 5000-row probe', async () => {
    // bytesPerRow = 8000 → pageSize = floor(PAGE_BYTE_BUDGET / 8000).
    const bytesPerRow = 8000;
    const rowCount = 1000;
    const expectedFirstPage = Math.floor(PAGE_BYTE_BUDGET / bytesPerRow);

    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1)); // column probe
      if (offsetOf(pageSql) === 0) return okResult(rows(outerLimitOf(pageSql))); // full first page
      return okResult(rows(3)); // short second page → stop
    };

    const r = await paginateOverCap('SELECT a, b FROM t', exec, {
      sizeHint: { rowCount, bytes: rowCount * bytesPerRow },
    });

    expect(r.ok).toBe(true);
    // The first data page used the HINT-derived size, not FIRST_PAGE_PROBE_ROWS.
    expect(expectedFirstPage).not.toBe(FIRST_PAGE_PROBE_ROWS);
    expect(outerLimitOf(calls[1]!)).toBe(expectedFirstPage);
  });

  it('never exceeds PAGE_MAX_ROWS even for a tiny bytes/row hint', async () => {
    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      if (offsetOf(pageSql) === 0) return okResult(rows(3)); // short → stop after one page
      return okResult(rows(0));
    };
    // 1 byte/row would imply an enormous page; must clamp to PAGE_MAX_ROWS.
    await paginateOverCap('SELECT a, b FROM t', exec, {
      sizeHint: { rowCount: 1_000_000, bytes: 1_000_000 },
    });
    expect(outerLimitOf(calls[1]!)).toBe(PAGE_MAX_ROWS);
  });

  it('falls back to the probe size when the hint is incomplete (bytes only)', async () => {
    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      if (offsetOf(pageSql) === 0) return okResult(rows(3));
      return okResult(rows(0));
    };
    // rowCount missing → cannot compute bytes/row → probe as usual.
    await paginateOverCap('SELECT a, b FROM t', exec, {
      sizeHint: { bytes: 9_000_000 },
    });
    expect(outerLimitOf(calls[1]!)).toBe(FIRST_PAGE_PROBE_ROWS);
  });

  it('falls back to the probe size when no hint is given', async () => {
    const calls: string[] = [];
    const exec = async (pageSql: string) => {
      calls.push(pageSql);
      if (/LIMIT 1$/.test(pageSql)) return okResult(rows(1));
      if (offsetOf(pageSql) === 0) return okResult(rows(3));
      return okResult(rows(0));
    };
    await paginateOverCap('SELECT a, b FROM t', exec);
    expect(outerLimitOf(calls[1]!)).toBe(FIRST_PAGE_PROBE_ROWS);
  });
});
