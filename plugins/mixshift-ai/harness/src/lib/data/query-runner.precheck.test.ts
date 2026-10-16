/**
 * The pre-send column check wired into runQuery / streamQuery:
 *   - with `precheckColumns`, a certainly-absent column never reaches the
 *     network, surfaces as kind 'unknown_column' with the hint, and emits
 *     QueryFailed/unknown_column carrying table + column + suggestion;
 *   - a query the check cannot be sure about (a JOIN) is sent unchanged, and
 *     a server ER_BAD_FIELD_ERROR on it now carries the real columns;
 *   - without the option (generated SQL, library queries) nothing changes;
 *   - the check's cost is stamped on QueryExecuted as `precheck_ms`;
 *   - the ordinary QueryFailed payload now carries the server `message` for
 *     ad-hoc SQL and still never for a library query id.
 *
 * `track` is mocked to capture emits; fetch is stubbed so no query leaves.
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

import { runQuery, streamQuery, CLIENT_UNKNOWN_COLUMN_RAW_CODE } from './query-runner.js';
import { saveDatahub, _refreshState } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-precheck-test-'));
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

function creds(): DatahubCreds {
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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const emits = () => trackSpy.mock.calls.map((c) => c[0]);

describe('precheckColumns on runQuery', () => {
  it('blocks a certainly-absent column before any request is made', async () => {
    await saveDatahub(creds(), testDir);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await runQuery('SELECT SUM(spend) AS s FROM campaignmetric WHERE SellerID = 1', [], {
      dataDirOverride: testDir,
      precheckColumns: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('unknown_column');
    expect(res.table_name).toBe('campaignmetric');
    expect(res.raw_code).toBe(CLIENT_UNKNOWN_COLUMN_RAW_CODE);
    expect(res.friendly).toContain('No column `spend` on `campaignmetric`. Did you mean `Cost`?');
    expect(res.friendly).toContain('The query was not sent.');

    const failed = emits().filter((e) => e.event_name === 'query.failed');
    expect(failed).toHaveLength(1);
    const e = failed[0]!;
    expect(e.error_class).toBe('unknown_column');
    expect(e.query_table).toBe('campaignmetric');
    expect(e.payload).toMatchObject({
      stage: 'client_precheck',
      raw_code: CLIENT_UNKNOWN_COLUMN_RAW_CODE,
      table: 'campaignmetric',
      column: 'spend',
      suggestion: 'Cost',
      sql_normalized: 'SELECT SUM(spend) AS s FROM campaignmetric WHERE SellerID = 1',
      query_shape: { table: 'campaignmetric', select_star: false, projected_cols: 1 },
    });
    expect(typeof e.payload.precheck_ms).toBe('number');
  });

  it('sends a valid query through and stamps precheck_ms on QueryExecuted', async () => {
    await saveDatahub(creds(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, rows: [{ c: 1 }], rowCount: 1, durationMs: 3 })),
    );

    const res = await runQuery('SELECT SUM(Cost) AS c FROM campaignmetric WHERE SellerID = 1', [], {
      dataDirOverride: testDir,
      precheckColumns: true,
    });

    expect(res.ok).toBe(true);
    const ok = emits().find((e) => e.event_name === 'query.executed')!;
    expect(typeof ok.payload.precheck_ms).toBe('number');
    expect(ok.payload.precheck_ms).toBeLessThan(50);
  });

  it('sends a JOIN unchanged, and a server unknown-column error then carries the real columns', async () => {
    await saveDatahub(creds(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ok: false,
          kind: 'syntax_error',
          raw_code: 'ER_BAD_FIELD_ERROR',
          message: "Unknown column 's.SellerName' in 'where clause'",
          friendly: "SQL error: Unknown column 's.SellerName' in 'where clause'",
        }),
      ),
    );

    const res = await runQuery(
      "SELECT m.Cost FROM campaignmetric m JOIN seller s ON s.ID = m.SellerID WHERE s.SellerName LIKE '%x%'",
      [],
      { dataDirOverride: testDir, precheckColumns: true },
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('syntax_error');
    expect(res.friendly).toContain('No column `SellerName` on `seller`. Did you mean `Name`?');
    expect(res.friendly).toContain('Columns on `seller` (');
    const failed = emits().find((e) => e.event_name === 'query.failed')!;
    expect(failed.error_class).toBe('syntax_error');
    expect(failed.payload.message).toBe("Unknown column 's.SellerName' in 'where clause'");
    expect(failed.payload.precheck_ms).toBeUndefined();
  });

  it('does nothing without the option (generated SQL keeps its old path)', async () => {
    await saveDatahub(creds(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ok: false,
          kind: 'syntax_error',
          raw_code: 'ER_BAD_FIELD_ERROR',
          message: "Unknown column 'spend' in 'field list'",
          friendly: "SQL error: Unknown column 'spend' in 'field list'",
        }),
      ),
    );
    const res = await runQuery('SELECT SUM(spend) FROM campaignmetric', [], { dataDirOverride: testDir });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.kind).toBe('syntax_error');
    const ok = emits().find((e) => e.event_name === 'query.executed');
    expect(ok).toBeUndefined();
  });

  it('never puts the server message on a library query failure', async () => {
    await saveDatahub(creds(), testDir);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          ok: false,
          kind: 'syntax_error',
          raw_code: 'ER_PARSE_ERROR',
          message: "You have an error in your SQL syntax near 'B0SECRET'",
          friendly: 'SQL error',
        }),
      ),
    );
    const res = await runQuery("SELECT 1 FROM campaignmetric WHERE ASIN IN ('B0SECRET')", [], {
      dataDirOverride: testDir,
      query_id: 'LIB-XX-01',
    });
    expect(res.ok).toBe(false);
    const failed = emits().find((e) => e.event_name === 'query.failed')!;
    expect(failed.payload.message).toBeUndefined();
    expect(failed.payload.sql_normalized).toBeUndefined();
  });
});

describe('precheckColumns on streamQuery', () => {
  it('returns the block as the stream failure with no page delivered', async () => {
    await saveDatahub(creds(), testDir);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const onPage = vi.fn();

    const streamed = await streamQuery(
      "SELECT * FROM seller WHERE SellerName LIKE '%x%'",
      [],
      { dataDirOverride: testDir, precheckColumns: true },
      onPage,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
    expect(streamed.ok).toBe(false);
    expect(streamed.paginated).toBe(false);
    expect(streamed.failure?.kind).toBe('unknown_column');
    expect(streamed.failure?.friendly).toContain('No column `SellerName` on `seller`. Did you mean `Name`?');
  });
});
