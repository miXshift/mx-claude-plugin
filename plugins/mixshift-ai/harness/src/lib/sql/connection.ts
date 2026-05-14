/**
 * MySQL connection helper for the harness.
 *
 * Per HARNESS-REWRITE.md decision #3, runtime skill queries route through
 * the MCP shim. This module handles the limited set of queries the
 * harness itself runs — auth setup's connection test (already done in
 * lib/auth/test-connection.ts) and brand discovery (this is the first
 * data-fetching path).
 *
 * The MCP server runs as a child of Claude (Cowork / Code) and serves
 * Claude's ad-hoc queries during skill execution. The harness, invoked
 * as a separate Node process, talks to MySQL directly via mysql2 with
 * the same credentials. Both paths hit the same warehouse.
 */

import mysql from 'mysql2/promise';
import { loadCredentials } from '../auth/credentials.js';
import type { MysqlCreds } from '../auth/schema.js';

export interface QueryOptions {
  /** Override credentials (mostly for tests). */
  creds?: MysqlCreds;
  /** Override data dir for cred lookup (mostly for tests). */
  dataDirOverride?: string;
  /** Connection timeout in ms. */
  connectTimeoutMs?: number;
}

export interface QueryResult<Row> {
  rows: Row[];
  fields: { name: string; type: number | undefined }[];
  rowCount: number;
}

/**
 * Run a parameterized SELECT and return typed rows.
 *
 * Always uses prepared statements (`?` placeholders). String interpolation
 * is never the right answer.
 */
export async function query<Row = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  options: QueryOptions = {},
): Promise<QueryResult<Row>> {
  const creds = await resolveCreds(options);
  const conn = await mysql.createConnection({
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
    connectTimeout: options.connectTimeoutMs ?? 10_000,
  });

  try {
    const [rows, fields] = await conn.query<mysql.RowDataPacket[]>(sql, params);
    return {
      rows: rows as unknown as Row[],
      fields: (fields ?? []).map((f) => ({ name: f.name, type: f.type })),
      rowCount: rows.length,
    };
  } finally {
    try {
      await conn.end();
    } catch {
      // ignore connection close errors
    }
  }
}

async function resolveCreds(options: QueryOptions): Promise<MysqlCreds> {
  if (options.creds) return options.creds;

  const { credentials } = await loadCredentials(options.dataDirOverride);
  if (!credentials || !credentials.mysql) {
    throw new Error(
      'No MySQL credentials configured. Run `mixshift auth setup` first.',
    );
  }
  return credentials.mysql;
}
