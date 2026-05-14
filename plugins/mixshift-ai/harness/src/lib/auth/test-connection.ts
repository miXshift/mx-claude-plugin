/**
 * MySQL connection test for auth setup.
 *
 * The harness routes runtime queries through the MCP shim (see
 * docs/productization/HARNESS-REWRITE.md decision #3). The exception is
 * this one-time onboarding test: we connect directly via mysql2 to verify
 * the user's credentials work, then classify any failure so the auth
 * setup flow can offer the right remediation (IP whitelist request,
 * "fix your password", etc.).
 */

import mysql from 'mysql2/promise';
import type { MysqlCreds } from './schema.js';

export type FailureKind =
  | 'ip_not_allowed'
  | 'access_denied'
  | 'unknown_database'
  | 'host_unreachable'
  | 'timeout'
  | 'unknown';

export interface TestSuccess {
  ok: true;
}

export interface TestFailure {
  ok: false;
  kind: FailureKind;
  raw_code?: string;
  message: string;
}

export type TestResult = TestSuccess | TestFailure;

/**
 * Try a connection + `SELECT 1`. Returns a classified result.
 *
 * Timeouts default to 10s — longer waits aren't useful diagnostically.
 */
export async function testConnection(
  creds: MysqlCreds,
  timeoutMs = 10_000,
): Promise<TestResult> {
  let conn: mysql.Connection | undefined;
  try {
    conn = await mysql.createConnection({
      host: creds.host,
      port: creds.port,
      user: creds.user,
      password: creds.password,
      database: creds.database,
      connectTimeout: timeoutMs,
    });
    await conn.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return classify(err);
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {
        // ignore close errors; the test result is what matters
      }
    }
  }
}

function classify(err: unknown): TestFailure {
  const e = err as { code?: string; errno?: number; message?: string };
  const message = e.message ?? String(err);
  const code = e.code;

  // MySQL-level errors
  if (code === 'ER_HOST_NOT_PRIVILEGED' || code === 'ER_HOST_IS_BLOCKED') {
    return { ok: false, kind: 'ip_not_allowed', raw_code: code, message };
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR') {
    return { ok: false, kind: 'access_denied', raw_code: code, message };
  }
  if (code === 'ER_BAD_DB_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
    return { ok: false, kind: 'unknown_database', raw_code: code, message };
  }
  // Network-level errors
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST') {
    return { ok: false, kind: 'timeout', raw_code: code, message };
  }
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return { ok: false, kind: 'host_unreachable', raw_code: code, message };
  }
  return { ok: false, kind: 'unknown', raw_code: code, message };
}
