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
 *
 * Failure handling:
 *   - A WriteStream 'error' (e.g. ENOSPC) is captured and re-thrown from the
 *     next `writePage`/`close`, so a stream failure surfaces as a clean
 *     classified failure through the command's normal path rather than an
 *     unhandled async 'error' event crashing the process.
 *   - `finalizePartial()` renames a partially-written file to `<out>.partial`
 *     so a mid-stream failure never leaves a complete-LOOKING file on disk.
 *   - `ensureFile()` creates the output file even for a 0-row result, so a
 *     truthful success message never points at a nonexistent file.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCsvWriter, type CsvWriter } from './csv.js';

export interface CsvFileSink {
  /** Append a page of rows. No-op for an empty page. Header + file are created
   *  lazily on the first non-empty page. Rejects if the write stream errored. */
  writePage(rows: Array<Record<string, unknown>>): Promise<void>;
  /** Ensure the output file exists even when no rows were written (0-row
   *  result). Writes a header when `columns` are known; otherwise creates an
   *  empty file. No-op once the file is already open. */
  ensureFile(columns?: Array<{ name: string }>): Promise<void>;
  /** Rows written so far (not counting the header). */
  rowsWritten(): number;
  /** Bytes flushed to the file so far (0 until the first page opens it). */
  bytesWritten(): number;
  /** True once a file has actually been opened (a non-empty page was written,
   *  or `ensureFile` created it). */
  opened(): boolean;
  /** Flush and close the file. No-op if nothing was ever written. Rejects if
   *  the write stream errored. */
  close(): Promise<void>;
  /** Mid-stream failure cleanup: flush + close whatever was written, then
   *  rename it to `<out>.partial` so no consumer mistakes a truncated export
   *  for a complete one. Returns the `.partial` path, or null if no file had
   *  been opened (nothing to salvage). Best-effort — never throws. */
  finalizePartial(): Promise<string | null>;
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
  // Captured by a persistent 'error' listener so a write failure that fires
  // between our explicit awaits does not escape as an unhandled 'error' event.
  let streamError: Error | null = null;

  function newStream(): WriteStream {
    const s = createWriteStream(outPath, { encoding: 'utf-8' });
    s.on('error', (err: Error) => {
      if (!streamError) streamError = err;
    });
    return s;
  }

  /** Await a pending drain, but reject promptly if the stream errors instead of
   *  hanging forever (an errored stream never emits 'drain'). */
  function waitDrain(s: WriteStream): Promise<void> {
    if (!s.writableNeedDrain) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        s.off('drain', onDrain);
        s.off('error', onError);
      };
      s.once('drain', onDrain);
      s.once('error', onError);
    });
  }

  async function ensureOpen(columns: Array<{ name: string }>): Promise<void> {
    if (stream) return;
    await mkdir(dirname(outPath), { recursive: true });
    stream = newStream();
    writer = createCsvWriter(stream, columns);
    writer.writeHeader();
  }

  function closeStream(): Promise<void> {
    if (!stream) return Promise.resolve();
    const s = stream;
    return new Promise<void>((resolve, reject) => {
      if (streamError) {
        // The stream errored, so it was never end()ed on this path. Without an
        // explicit destroy() the underlying file descriptor leaks; on Windows a
        // lingering handle makes finalizePartial()'s rename throw (EPERM/EBUSY),
        // so it reports "no salvageable file" though a partial exists on disk.
        // destroy() releases the handle so the rename can succeed; we still
        // reject with the original error to preserve the surfacing behavior.
        s.destroy();
        reject(streamError);
        return;
      }
      s.end((err?: Error | null) => {
        const e = err ?? streamError;
        if (e) reject(e);
        else resolve();
      });
    });
  }

  return {
    async writePage(rows): Promise<void> {
      if (streamError) throw streamError;
      if (rows.length === 0) return;
      const columns = Object.keys(rows[0]!).map((name) => ({ name }));
      await ensureOpen(columns);
      for (const row of rows) writer!.writeRow(row);
      // A synchronous write can trigger an async 'error' — check before we
      // report progress or await drain.
      if (streamError) throw streamError;
      // Respect backpressure so a fast producer can't outrun the disk.
      await waitDrain(stream!);
      if (streamError) throw streamError;
    },
    async ensureFile(columns): Promise<void> {
      if (stream) return;
      if (columns && columns.length > 0) {
        await ensureOpen(columns);
        return;
      }
      // No known columns for a truly empty result → create an empty file so the
      // success message is truthful and downstream reads don't ENOENT.
      await mkdir(dirname(outPath), { recursive: true });
      stream = newStream();
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
      return closeStream();
    },
    async finalizePartial(): Promise<string | null> {
      if (!stream) return null;
      // Flush + close whatever landed; swallow any close error (the point is to
      // NOT surface a complete-looking file, not to succeed at closing).
      await closeStream().catch(() => {});
      const partial = `${outPath}.partial`;
      try {
        await rename(outPath, partial);
        return partial;
      } catch {
        // Rename failed (e.g. the file never materialized). Best-effort: report
        // no salvageable file rather than throwing during failure handling.
        return null;
      }
    },
  };
}
