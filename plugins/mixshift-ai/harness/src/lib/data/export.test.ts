import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock the DB layer + catalog so we drive exportTable's disk/failure wiring
// deterministically. The CSV sink is REAL (not mocked) so we exercise the
// actual on-disk behavior for Findings 2 (partial file) and 3 (0-row file).
vi.mock('./query-runner.js', () => ({ streamQuery: vi.fn() }));
vi.mock('./tables-catalog.js', () => ({ describeTable: vi.fn() }));

import { exportTable } from './export.js';
import { streamQuery } from './query-runner.js';
import { describeTable } from './tables-catalog.js';

const streamQueryMock = vi.mocked(streamQuery);
const describeTableMock = vi.mocked(describeTable);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mx-export-'));
  vi.clearAllMocks();
  // A plain table with no seller-id / date requirements.
  describeTableMock.mockResolvedValue({
    name: 't',
    description: '',
    category: 'other',
    time_series: false,
    requires_seller_id: false,
  } as never);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('exportTable — Finding 3 (0-row still creates the file)', () => {
  it('creates the output file even when the query returns 0 rows', async () => {
    streamQueryMock.mockImplementation(async () => ({
      ok: true,
      rowCount: 0,
      durationMs: 2,
      paginated: false,
    }));
    const outPath = join(dir, 'zero.csv');
    const res = await exportTable({ table: 't', outPath });
    expect(res.query_result.ok).toBe(true);
    expect(res.rows_written).toBe(0);
    // The file exists (truthful "Exported 0 rows to <path>").
    expect((await stat(outPath)).isFile()).toBe(true);
  });
});

describe('exportTable — Finding 2 (mid-stream failure leaves no complete-looking file)', () => {
  it('renames the partial file to <out>.partial and flags the export incomplete', async () => {
    streamQueryMock.mockImplementation(async (_sql, _params, _opts, onPage) => {
      // Page 1 is written to disk...
      await onPage!([{ id: 1, name: 'a' }, { id: 2, name: 'b' }], 0);
      // ...then page 2 fails.
      return {
        ok: false,
        rowCount: 0,
        durationMs: 5,
        paginated: true,
        failure: { ok: false, kind: 'timeout', message: 'timed out', friendly: 'Query exceeded the 60s timeout.' },
      };
    });
    const outPath = join(dir, 'mid.csv');
    const res = await exportTable({ table: 't', outPath });

    expect(res.query_result.ok).toBe(false);
    expect(res.incomplete).toBe(true);
    expect(res.partial_path).toBe(`${outPath}.partial`);
    // No complete-looking <out>; the salvaged partial holds the header + page 1.
    await expect(stat(outPath)).rejects.toThrow();
    expect(await readFile(`${outPath}.partial`, 'utf-8')).toBe('id,name\n1,a\n2,b\n');
  });
});
