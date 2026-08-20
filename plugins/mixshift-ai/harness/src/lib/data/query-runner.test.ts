import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runQuery, streamQuery, FIRST_PAGE_PROBE_ROWS } from './query-runner.js';
import { createCsvFileSink } from '../output/csv-file-sink.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-runner-test-'));
  _refreshState.inFlight = null;
});

afterEach(async () => {
  // Windows occasionally holds file handles longer than the test
  // teardown; one retry is sufficient for the flaky-rmdir ENOTEMPTY
  // pattern we see when datahub creds were written + read in the same
  // test. Swallow the second-try error if it lingers (the OS will
  // eventually clean the temp dir).
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Datahub: happy path
// ---------------------------------------------------------------------------

describe('runQuery :: datahub happy path', () => {
  it('returns rows from the server (passes auth_path: datahub)', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        rows: [{ ok: 1, db_time: '2026-05-27 08:23:14' }],
        rowCount: 1,
        durationMs: 460,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(1);
      expect(result.rows).toEqual([{ ok: 1, db_time: '2026-05-27 08:23:14' }]);
      expect(result.durationMs).toBe(460);
    }

    // /api/query called once with Bearer
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mcp.mixshift.io/api/query');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${creds.access_token}`,
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.sql).toBe('SELECT 1');
  });
});

// ---------------------------------------------------------------------------
// Datahub: x-mixshift-intent attribution header
// ---------------------------------------------------------------------------

describe('runQuery :: intent header', () => {
  const INTENT_VAR = 'MIXSHIFT_INTENT';
  const SKILL_VAR = 'MIXSHIFT_SKILL_ID';
  let savedIntent: string | undefined;
  let savedSkill: string | undefined;

  beforeEach(() => {
    savedIntent = process.env[INTENT_VAR];
    savedSkill = process.env[SKILL_VAR];
    delete process.env[INTENT_VAR];
    delete process.env[SKILL_VAR];
  });

  afterEach(() => {
    if (savedIntent === undefined) delete process.env[INTENT_VAR];
    else process.env[INTENT_VAR] = savedIntent;
    if (savedSkill === undefined) delete process.env[SKILL_VAR];
    else process.env[SKILL_VAR] = savedSkill;
  });

  it('sends x-mixshift-intent when MIXSHIFT_SKILL_ID is set', async () => {
    process.env[SKILL_VAR] = 'mx-data-explore';
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    const [, init] = mockFetch.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({
      'x-mixshift-intent': 'mx-data-explore',
    });
  });

  it('omits x-mixshift-intent entirely when no skill/intent env is set', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    const [, init] = mockFetch.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty('x-mixshift-intent');
  });
});

// ---------------------------------------------------------------------------
// Datahub: mid-session 401 → force-refresh → retry
// ---------------------------------------------------------------------------

describe('runQuery :: datahub 401 retry', () => {
  it('force-refreshes the token on 401 and retries once', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    let queryCalls = 0;
    let refreshCalls = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/query')) {
        queryCalls++;
        if (queryCalls === 1) return jsonResponse(401, { ok: false });
        return jsonResponse(200, {
          ok: true,
          rows: [{ ok: 1 }],
          rowCount: 1,
          durationMs: 100,
        });
      }
      if (u.endsWith('/auth/refresh')) {
        refreshCalls++;
        return jsonResponse(200, {
          ok: true,
          access_token: 'fresh-access',
          refresh_token: 'fresh-refresh',
          expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          user_id: '3',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(true);
    expect(queryCalls).toBe(2);
    expect(refreshCalls).toBe(1);

    // Second /api/query used the fresh token
    const secondQueryInit = mockFetch.mock.calls.find(
      ([u], i) => String(u).endsWith('/api/query') && i > 0,
    )?.[1] as RequestInit | undefined;
    expect(secondQueryInit?.headers).toMatchObject({
      Authorization: 'Bearer fresh-access',
    });
  });

  it('throws "Run mixshift auth login" when refresh + retry both 401', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/query')) return jsonResponse(401, { ok: false });
      if (u.endsWith('/auth/refresh')) {
        return jsonResponse(200, {
          ok: true,
          access_token: 'still-stale',
          refresh_token: 'r',
          expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
          user_id: '3',
        });
      }
      throw new Error(`unexpected: ${u}`);
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown'); // wrapper around the throw
      expect(result.message).toMatch(/session expired.*auth login/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Datahub: server-side classified errors pass through
// ---------------------------------------------------------------------------

describe('runQuery :: datahub error envelope', () => {
  it('passes server access_denied_table envelope through', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: false,
        kind: 'access_denied_table',
        table_name: 'campaigns',
        raw_code: 'ER_TABLEACCESS_DENIED_ERROR',
        message: "SELECT command denied to user 'foo'@'1.2.3.4' for table 'campaigns'",
        friendly:
          'Your MySQL user does not have SELECT permission on `campaigns`. ' +
          'Send a table-access request to MixShift ops.',
        durationMs: 12,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT * FROM campaigns', [], {
      dataDirOverride: testDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('access_denied_table');
      expect(result.table_name).toBe('campaigns');
      expect(result.friendly).toMatch(/SELECT permission on `campaigns`/);
      expect(result.raw_code).toBe('ER_TABLEACCESS_DENIED_ERROR');
    }
  });

  it('threads the gateway cap size hint into the pager so the first page is right-sized (Track B)', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    // 10k rows @ 8000 bytes/row → the pager should size its first page at
    // floor(PAGE_BYTE_BUDGET / 8000) = 1048, NOT the 5000-row probe (which for
    // a wide result would trip the 10 MB cap and halve down ~log2(N) times).
    const expectedFirstPage = 1048;
    const sqls: string[] = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sql = JSON.parse(String(init?.body)).sql as string;
      sqls.push(sql);
      if (!/_mx_page/.test(sql)) {
        // Initial user query → gateway cap rejection carrying the size hint.
        return jsonResponse(200, {
          ok: false,
          kind: 'response_too_large',
          message: 'Serialized response 80000000 bytes exceeds cap 10485760.',
          friendly:
            "This query's result is over the 10.0 MB service cap. Select fewer columns.",
          durationMs: 1,
          actualRowCount: 10_000,
          actualBytes: 10_000 * 8000,
        });
      }
      if (/LIMIT 1$/.test(sql)) {
        // Column probe.
        return jsonResponse(200, { ok: true, rows: [{ a: 1, b: 2 }], rowCount: 1, durationMs: 1 });
      }
      // First data page → short page so paging stops after one page.
      return jsonResponse(200, {
        ok: true,
        rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }],
        rowCount: 3,
        durationMs: 1,
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT * FROM t', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rowCount).toBe(3);
    // The first data page used the hint-derived size, not FIRST_PAGE_PROBE_ROWS.
    expect(expectedFirstPage).not.toBe(FIRST_PAGE_PROBE_ROWS);
    expect(sqls.some((s) => /LIMIT 1048 OFFSET 0/.test(s))).toBe(true);
    expect(sqls.some((s) => new RegExp(`LIMIT ${FIRST_PAGE_PROBE_ROWS} OFFSET 0`).test(s))).toBe(
      false,
    );
  });

  it('passes server syntax_error envelope through', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: false,
        kind: 'syntax_error',
        raw_code: 'ER_PARSE_ERROR',
        message: 'You have an error in your SQL syntax',
        friendly: 'SQL error: parse error near `WHEER`',
        durationMs: 5,
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1 WHEER x=1', [], {
      dataDirOverride: testDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('syntax_error');
      expect(result.friendly).toMatch(/SQL error/);
    }
  });
});

// ---------------------------------------------------------------------------
// Datahub: network failures classify as host_unreachable
// ---------------------------------------------------------------------------

describe('runQuery :: datahub network failure', () => {
  /** Build a `TypeError: fetch failed` carrying the given `cause`, mirroring
   *  how Node's global fetch (undici) surfaces transport failures (see
   *  lib/net/classify.test.ts's identical helper). The OLD version of this
   *  test used a flat `Error` with `.code` set directly, which never
   *  actually matched classify.ts's shape — it passed only because the
   *  pre-US4 code never inspected the error at all, just hardcoded a
   *  friendly string for anything DatahubNetworkError-wrapped. */
  function fetchFailed(cause: unknown): Error {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = cause;
    return e;
  }

  it('classifies ENOTFOUND as host_unreachable and points at mixshift doctor', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND mcp.mixshift.io'), {
      code: 'ENOTFOUND',
    });
    const mockFetch = vi.fn().mockRejectedValueOnce(fetchFailed(cause));
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toContain('Could not resolve mcp.mixshift.io');
      expect(result.friendly).toContain('mixshift doctor');
    }
  });

  it('classifies a sandbox proxy 403 as host_unreachable, naming the sandbox and mixshift doctor (not the old generic line)', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    const cause = new Error('Received HTTP code 403 from proxy after CONNECT');
    const mockFetch = vi.fn().mockRejectedValueOnce(fetchFailed(cause));
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.friendly).toContain('sandbox blocked mcp.mixshift.io');
      expect(result.friendly).toContain('mixshift doctor');
      expect(result.friendly).not.toBe(
        'The MixShift auth service is unreachable. Check your network or try again in a minute.',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Resolve preference: datahub wins when both blocks coexist
// ---------------------------------------------------------------------------

describe('runQuery :: resolveCreds preference', () => {
  it('prefers datahub when both blocks exist on disk', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    // Manually inject a mysql block alongside datahub via the
    // credentials file. (saveDatahub preserves any existing mysql block;
    // here we simulate the rollout scenario where both coexist.)
    const { saveCredentials, loadCredentials } = await import(
      '../auth/credentials.js'
    );
    const loaded = await loadCredentials(testDir);
    await saveCredentials(
      {
        ...loaded.credentials!,
        mysql: {
          host: 'h',
          port: 3306,
          user: 'u',
          password: 'p',
          database: 'd',
        },
      },
      testDir,
    );

    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    // Datahub branch was taken — fetch was called (no mysql connection)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws clear error when no creds exist', async () => {
    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });
    // Throws inside runQuery → returns the wrapped unknown failure
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown');
      expect(result.message).toMatch(/No credentials configured/);
    }
  });
});

// ---------------------------------------------------------------------------
// streamQuery: page-at-a-time delivery (single shot vs paginated)
// ---------------------------------------------------------------------------

describe('streamQuery', () => {
  const makeRows = (off: number, n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => ({ id: off + i, name: `n${off + i}` }));

  it('single shot: delivers one page and reports paginated:false', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: makeRows(0, 2), rowCount: 2, durationMs: 5 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const pages: Array<[number, number]> = [];
    const res = await streamQuery('SELECT id, name FROM t', [], { dataDirOverride: testDir }, (rows, idx) => {
      pages.push([idx, rows.length]);
    });

    expect(res.ok).toBe(true);
    expect(res.paginated).toBe(false);
    expect(res.rowCount).toBe(2);
    expect(pages).toEqual([[0, 2]]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('paginates over a cap failure, streaming pages and reporting paginated:true', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const sql = JSON.parse(init.body as string).sql as string;
      if (/LIMIT 1$/.test(sql)) return jsonResponse(200, { ok: true, rows: makeRows(0, 1), rowCount: 1, durationMs: 1 });
      const off = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? -1);
      if (off === 0) return jsonResponse(200, { ok: true, rows: makeRows(0, FIRST_PAGE_PROBE_ROWS), rowCount: FIRST_PAGE_PROBE_ROWS, durationMs: 1 });
      if (off === FIRST_PAGE_PROBE_ROWS) return jsonResponse(200, { ok: true, rows: makeRows(off, 7), rowCount: 7, durationMs: 1 });
      // The first raw shot (no wrapping) trips the row cap.
      return jsonResponse(200, { ok: false, kind: 'unknown', message: 'Query returned 60000 rows; service cap is 50000.', friendly: '', durationMs: 1 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const pages: Array<[number, number]> = [];
    let total = 0;
    const res = await streamQuery('SELECT id, name FROM t', [], { dataDirOverride: testDir }, (rows, idx) => {
      pages.push([idx, rows.length]);
      total += rows.length;
    });

    expect(res.ok).toBe(true);
    expect(res.paginated).toBe(true);
    expect(res.rowCount).toBe(FIRST_PAGE_PROBE_ROWS + 7);
    expect(total).toBe(FIRST_PAGE_PROBE_ROWS + 7);
    expect(pages).toEqual([[0, FIRST_PAGE_PROBE_ROWS], [1, 7]]);
  });

  it('surfaces a non-cap failure without paginating or calling onPage', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: false, kind: 'syntax_error', message: 'bad', friendly: 'SQL error', durationMs: 1 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    let called = 0;
    const res = await streamQuery('SELECT bad', [], { dataDirOverride: testDir }, () => { called++; });

    expect(res.ok).toBe(false);
    expect(res.paginated).toBe(false);
    expect(res.failure?.kind).toBe('syntax_error');
    expect(called).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('FINDING 1 (row-cap trip): an ordered top-N export returns the true top-N by spend, not the positional-first N', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);

    // spend is a permutation of id, so top-N by spend ≠ positional-first N.
    const NBASE = 200;
    const K = 120;
    const cols = ['id', 'spend'];
    const base = Array.from({ length: NBASE }, (_, id) => ({ id, spend: (id * 37) % NBASE }));
    const mat = [...base].sort((a, b) => b.spend - a.spend).slice(0, K);
    const userSql = 'SELECT id, spend FROM t ORDER BY spend DESC LIMIT 120';

    const outerLimit = (s: string): number => Number(s.match(/LIMIT (\d+) OFFSET \d+\s*$/)?.[1] ?? 0);
    const outerOffset = (s: string): number => Number(s.match(/OFFSET (\d+)\s*$/)?.[1] ?? 0);
    const orderClause = (s: string): string => s.match(/ORDER BY ([^()]+?) LIMIT \d+ OFFSET \d+\s*$/)?.[1] ?? '';
    const applyOrder = (list: typeof mat, ob: string): typeof mat =>
      [...list].sort((a, b) => {
        for (const t of ob.split(',').map((x) => x.trim())) {
          const m = /^(\d+)(?:\s+(asc|desc))?$/i.exec(t)!;
          const key = cols[Number(m[1]) - 1]! as 'id' | 'spend';
          const dir = (m[2] ?? 'ASC').toUpperCase();
          if (a[key] < b[key]) return dir === 'DESC' ? 1 : -1;
          if (a[key] > b[key]) return dir === 'DESC' ? -1 : 1;
        }
        return 0;
      });

    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const sql = JSON.parse(init.body as string).sql as string;
      // The raw single shot (no wrapping) trips the 50k ROW cap → triggers paging.
      if (!sql.includes('_mx_page')) {
        return jsonResponse(200, { ok: false, kind: 'unknown', message: 'Query returned 60000 rows; service cap is 50000.', friendly: '', durationMs: 1 });
      }
      if (/LIMIT 1$/.test(sql)) return jsonResponse(200, { ok: true, rows: [mat[0]], rowCount: 1, durationMs: 1 });
      const page = applyOrder(mat, orderClause(sql)).slice(outerOffset(sql), outerOffset(sql) + outerLimit(sql));
      return jsonResponse(200, { ok: true, rows: page, rowCount: page.length, durationMs: 1 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const collected: Array<Record<string, unknown>> = [];
    const res = await streamQuery(userSql, [], { dataDirOverride: testDir }, (rows) => {
      collected.push(...rows);
    });

    expect(res.ok).toBe(true);
    expect(res.paginated).toBe(true);
    expect(res.rowCount).toBe(K);
    expect(res.outputOrderPositional).toBe(false); // user ORDER BY preserved
    // Delivered SET + order is exactly the user's top-N by spend...
    expect(collected.map((r) => r.id)).toEqual(mat.map((r) => r.id));
    // ...and NOT the positional-first N (ids 0..K-1) — the bug this fix closes.
    expect(collected.map((r) => r.id)).not.toEqual(Array.from({ length: K }, (_, i) => i));
    expect(collected[0]!.id).not.toBe(0);
  });

  it('streams all paged rows to a CSV file without buffering the whole set', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const sql = JSON.parse(init.body as string).sql as string;
      if (/LIMIT 1$/.test(sql)) return jsonResponse(200, { ok: true, rows: makeRows(0, 1), rowCount: 1, durationMs: 1 });
      const off = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? -1);
      if (off === 0) return jsonResponse(200, { ok: true, rows: makeRows(0, FIRST_PAGE_PROBE_ROWS), rowCount: FIRST_PAGE_PROBE_ROWS, durationMs: 1 });
      if (off === FIRST_PAGE_PROBE_ROWS) return jsonResponse(200, { ok: true, rows: makeRows(off, 3), rowCount: 3, durationMs: 1 });
      return jsonResponse(200, { ok: false, kind: 'unknown', message: 'service cap is 50000', friendly: '', durationMs: 1 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const outPath = join(testDir, 'out.csv');
    const sink = createCsvFileSink(outPath);
    const res = await streamQuery('SELECT id, name FROM t', [], { dataDirOverride: testDir }, async (rows) => {
      await sink.writePage(rows);
    });
    await sink.close();

    expect(res.ok).toBe(true);
    expect(res.paginated).toBe(true);
    expect(sink.rowsWritten()).toBe(FIRST_PAGE_PROBE_ROWS + 3);

    const lines = (await readFile(outPath, 'utf-8')).trim().split('\n');
    expect(lines[0]).toBe('id,name'); // header written once
    expect(lines.length).toBe(1 + FIRST_PAGE_PROBE_ROWS + 3); // header + every row
    expect(lines[1]).toBe('0,n0');
    expect(lines[lines.length - 1]).toBe(`${FIRST_PAGE_PROBE_ROWS + 2},n${FIRST_PAGE_PROBE_ROWS + 2}`);
  });

  it('FINDING 2: a mid-stream (page 2) failure renames the partial file so no complete-looking CSV remains', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const sql = JSON.parse(init.body as string).sql as string;
      if (/LIMIT 1$/.test(sql)) return jsonResponse(200, { ok: true, rows: makeRows(0, 1), rowCount: 1, durationMs: 1 });
      const off = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? -1);
      if (off === 0) return jsonResponse(200, { ok: true, rows: makeRows(0, FIRST_PAGE_PROBE_ROWS), rowCount: FIRST_PAGE_PROBE_ROWS, durationMs: 1 });
      // Page 2 fails (a non-cap failure) AFTER page 1 was already written to disk.
      if (off === FIRST_PAGE_PROBE_ROWS) return jsonResponse(200, { ok: false, kind: 'timeout', message: 'timed out', friendly: 'Query exceeded the 60s timeout.', durationMs: 1 });
      return jsonResponse(200, { ok: false, kind: 'unknown', message: 'service cap is 50000', friendly: '', durationMs: 1 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const outPath = join(testDir, 'partial-out.csv');
    const sink = createCsvFileSink(outPath);
    const res = await streamQuery('SELECT id, name FROM t', [], { dataDirOverride: testDir }, async (rows) => {
      await sink.writePage(rows);
    });

    expect(res.ok).toBe(false);
    expect(res.failure?.kind).toBe('timeout');
    // Command wiring: on a mid-stream failure, salvage-rename the partial file.
    const partial = await sink.finalizePartial();
    expect(partial).toBe(`${outPath}.partial`);
    // The bare <out> path must NOT exist as a complete-looking file.
    await expect(stat(outPath)).rejects.toThrow();
    const content = await readFile(partial!, 'utf-8');
    expect(content.split('\n')[0]).toBe('id,name'); // partial carries header + page-1 rows
  });

  it('FINDING 3: a successful 0-row result still yields an output file (ensureFile)', async () => {
    const creds = freshDatahubFixture();
    await saveDatahub(creds, testDir);
    const mockFetch = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 3 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const outPath = join(testDir, 'zero-rows.csv');
    const sink = createCsvFileSink(outPath);
    const res = await streamQuery('SELECT id, name FROM t WHERE 1=0', [], { dataDirOverride: testDir }, async (rows) => {
      await sink.writePage(rows);
    });

    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(0);
    expect(sink.opened()).toBe(false); // no page was ever written
    // Command wiring: create the file anyway so the success message is truthful.
    if (!sink.opened()) await sink.ensureFile();
    await sink.close();
    expect((await stat(outPath)).isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDatahubFixture(): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'eyJfresh.token',
    refresh_token: 'r'.repeat(48),
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
    user_id: '3',
    email: 'amazon+clients@example.com',
    person_label: 'someone@example.com',
    device_label: 'laptop-sam',
    client_id: 'mx-claude-plugin',
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
