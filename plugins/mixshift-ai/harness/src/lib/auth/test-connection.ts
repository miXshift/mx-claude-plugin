/**
 * Connection-test helpers for auth setup.
 *
 * Two flavors:
 *
 *   - `testConnection(mysqlCreds)` — legacy raw-MySQL path. Connects
 *     directly via mysql2 to verify the user's credentials work, then
 *     classifies any failure so the auth setup flow can offer the right
 *     remediation (IP whitelist request, "fix your password", etc.).
 *
 *   - `testDatahubConnection(datahubCreds)` — token-based path. Hits
 *     GET /auth/echo with the Bearer token and parses the response
 *     for `db_reachable` + identity claims. Used by `mixshift auth
 *     login` for post-login verification, and by any future
 *     `mixshift auth status` command.
 */

import mysql from 'mysql2/promise';
import type { DatahubCreds, MysqlCreds } from './schema.js';

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

// ---------------------------------------------------------------------------
// Datahub (token-based) connection test
// ---------------------------------------------------------------------------

export type DatahubFailureKind =
  | 'unauthorized'
  | 'host_unreachable'
  | 'timeout'
  | 'unknown';

export interface DatahubEchoClaims {
  user_id: string;
  email: string;
  /** Per-employee actor email (a.k.a. `person_label` locally). */
  actor: string;
  client_id: string;
  sid: string;
}

export interface DatahubTestSuccess {
  ok: true;
  db_reachable: boolean;
  claims: DatahubEchoClaims;
}

export interface DatahubTestFailure {
  ok: false;
  kind: DatahubFailureKind;
  raw_status?: number;
  message: string;
}

export type DatahubTestResult = DatahubTestSuccess | DatahubTestFailure;

/**
 * Hit GET /auth/echo with the current access token. Returns whether the
 * service round-trip works AND whether the tenant DB is reachable from
 * the service side (the most informative single check).
 *
 * Does NOT auto-refresh on 401. Callers that want refresh behavior
 * should go through getValidAccessToken first.
 */
export async function testDatahubConnection(
  creds: DatahubCreds,
  timeoutMs = 10_000,
): Promise<DatahubTestResult> {
  let res: Response;
  try {
    res = await fetch(`${creds.api_base}/auth/echo`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${creds.access_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(message)) {
      return { ok: false, kind: 'timeout', message };
    }
    return {
      ok: false,
      kind: 'host_unreachable',
      message: `Could not reach ${creds.api_base}: ${message}`,
    };
  }

  if (res.status === 401) {
    return {
      ok: false,
      kind: 'unauthorized',
      raw_status: 401,
      message:
        'Auth service returned 401 from /auth/echo. ' +
        'Run `mixshift auth login` to re-authenticate.',
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    return {
      ok: false,
      kind: 'unknown',
      raw_status: res.status,
      message: `/auth/echo returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    };
  }

  const json = (await res.json()) as {
    ok: true;
    user_id: string;
    email: string;
    actor: string;
    client_id: string;
    sid: string;
    db_reachable: boolean;
  };
  return {
    ok: true,
    db_reachable: json.db_reachable === true,
    claims: {
      user_id: json.user_id,
      email: json.email,
      actor: json.actor,
      client_id: json.client_id,
      sid: json.sid,
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL (legacy) classification helper
// ---------------------------------------------------------------------------

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
