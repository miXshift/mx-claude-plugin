/**
 * `mixshift data export` — bulk export rows from a warehouse table to CSV.
 *
 * Streams rows a PAGE at a time from the DB straight to disk (via
 * `streamQuery` + a CSV file sink) so tens-of-thousands-of-row exports never
 * hold the whole result set in memory. Date-range filtering uses the table's
 * configured date column from data-tables.yaml.
 *
 * No row limit enforced (per Sam: "I don't want to be too limiting").
 * Caller can pass --max-rows if they want a cap; otherwise it runs to
 * completion.
 */

import { createCsvFileSink, fmtBytes } from '../output/csv-file-sink.js';
import { streamQuery, type DataQueryResult } from './query-runner.js';
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

  // Stream each page straight to the CSV file and drop it — the full result
  // set is never held in memory. A user --max-rows lands as a trailing LIMIT
  // on `sql`, which the pager honors as a hard cap.
  const sink = createCsvFileSink(opts.outPath);
  let lastProgressRows = 0;
  const streamed = await streamQuery(sql, params, { dataDirOverride: opts.dataDirOverride }, async (rows) => {
    await sink.writePage(rows);
    // Report progress to stderr as it streams (coarse: at page boundaries).
    if (sink.rowsWritten() - lastProgressRows >= 1) {
      lastProgressRows = sink.rowsWritten();
      process.stderr.write(
        `  ... ${sink.rowsWritten()} rows (${fmtBytes(sink.bytesWritten())}) written\n`,
      );
    }
  });

  if (!streamed.ok) {
    await sink.close().catch(() => {});
    return {
      out_path: opts.outPath,
      rows_written: 0,
      duration_ms: streamed.durationMs,
      query_result: streamed.failure!,
      display_sql: displaySql,
    };
  }

  // Close the file so it is fully flushed before we return.
  await sink.close();

  return {
    out_path: opts.outPath,
    rows_written: streamed.rowCount,
    duration_ms: streamed.durationMs,
    // Synthetic success envelope: callers only read `.ok` on success (the rows
    // were streamed to disk, not retained).
    query_result: {
      ok: true,
      rows: [],
      rowCount: streamed.rowCount,
      durationMs: streamed.durationMs,
    },
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
