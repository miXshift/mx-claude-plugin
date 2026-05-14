/**
 * `mixshift data sample` — preview rows from a table with optional
 * seller_id scoping and a row limit. Buffered (small N expected).
 *
 * Builds the SQL via mysql2's identifier escaping so we never interpolate
 * user input into the statement string. Column lists are read from
 * tables.yaml via the schema dump.
 */

import { runQuery, type DataQueryResult } from './query-runner.js';
import { describeTable } from './tables-catalog.js';

export interface SampleOptions {
  table: string;
  sellerId?: number;
  limit?: number;
  dataDirOverride?: string;
}

export interface SampleResult {
  query_result: DataQueryResult<Record<string, unknown>>;
  /** SQL we ran (for logging / debugging). Parameters interpolated for display only. */
  display_sql: string;
}

export async function sampleTable(opts: SampleOptions): Promise<SampleResult> {
  const limit = opts.limit ?? 10;
  const metadata = await describeTable(opts.table);

  // Build SQL with safe identifier quoting + parameterized values
  const tableRef = '`' + opts.table.replace(/`/g, '') + '`';

  // For time-series tables with a known date column, sort by date DESC
  // so "sample 10 rows" returns the 10 most recent rows, not 10 from
  // storage order (which is usually the oldest rows). Sampling the
  // freshest data is almost always what the user wants.
  const orderBy =
    metadata?.time_series && metadata.date_column
      ? ` ORDER BY \`${metadata.date_column.replace(/`/g, '')}\` DESC`
      : '';

  let sql: string;
  const params: unknown[] = [];

  if (opts.sellerId !== undefined) {
    sql = `SELECT * FROM ${tableRef} WHERE SellerID = ?${orderBy} LIMIT ${Number(limit)}`;
    params.push(opts.sellerId);
  } else if (metadata?.requires_seller_id) {
    // The catalog says this table needs a seller_id filter. Don't run the
    // query unscoped — it'd be huge. Return a synthetic failure.
    return {
      query_result: {
        ok: false,
        kind: 'unknown',
        message: `Table ${opts.table} is time-series scoped. Pass --seller-id to filter.`,
        friendly: `Table \`${opts.table}\` requires a seller-id filter (it's a large time-series table). Pass --seller-id <N> to scope your sample.`,
      },
      display_sql: `SELECT * FROM ${tableRef} WHERE SellerID = <required>${orderBy} LIMIT ${limit}`,
    };
  } else {
    sql = `SELECT * FROM ${tableRef}${orderBy} LIMIT ${Number(limit)}`;
  }

  const result = await runQuery(sql, params, {
    dataDirOverride: opts.dataDirOverride,
  });

  return {
    query_result: result,
    display_sql:
      opts.sellerId !== undefined
        ? `SELECT * FROM ${tableRef} WHERE SellerID = ${opts.sellerId}${orderBy} LIMIT ${limit}`
        : sql,
  };
}
