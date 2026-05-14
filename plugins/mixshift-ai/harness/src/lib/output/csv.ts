/**
 * CSV writing utilities — RFC 4180 compliant with MixShift conventions:
 *   - UTF-8 encoding
 *   - Headers on the first row
 *   - Dates as YYYY-MM-DD (no time component)
 *   - Comma separator
 *   - Strings quoted only when they contain quote/comma/newline
 *   - Empty cells written as nothing (not "null")
 *
 * Two flavors:
 *   - rowsToCsv(rows, columns): in-memory build for small result sets
 *   - createCsvWriter(stream, columns): streaming write for large pulls,
 *     piped to a file via fs.createWriteStream
 */

import type { Writable } from 'node:stream';

export interface CsvColumn {
  /** Column name as it appears in the row object. */
  name: string;
  /** Header label written to the first row. Defaults to name. */
  header?: string;
}

export function rowsToCsv(
  rows: Array<Record<string, unknown>>,
  columns: CsvColumn[],
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => quote(c.header ?? c.name)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => formatCell(row[c.name])).join(','));
  }
  // Trailing newline so the file ends cleanly (RFC 4180 §2)
  return lines.join('\n') + '\n';
}

export interface CsvWriter {
  writeHeader(): void;
  writeRow(row: Record<string, unknown>): void;
  /** Finish the writer (does not close the underlying stream). */
  end(): void;
  /** Rows written since creation, not counting the header. */
  rowsWritten(): number;
}

export function createCsvWriter(stream: Writable, columns: CsvColumn[]): CsvWriter {
  let written = 0;
  let headerWritten = false;
  return {
    writeHeader(): void {
      if (headerWritten) return;
      stream.write(columns.map((c) => quote(c.header ?? c.name)).join(',') + '\n');
      headerWritten = true;
    },
    writeRow(row: Record<string, unknown>): void {
      if (!headerWritten) this.writeHeader();
      stream.write(columns.map((c) => formatCell(row[c.name])).join(',') + '\n');
      written++;
    },
    end(): void {
      // intentionally don't close the stream — caller owns its lifecycle
    },
    rowsWritten(): number {
      return written;
    },
  };
}

// -----------------------------------------------------------------------
// Cell formatting
// -----------------------------------------------------------------------

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'string') return quote(value);
  // Buffers, objects, arrays — coerce to JSON string
  return quote(JSON.stringify(value));
}

function quote(value: string): string {
  // RFC 4180: quote when value contains quote, comma, CR, or LF.
  // Embedded quotes are doubled.
  if (/["\n,\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Format a Date as YYYY-MM-DD using UTC. Sam's call: date-only, no time.
 * If a workflow needs full timestamps, callers can format manually before
 * passing the value to the writer.
 */
function formatDate(d: Date): string {
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
