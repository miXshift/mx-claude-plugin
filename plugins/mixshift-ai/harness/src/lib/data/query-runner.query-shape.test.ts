/**
 * Query-shape telemetry enrichment: assert that `payload.query_shape` is stamped
 * on QueryExecuted (and QueryFailed) with the USER-level shape, including for a
 * PAGED query whose per-page emit runs with the pager's wrapped `_mx_page` SQL.
 *
 * `track` is mocked here to capture the enqueued telemetry inputs. Lives in its
 * own file so the module mock doesn't leak into query-runner.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { trackSpy } = vi.hoisted(() => ({ trackSpy: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, track: trackSpy };
});

import { runQuery, streamQuery, FIRST_PAGE_PROBE_ROWS } from './query-runner.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-qshape-test-'));
  _refreshState.inFlight = null;
  trackSpy.mockClear();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

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

const lastEmit = () => trackSpy.mock.calls[trackSpy.mock.calls.length - 1]![0];

describe('query_shape telemetry enrichment', () => {
  it('stamps payload.query_shape on QueryExecuted for a raw query', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, { ok: true, rows: [{ a: 1, b: 2 }], rowCount: 1, durationMs: 3 }),
      ),
    );

    const res = await runQuery('SELECT a, b FROM campaigns WHERE SellerID = ?', [7], {
      dataDirOverride: testDir,
    });

    expect(res.ok).toBe(true);
    expect(trackSpy).toHaveBeenCalled();
    const emit = lastEmit();
    expect(emit.event_name).toBe('query.executed');
    expect(emit.payload.query_shape).toEqual({
      table: 'campaigns',
      select_star: false,
      projected_cols: 2,
    });
  });

  it('stamps the user-level SELECT * shape on QueryExecuted', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
      ),
    );

    await runQuery('SELECT * FROM mws_items', [], { dataDirOverride: testDir });

    expect(lastEmit().payload.query_shape).toEqual({
      table: 'mws_items',
      select_star: true,
      projected_cols: null,
    });
  });

  it('does not emit SQL text or resolved parameters for a library query', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, { ok: true, rows: [], rowCount: 0, durationMs: 1 }),
      ),
    );

    await runQuery(
      "SELECT * FROM campaigns WHERE SellerID IN ('sensitive-seller-id')",
      [],
      {
        dataDirOverride: testDir,
        query_id: 'DHC-02',
      },
    );

    const emit = lastEmit();
    expect(emit.query_id).toBe('DHC-02');
    expect(emit.payload).not.toHaveProperty('sql_normalized');
    expect(JSON.stringify(emit)).not.toContain('sensitive-seller-id');
  });

  it('stamps payload.query_shape on QueryFailed', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ok: false,
          kind: 'syntax_error',
          message: 'bad',
          friendly: 'SQL error',
          durationMs: 1,
        }),
      ),
    );

    const res = await runQuery('SELECT x, y, z FROM broken_table', [], {
      dataDirOverride: testDir,
    });

    expect(res.ok).toBe(false);
    const emit = lastEmit();
    expect(emit.event_name).toBe('query.failed');
    expect(emit.payload.query_shape).toEqual({
      table: 'broken_table',
      select_star: false,
      projected_cols: 3,
    });
  });

  it('PAGED query: every per-page emit reports the user table, NOT _mx_page', async () => {
    await saveDatahub(freshDatahubFixture(), testDir);
    const makeRows = (off: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: off + i, name: `n${off + i}` }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const sql = JSON.parse(init.body as string).sql as string;
        if (/LIMIT 1$/.test(sql)) {
          return jsonResponse(200, { ok: true, rows: makeRows(0, 1), rowCount: 1, durationMs: 1 });
        }
        const off = Number(sql.match(/OFFSET (\d+)/)?.[1] ?? -1);
        if (off === 0) {
          return jsonResponse(200, {
            ok: true,
            rows: makeRows(0, FIRST_PAGE_PROBE_ROWS),
            rowCount: FIRST_PAGE_PROBE_ROWS,
            durationMs: 1,
          });
        }
        if (off === FIRST_PAGE_PROBE_ROWS) {
          return jsonResponse(200, { ok: true, rows: makeRows(off, 4), rowCount: 4, durationMs: 1 });
        }
        // The first raw single shot (no wrapping) trips the row cap → paging.
        return jsonResponse(200, {
          ok: false,
          kind: 'unknown',
          message: 'Query returned 60000 rows; service cap is 50000.',
          friendly: '',
          durationMs: 1,
        });
      }),
    );

    const res = await streamQuery(
      'SELECT id, name FROM campaigns',
      [],
      { dataDirOverride: testDir },
      () => {},
    );

    expect(res.ok).toBe(true);
    expect(res.paginated).toBe(true);

    // Multiple query.executed emits happened (one per page). EVERY one must
    // carry the user's real table + shape, never the wrapped _mx_page.
    const executedEmits = trackSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event_name === 'query.executed');
    expect(executedEmits.length).toBeGreaterThan(1);
    for (const emit of executedEmits) {
      expect(emit.payload.query_shape).toEqual({
        table: 'campaigns',
        select_star: false,
        projected_cols: 2,
      });
      expect(emit.payload.query_shape.table).not.toBe('_mx_page');
    }
  });
});
