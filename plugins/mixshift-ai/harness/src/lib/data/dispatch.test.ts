import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the query runner so no network/db is touched. Must be declared
// before importing the module under test.
vi.mock('./query-runner.js', () => ({
  runQuery: vi.fn(),
}));

import { runQuery } from './query-runner.js';
import {
  runDispatched,
  resolveLocalSprocSql,
  buildCallSql,
  MissingParamsError,
  SPROC_SQL_DIR_ENV,
} from './dispatch.js';
import { _schemas, resetCatalogCache } from '../prefetch/sql-library.js';

const runQueryMock = vi.mocked(runQuery);

const okResult = (rows: Array<Record<string, unknown>> = [{ a: 1 }]) => ({
  ok: true as const,
  rows,
  rowCount: rows.length,
  durationMs: 5,
});

beforeEach(() => {
  runQueryMock.mockReset();
  resetCatalogCache();
  delete process.env[SPROC_SQL_DIR_ENV];
});

afterEach(() => {
  delete process.env[SPROC_SQL_DIR_ENV];
});

describe('catalog entry schema: dispatch fields', () => {
  const { queryEntrySchema } = _schemas;

  it('defaults dispatch to sql for legacy entries', () => {
    const entry = queryEntrySchema.parse({
      id: 'DHC-01',
      file: 'DHC-01.sql',
      purpose: 'x',
    });
    expect(entry.dispatch).toBe('sql');
  });

  it('accepts a sproc entry with no file', () => {
    const entry = queryEntrySchema.parse({
      id: 'BRAIN-SELLER',
      dispatch: 'sproc',
      sproc: 'sp_brain_seller_fetch',
      purpose: 'x',
    });
    expect(entry.dispatch).toBe('sproc');
    expect(entry.file).toBeUndefined();
  });

  it('rejects dispatch:sql without a file', () => {
    const r = queryEntrySchema.safeParse({ id: 'X-01', purpose: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects dispatch:sproc without a sproc name', () => {
    const r = queryEntrySchema.safeParse({
      id: 'X-01',
      dispatch: 'sproc',
      purpose: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('rejects sproc names that do not match sp_ convention', () => {
    const r = queryEntrySchema.safeParse({
      id: 'X-01',
      dispatch: 'sproc',
      sproc: 'DROP TABLE seller',
      purpose: 'x',
    });
    expect(r.success).toBe(false);
  });
});

describe('buildCallSql', () => {
  it('builds the uniform two-arg CALL statement', () => {
    expect(buildCallSql('sp_brain_seller_fetch')).toBe(
      'CALL sp_brain_seller_fetch(?, ?)',
    );
  });
});

describe('resolveLocalSprocSql', () => {
  it('returns undefined when the env var is unset', async () => {
    expect(await resolveLocalSprocSql('sp_brain_seller_fetch', {})).toBeUndefined();
  });

  it('returns undefined when the file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      const sql = await resolveLocalSprocSql('sp_missing', {
        [SPROC_SQL_DIR_ENV]: dir,
      });
      expect(sql).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads <dir>/<sproc>.sql when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(join(dir, 'sp_brain_seller_fetch.sql'), 'SELECT 1');
      const sql = await resolveLocalSprocSql('sp_brain_seller_fetch', {
        [SPROC_SQL_DIR_ENV]: dir,
      });
      expect(sql).toBe('SELECT 1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runDispatched sproc backend (BRAIN-SELLER, real catalog)', () => {
  it('sends CALL with JSON-encoded params + seller ids through runQuery', async () => {
    runQueryMock.mockResolvedValueOnce(okResult([{ MerchantAlias: 'BP' }]));

    const result = await runDispatched('BRAIN-SELLER', {
      params: { include_dormant: false },
      sellerIds: [574, 575],
    });

    expect(runQueryMock).toHaveBeenCalledTimes(1);
    const [sql, bound, opts] = runQueryMock.mock.calls[0]!;
    expect(sql).toBe('CALL sp_brain_seller_fetch(?, ?)');
    expect(bound).toEqual([
      JSON.stringify({ include_dormant: false }),
      JSON.stringify([574, 575]),
    ]);
    expect((opts as { query_id?: string }).query_id).toBe('BRAIN-SELLER');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedDispatch).toBe('sproc');
      expect(result.rows).toEqual([{ MerchantAlias: 'BP' }]);
      expect(result.displaySql).toBe('CALL sp_brain_seller_fetch(?, ?)');
    }
  });

  it('routes params.seller_ids to the second CALL arg when sellerIds is not given', async () => {
    runQueryMock.mockResolvedValueOnce(okResult());

    await runDispatched('BRAIN-SELLER', {
      params: { seller_ids: [574], lookback_days: 30 },
    });

    const [, bound] = runQueryMock.mock.calls[0]!;
    expect(bound).toEqual([
      JSON.stringify({ lookback_days: 30 }),
      JSON.stringify([574]),
    ]);
  });

  it('wraps classified failures with the dispatch label', async () => {
    runQueryMock.mockResolvedValueOnce({
      ok: false,
      kind: 'unknown',
      message: 'PROCEDURE sp_brain_seller_fetch does not exist',
      friendly: 'PROCEDURE sp_brain_seller_fetch does not exist',
    });

    const result = await runDispatched('BRAIN-SELLER', { sellerIds: [574] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usedDispatch).toBe('sproc');
      expect(result.failure.kind).toBe('unknown');
    }
  });

  it('uses the local dev fallback when MIXSHIFT_SPROC_SQL_DIR provides the body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(
        join(dir, 'sp_brain_seller_fetch.sql'),
        '-- local dev body\nSELECT * FROM seller WHERE ID IN (:seller_ids)',
      );
      process.env[SPROC_SQL_DIR_ENV] = dir;
      runQueryMock.mockResolvedValueOnce(okResult());

      const result = await runDispatched('BRAIN-SELLER', {
        params: { seller_ids: [574, 575] },
      });

      const [sql] = runQueryMock.mock.calls[0]!;
      // List param CSV-inlined by substituteParams; header stripped.
      expect(sql).toBe('SELECT * FROM seller WHERE ID IN (574, 575)');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.usedDispatch).toBe('sproc_local_dev');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws MissingParamsError from the local fallback when params are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(
        join(dir, 'sp_brain_seller_fetch.sql'),
        'SELECT * FROM seller WHERE ID IN (:seller_ids)',
      );
      process.env[SPROC_SQL_DIR_ENV] = dir;

      await expect(runDispatched('BRAIN-SELLER', {})).rejects.toThrow(
        MissingParamsError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runDispatched sql backend (DHC-01, real catalog + real .sql file)', () => {
  it('reads the library body, substitutes, and runs with query_id tagging', async () => {
    runQueryMock.mockResolvedValueOnce(okResult([{ spend: 10 }]));

    // DHC-01's real body references :yesterday, :month_start, :seller_id
    // (scalar params; mysql2 named-placeholder mode binds them).
    const result = await runDispatched('DHC-01', {
      params: {
        yesterday: '2026-06-08',
        month_start: '2026-06-01',
        seller_id: 574,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedDispatch).toBe('sql');
      expect(result.boundParams).toHaveProperty('yesterday', '2026-06-08');
    }
    const [, , opts] = runQueryMock.mock.calls[0]!;
    expect((opts as { query_id?: string }).query_id).toBe('DHC-01');
  });

  it('throws MissingParamsError when referenced params are absent', async () => {
    await expect(
      runDispatched('DHC-01', { params: {} }),
    ).rejects.toThrow(MissingParamsError);
    expect(runQueryMock).not.toHaveBeenCalled();
  });
});
