/**
 * `mixshift data export` — bulk export rows from a warehouse table to CSV.
 *
 * Streams rows directly from the DB to disk so 100K+ row exports don't
 * blow up memory. Date-range filtering uses the table's configured
 * date column from data-tables.yaml.
 *
 * No row limit enforced (per Sam: "I don't want to be too limiting").
 * Caller can pass --max-rows if they want a cap; otherwise it runs to
 * completion.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCsvWriter } from '../output/csv.js';
import { runQuery, type DataQueryResult } from './query-runner.js';
import { describeTable } from './tables-catalog.js';

export interface ExportOptions {
  table: string;
  sellerId?: number;
  startDate?: string;
  endDate?: string;
  outPath: string;
  maxRows?: number;
  dataDirOverride?: string;
}

export interface ExportResult {
  out_path: string;
  rows_written: number;
  duration_ms: number;
  query_result: DataQueryResult<Record<string, unknown>>;
  display_sql: string;
}

export async function exportTable(opts: ExportOptions): Promise<ExportResult> {
  const metadata = await describeTable(opts.table);
  const tableRef = '`' + opts.table.replace(/`/g, '') + '`';

  // Build WHERE clause
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.sellerId !== undefined) {
    where.push('SellerID = ?');
    params.push(opts.sellerId);
  } else if (metadata?.requires_seller_id) {
    return synthFailure(
      opts,
      `Table \`${opts.table}\` requires a seller-id filter. Pass --seller-id <N>.`,
    );
  }

  const dateCol = metadata?.date_column;
  if (opts.startDate || opts.endDate) {
    if (!dateCol) {
      return synthFailure(
        opts,
        `Cannot filter \`${opts.table}\` by date range — the catalog does not record a date column for this table.`,
      );
    }
    if (opts.startDate) {
      where.push(`\`${dateCol}\` >= ?`);
      params.push(opts.startDate);
    }
    if (opts.endDate) {
      where.push(`\`${dateCol}\` <= ?`);
      params.push(opts.endDate);
    }
  }

  const whereClause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const limitClause = opts.maxRows ? ` LIMIT ${Number(opts.maxRows)}` : '';
  const sql = `SELECT * FROM ${tableRef}${whereClause}${limitClause}`;

  // Display SQL with params interpolated for human reading
  let displaySql = sql;
  let paramIdx = 0;
  displaySql = displaySql.replace(/\?/g, () => {
    const v = params[paramIdx++];
    return typeof v === 'string' ? `'${v}'` : String(v);
  });

  // Buffered query — pulls all rows into memory then writes the CSV.
  // Future optimization: switch to true streaming for multi-million-row
  // pulls. v1 handles up to ~100K rows comfortably.
  const queryResult = await runQuery(sql, params, {
    dataDirOverride: opts.dataDirOverride,
  });

  if (!queryResult.ok) {
    return {
      out_path: opts.outPath,
      rows_written: 0,
      duration_ms: queryResult.durationMs ?? 0,
      query_result: queryResult,
      display_sql: displaySql,
    };
  }

  await mkdir(dirname(opts.outPath), { recursive: true });
  const stream = createWriteStream(opts.outPath, { encoding: 'utf-8' });

  const rows = queryResult.rows as Array<Record<string, unknown>>;
  let rowsWritten = 0;
  if (rows.length > 0) {
    const columns = Object.keys(rows[0]!).map((name) => ({ name }));
    const csvWriter = createCsvWriter(stream, columns);
    csvWriter.writeHeader();
    for (const row of rows) {
      csvWriter.writeRow(row);
    }
    rowsWritten = csvWriter.rowsWritten();
  }

  // Close stream cleanly so the file is fully flushed before we return.
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });

  return {
    out_path: opts.outPath,
    rows_written: rowsWritten,
    duration_ms: queryResult.durationMs,
    query_result: queryResult,
    display_sql: displaySql,
  };
}

function synthFailure(opts: ExportOptions, message: string): ExportResult {
  return {
    out_path: opts.outPath,
    rows_written: 0,
    duration_ms: 0,
    query_result: {
      ok: false,
      kind: 'unknown',
      message,
      friendly: message,
    },
    display_sql: '(query not run — preflight failed)',
  };
}
