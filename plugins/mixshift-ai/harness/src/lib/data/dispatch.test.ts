import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the query runner so no network/db is touched. Must be declared
// before importing the module under test.
vi.mock('./query-runner.js', () => ({
  runQuery: vi.fn(),
  runNamedQuery: vi.fn(),
}));

import { runQuery, runNamedQuery } from './query-runner.js';
import {
  runDispatched,
  resolveLocalSprocSql,
  resolveLocalNamedSql,
  buildCallSql,
  MissingParamsError,
  SPROC_SQL_DIR_ENV,
  QUERY_PACK_DIR_ENV,
} from './dispatch.js';
import { _schemas, resetCatalogCache } from '../prefetch/sql-library.js';

const runQueryMock = vi.mocked(runQuery);
const runNamedQueryMock = vi.mocked(runNamedQuery);

const okResult = (rows: Array<Record<string, unknown>> = [{ a: 1 }]) => ({
  ok: true as const,
  rows,
  rowCount: rows.length,
  durationMs: 5,
});

beforeEach(() => {
  runQueryMock.mockReset();
  runNamedQueryMock.mockReset();
  resetCatalogCache();
  delete process.env[SPROC_SQL_DIR_ENV];
  delete process.env[QUERY_PACK_DIR_ENV];
});

afterEach(() => {
  delete process.env[SPROC_SQL_DIR_ENV];
  delete process.env[QUERY_PACK_DIR_ENV];
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

  it('accepts a named entry with neither file nor sproc', () => {
    const entry = queryEntrySchema.parse({
      id: 'CS-28',
      dispatch: 'named',
      purpose: 'x',
    });
    expect(entry.dispatch).toBe('named');
    expect(entry.file).toBeUndefined();
    expect(entry.sproc).toBeUndefined();
  });

  it('accepts a named entry that retains its SP-era sproc name', () => {
    const entry = queryEntrySchema.parse({
      id: 'BRAIN-SELLER',
      dispatch: 'named',
      sproc: 'sp_brain_seller_fetch',
      purpose: 'x',
    });
    expect(entry.dispatch).toBe('named');
    expect(entry.sproc).toBe('sp_brain_seller_fetch');
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

describe('runDispatched named backend (BRAIN-SELLER, real catalog)', () => {
  it('sends {id, sellerIds, params} through runNamedQuery', async () => {
    runNamedQueryMock.mockResolvedValueOnce(okResult([{ MerchantAlias: 'BP' }]));

    const result = await runDispatched('BRAIN-SELLER', {
      params: { include_dormant: false },
      sellerIds: [574, 575],
    });

    expect(runNamedQueryMock).toHaveBeenCalledTimes(1);
    expect(runQueryMock).not.toHaveBeenCalled();
    const [id, opts] = runNamedQueryMock.mock.calls[0]!;
    expect(id).toBe('BRAIN-SELLER');
    expect(opts).toMatchObject({
      sellerIds: [574, 575],
      params: { include_dormant: false },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usedDispatch).toBe('named');
      expect(result.rows).toEqual([{ MerchantAlias: 'BP' }]);
      expect(result.displaySql).toContain('named query BRAIN-SELLER');
    }
  });

  it('carries the entry revision into the dispatch result + displaySql', async () => {
    runNamedQueryMock.mockResolvedValueOnce({
      ok: true,
      rows: [],
      rowCount: 0,
      durationMs: 5,
      revision: '211bbe1a',
    });
    const result = await runDispatched('BRAIN-SELLER', { sellerIds: [574] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe('211bbe1a');
      expect(result.displaySql).toContain('@211bbe1a');
    }
  });

  it('routes params.seller_ids to the top-level seller scope when sellerIds is not given', async () => {
    runNamedQueryMock.mockResolvedValueOnce(okResult());

    await runDispatched('BRAIN-SELLER', {
      params: { seller_ids: [574], lookback_days: 30 },
    });

    const [, opts] = runNamedQueryMock.mock.calls[0]!;
    expect(opts).toMatchObject({
      sellerIds: [574],
      params: { lookback_days: 30 },
    });
  });

  it('wraps classified failures with the dispatch label', async () => {
    runNamedQueryMock.mockResolvedValueOnce({
      ok: false,
      kind: 'unknown_query',
      message: "No query pack entry with id 'BRAIN-SELLER'.",
      friendly: "'BRAIN-SELLER' is not a known library query.",
      durationMs: 3,
    });

    const result = await runDispatched('BRAIN-SELLER', { sellerIds: [574] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usedDispatch).toBe('named');
      expect(result.failure.kind).toBe('unknown_query');
    }
  });

  it('prefers MIXSHIFT_QUERY_PACK_DIR/<id>.sql as the local dev fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-pack-'));
    try {
      await writeFile(
        join(dir, 'BRAIN-SELLER.sql'),
        '-- local dev body\nSELECT * FROM seller WHERE ID IN (:seller_ids)',
      );
      process.env[QUERY_PACK_DIR_ENV] = dir;
      runQueryMock.mockResolvedValueOnce(okResult());

      const result = await runDispatched('BRAIN-SELLER', {
        params: { seller_ids: [574, 575] },
      });

      expect(runNamedQueryMock).not.toHaveBeenCalled();
      const [sql] = runQueryMock.mock.calls[0]!;
      // List param CSV-inlined by substituteParams; header stripped.
      expect(sql).toBe('SELECT * FROM seller WHERE ID IN (574, 575)');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.usedDispatch).toBe('named_local_dev');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to MIXSHIFT_SPROC_SQL_DIR/<sproc>.sql for SP-era dev dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(
        join(dir, 'sp_brain_seller_fetch.sql'),
        'SELECT * FROM seller WHERE ID IN (:seller_ids)',
      );
      process.env[SPROC_SQL_DIR_ENV] = dir;
      runQueryMock.mockResolvedValueOnce(okResult());

      const result = await runDispatched('BRAIN-SELLER', {
        params: { seller_ids: [574] },
      });

      expect(runNamedQueryMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.usedDispatch).toBe('named_local_dev');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws MissingParamsError from the local fallback when params are absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-pack-'));
    try {
      await writeFile(
        join(dir, 'BRAIN-SELLER.sql'),
        'SELECT * FROM seller WHERE ID IN (:seller_ids)',
      );
      process.env[QUERY_PACK_DIR_ENV] = dir;

      await expect(runDispatched('BRAIN-SELLER', {})).rejects.toThrow(
        MissingParamsError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveLocalNamedSql', () => {
  it('returns undefined when neither env var is set', async () => {
    expect(
      await resolveLocalNamedSql('BRAIN-SELLER', 'sp_brain_seller_fetch', {}),
    ).toBeUndefined();
  });

  it('prefers the pack dir over the sproc dir when both resolve', async () => {
    const packDir = await mkdtemp(join(tmpdir(), 'mx-pack-'));
    const sprocDir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(join(packDir, 'BRAIN-SELLER.sql'), 'SELECT 1');
      await writeFile(join(sprocDir, 'sp_brain_seller_fetch.sql'), 'SELECT 2');
      const sql = await resolveLocalNamedSql('BRAIN-SELLER', 'sp_brain_seller_fetch', {
        [QUERY_PACK_DIR_ENV]: packDir,
        [SPROC_SQL_DIR_ENV]: sprocDir,
      });
      expect(sql).toBe('SELECT 1');
    } finally {
      await rm(packDir, { recursive: true, force: true });
      await rm(sprocDir, { recursive: true, force: true });
    }
  });

  it('skips the sproc fallback when the entry has no sproc name', async () => {
    const sprocDir = await mkdtemp(join(tmpdir(), 'mx-sproc-'));
    try {
      await writeFile(join(sprocDir, 'CS-28.sql'), 'SELECT 1');
      const sql = await resolveLocalNamedSql('CS-28', undefined, {
        [SPROC_SQL_DIR_ENV]: sprocDir,
      });
      expect(sql).toBeUndefined();
    } finally {
      await rm(sprocDir, { recursive: true, force: true });
    }
  });
});

// DHC-02 stands in as the representative still-`dispatch: sql` query
// (same scalar params as DHC-01). DHC-01 itself moved to dispatch: named
// when the foundation queries flipped to the server-side pack.
describe('runDispatched sql backend (DHC-02, real catalog + real .sql file)', () => {
  it('reads the library body, substitutes, and runs with query_id tagging', async () => {
    runQueryMock.mockResolvedValueOnce(okResult([{ spend: 10 }]));

    // DHC-02's real body references :yesterday, :month_start, :seller_id
    // (scalar params; mysql2 named-placeholder mode binds them).
    const result = await runDispatched('DHC-02', {
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
    expect((opts as { query_id?: string }).query_id).toBe('DHC-02');
  });

  it('throws MissingParamsError when referenced params are absent', async () => {
    await expect(
      runDispatched('DHC-02', { params: {} }),
    ).rejects.toThrow(MissingParamsError);
    expect(runQueryMock).not.toHaveBeenCalled();
  });
});
