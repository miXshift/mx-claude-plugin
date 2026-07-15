/**
 * Page-at-a-time CSV file sink for streaming large query results to disk.
 *
 * Pairs with `streamQuery` / `paginateOverCap({ onPage })`: each page of rows
 * is appended to the file and then dropped, so the whole result set never sits
 * in memory. The header is written once, lazily, from the first non-empty
 * page's columns; the underlying file is opened lazily too, so a query that
 * fails before any rows arrive leaves no empty file behind.
 *
 * Backpressure: after each page we wait for the write stream to drain if it is
 * over its high-water mark, bounding buffered bytes to roughly one page.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { createCsvWriter, type CsvWriter } from './csv.js';

export interface CsvFileSink {
  /** Append a page of rows. No-op for an empty page. Header + file are created
   *  lazily on the first non-empty page. */
  writePage(rows: Array<Record<string, unknown>>): Promise<void>;
  /** Rows written so far (not counting the header). */
  rowsWritten(): number;
  /** Bytes flushed to the file so far (0 until the first page opens it). */
  bytesWritten(): number;
  /** True once a file has actually been opened (a non-empty page was written). */
  opened(): boolean;
  /** Flush and close the file. No-op if nothing was ever written. */
  close(): Promise<void>;
}

/** Compact human-readable byte size for streaming progress lines. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function createCsvFileSink(outPath: string): CsvFileSink {
  let stream: WriteStream | null = null;
  let writer: CsvWriter | null = null;

  async function ensureOpen(columns: Array<{ name: string }>): Promise<void> {
    if (stream) return;
    await mkdir(dirname(outPath), { recursive: true });
    stream = createWriteStream(outPath, { encoding: 'utf-8' });
    writer = createCsvWriter(stream, columns);
    writer.writeHeader();
  }

  return {
    async writePage(rows): Promise<void> {
      if (rows.length === 0) return;
      const columns = Object.keys(rows[0]!).map((name) => ({ name }));
      await ensureOpen(columns);
      for (const row of rows) writer!.writeRow(row);
      // Respect backpressure so a fast producer can't outrun the disk.
      if (stream!.writableNeedDrain) await once(stream!, 'drain');
    },
    rowsWritten(): number {
      return writer ? writer.rowsWritten() : 0;
    },
    bytesWritten(): number {
      return stream ? stream.bytesWritten : 0;
    },
    opened(): boolean {
      return stream !== null;
    },
    close(): Promise<void> {
      if (!stream) return Promise.resolve();
      const s = stream;
      return new Promise<void>((resolve, reject) => {
        s.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
  };
}
