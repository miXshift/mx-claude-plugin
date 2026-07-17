import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, mkdir } from 'node:fs/promises';
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

  // Finding 3 — 0-row result must still create the file so the success message
  // is truthful and downstream reads do not ENOENT.
  it('ensureFile creates an empty file when no rows and no columns are known', async () => {
    const out = join(dir, 'zero.csv');
    const sink = createCsvFileSink(out);
    await sink.ensureFile();
    await sink.close();
    expect(sink.opened()).toBe(true);
    expect(await readFile(out, 'utf-8')).toBe('');
  });

  it('ensureFile writes just a header when the columns are known', async () => {
    const out = join(dir, 'zero-hdr.csv');
    const sink = createCsvFileSink(out);
    await sink.ensureFile([{ name: 'a' }, { name: 'b' }]);
    await sink.close();
    expect(await readFile(out, 'utf-8')).toBe('a,b\n');
  });

  // Finding 2 — a mid-stream failure must not leave a complete-looking file.
  it('finalizePartial renames a partially-written file to <out>.partial', async () => {
    const out = join(dir, 'part.csv');
    const sink = createCsvFileSink(out);
    await sink.writePage([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const partial = await sink.finalizePartial();
    expect(partial).toBe(`${out}.partial`);
    await expect(stat(out)).rejects.toThrow(); // no complete-looking file remains
    expect(await readFile(partial!, 'utf-8')).toBe('id,name\n1,a\n2,b\n');
  });

  it('finalizePartial returns null when no file was ever opened', async () => {
    const out = join(dir, 'never.csv');
    const sink = createCsvFileSink(out);
    expect(await sink.finalizePartial()).toBeNull();
    await expect(stat(out)).rejects.toThrow();
  });

  // Finding 4 — a write-stream error must surface as a rejection, never as an
  // unhandled async 'error' event that crashes the process.
  it('surfaces a write-stream error as a rejection instead of an unhandled event', async () => {
    // Point the sink at an existing DIRECTORY so the underlying stream open
    // fails (EISDIR), emitting an async 'error' on the WriteStream.
    const out = join(dir, 'is-a-dir');
    await mkdir(out);
    const sink = createCsvFileSink(out);
    let rejected = false;
    try {
      await sink.writePage([{ x: 1 }]);
      // Give the async open-error a tick to fire and be captured.
      await new Promise((r) => setTimeout(r, 40));
      await sink.close();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});

describe('fmtBytes', () => {
  it('formats bytes / KB / MB', () => {
    expect(fmtBytes(500)).toBe('500 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
