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
