import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCsvFileSink, fmtBytes } from './csv-file-sink.js';

describe('createCsvFileSink', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mx-sink-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes the header once from the first page and appends subsequent pages', async () => {
    const out = join(dir, 'a.csv');
    const sink = createCsvFileSink(out);
    await sink.writePage([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    await sink.writePage([{ id: 3, name: 'c' }]);
    await sink.close();
    expect(await readFile(out, 'utf-8')).toBe('id,name\n1,a\n2,b\n3,c\n');
    expect(sink.rowsWritten()).toBe(3);
    expect(sink.opened()).toBe(true);
  });

  it('never creates a file when no page is written (failed query leaves no artifact)', async () => {
    const out = join(dir, 'empty.csv');
    const sink = createCsvFileSink(out);
    await sink.close();
    expect(sink.opened()).toBe(false);
    expect(sink.rowsWritten()).toBe(0);
    await expect(stat(out)).rejects.toThrow();
  });

  it('skips empty pages and opens the file lazily on the first real data', async () => {
    const out = join(dir, 'b.csv');
    const sink = createCsvFileSink(out);
    await sink.writePage([]);
    expect(sink.opened()).toBe(false);
    await sink.writePage([{ x: 1 }]);
    await sink.close();
    expect(sink.opened()).toBe(true);
    expect(await readFile(out, 'utf-8')).toBe('x\n1\n');
  });

  it('reports bytes written once the file is open', async () => {
    const out = join(dir, 'c.csv');
    const sink = createCsvFileSink(out);
    expect(sink.bytesWritten()).toBe(0);
    await sink.writePage([{ x: 'hello world' }]);
    await sink.close();
    expect(sink.bytesWritten()).toBeGreaterThan(0);
  });
});

describe('fmtBytes', () => {
  it('formats bytes / KB / MB', () => {
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
