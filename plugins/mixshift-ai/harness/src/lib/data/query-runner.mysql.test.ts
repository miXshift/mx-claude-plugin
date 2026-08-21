/**
 * Regression test for BUG-009.
 *
 * The mysql path (runMysqlQuery) now passes mysql2 options
 * `supportBigNumbers: true, bigNumberStrings: true` to
 * mysql.createConnection(...) so BIGINT columns (DSP advertiserId, orderId,
 * ...) come back as strings and are never silently rounded past JS's
 * safe-integer range.
 *
 * Lives in its OWN file (separate from query-runner.test.ts) because the
 * module-level `vi.mock('mysql2/promise', ...)` here would otherwise stub
 * out the real mysql2 used by the datahub tests' resolve-preference cases.
 * Vitest isolates module mocks per test file, so keeping this apart avoids
 * cross-test interference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared spy, hoisted so the (hoisted) vi.mock factory below can close over
// it. createConnection returns a fake connection whose query() answers the
// two calls runMysqlQuery makes: the SET SESSION MAX_EXECUTION_TIME, then
// the user SELECT.
const { createConnection, fakeEnd } = vi.hoisted(() => {
  const fakeEnd = vi.fn().mockResolvedValue(undefined);
  const fakeQuery = vi
    .fn()
    // SET SESSION MAX_EXECUTION_TIME = ?
    .mockResolvedValueOnce([[], []])
    // the SELECT
    .mockResolvedValueOnce([[{ id: '1' }], []]);
  const createConnection = vi.fn().mockResolvedValue({
    query: fakeQuery,
    end: fakeEnd,
  });
  return { createConnection, fakeEnd };
});

vi.mock('mysql2/promise', () => ({
  // runner imports the default export (`import mysql from 'mysql2/promise'`)
  // and calls mysql.createConnection(...).
  default: { createConnection },
  createConnection,
}));

import { runQuery } from './query-runner.js';
import { saveCredentials, _refreshState } from '../auth/credentials.js';
import { newCredentials } from '../auth/schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-runner-mysql-test-'));
  _refreshState.inFlight = null;
  createConnection.mockClear();
  fakeEnd.mockClear();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

describe('runQuery :: mysql path (BUG-009 BIGINT-as-string options)', () => {
  it('passes supportBigNumbers + bigNumberStrings to createConnection', async () => {
    // Only a mysql block on disk → resolveCreds picks the mysql path.
    await saveCredentials(
      {
        ...newCredentials(),
        mysql: { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' },
      },
      testDir,
    );

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    // Sanity: the fake connection round-tripped through the mysql branch.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toEqual([{ id: '1' }]);
    }

    // The fix: BIGINT columns must come back as strings.
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        supportBigNumbers: true,
        bigNumberStrings: true,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Red-team fix 4: the legacy path's host_unreachable message stays
// self-contained network/VPN/allowlist guidance, WITHOUT a `mixshift
// doctor` pointer (doctor only probes the datahub/API host, never the
// warehouse mysql host — pointing a warehouse-unreachable user at it would
// diagnose the wrong thing) and WITHOUT borrowing classify.ts's
// fetch/sandbox-egress framing — a raw mysql2 TCP connection error is a
// different transport than the undici fetch failures classify.ts's
// describeFetchFailure classifies (no `.cause`, no "fetch failed" top
// message), so forcing it through that classifier would either not match at
// all or falsely claim the sandbox-proxy narrative for a failure that never
// went near an HTTP fetch.
// ---------------------------------------------------------------------------

describe('runQuery :: mysql path network failure (red-team fix 4)', () => {
  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3306'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND warehouse.example.test'],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH 10.0.0.1:3306'],
  ])('classifies %s as host_unreachable with self-contained network/VPN guidance, not the doctor pointer or the fetch-classifier text', async (code, message) => {
    await saveCredentials(
      {
        ...newCredentials(),
        mysql: { host: 'h', port: 3306, user: 'u', password: 'p', database: 'd' },
      },
      testDir,
    );
    createConnection.mockRejectedValueOnce(Object.assign(new Error(message), { code }));

    const result = await runQuery('SELECT 1', [], { dataDirOverride: testDir });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('host_unreachable');
      expect(result.raw_code).toBe(code);
      expect(result.friendly).toBe(
        'Could not reach the warehouse host. Check your network and, if you ' +
          "connect through a VPN or allowlist, that this machine's IP is still allowed.",
      );
      // `mixshift doctor` only probes the datahub/API host, never the
      // warehouse mysql host — pointing at it here would diagnose the
      // wrong thing (red-team fix 4).
      expect(result.friendly).not.toContain('mixshift doctor');
      // Never borrows classify.ts's sandbox-egress framing — this never
      // went near a fetch, so that narrative would misrepresent the
      // failure. "allowlist" itself is legitimate here: an IP allowlist on
      // the warehouse DB, not the sandbox's egress allowlist.
      expect(result.friendly).not.toMatch(/sandbox|Cowork|Claude Code/i);
    }
  });
});
