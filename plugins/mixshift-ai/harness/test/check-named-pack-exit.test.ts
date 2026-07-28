/**
 * Integration tests for scripts/check-named-pack.mjs's exit-code mapping —
 * spawned as a real subprocess through the `tsx` CLI entry point (the script
 * dynamically imports `.ts` source with `.js` specifiers, exactly like
 * `npm run check-named-pack` itself runs it: `"check-named-pack": "tsx
 * scripts/check-named-pack.mjs"`). Plain `node` cannot load it: even with
 * `--experimental-strip-types` it throws ERR_MODULE_NOT_FOUND on the first
 * `.js`-specifier-resolves-to-a-`.ts`-file import, because that resolution
 * remap is tsx's loader, not a Node builtin. So this suite spawns through
 * `require.resolve('tsx/cli')` to exercise the gate exactly as it really runs.
 *
 * Why this exists (red-team finding): the release gate's fail-CLOSED
 * behavior hinges entirely on checking `result.checked` before `result.ok`
 * (scripts/check-named-pack.mjs ~67-88). The shared library,
 * `checkNamedPackCompat` (src/lib/data/named-pack-check.ts), defaults to
 * `ok: true` whenever it could NOT verify (`checked: false`) — that fail-OPEN
 * default is correct and load-bearing for `mixshift doctor`
 * (src/commands/doctor.ts computes `network.ok && namedPack.ok` and never
 * reads `.checked` — an offline box or a fresh sign-in should read as
 * "couldn't check", not "broken"). This script deliberately inverts that:
 * it reads `.checked` first and fails closed ("don't ship a flip you
 * couldn't verify") — see the header comment above the gate below.
 *
 * Because `checked: false` always pairs with `ok: true`, a future refactor
 * that "simplifies" this script down to a single `if (!result.ok) exit(1)`
 * (dropping the `checked` branch) would silently convert the gate from
 * fail-closed to fail-open — a 404/unreachable manifest would print the
 * full "OK" id listing (with `rev=?` for everything) and exit 0. Nothing
 * short of an actual process spawn + exit-code assertion catches that, since
 * every unit test of the library function in isolation already documents
 * `ok: true` as the CORRECT return value for the unverifiable case.
 *
 * Hermetic: MIXSHIFT_DATA_DIR points at a fresh empty temp dir every test (no
 * credentials file -> no access token -> the legacy-endpoint fallback in
 * checkNamedPackCompat never triggers, matching a real CI runner that has
 * never run `mixshift auth login`), and MIXSHIFT_PACK_CHECK_API_BASE points
 * at a real ephemeral 127.0.0.1 server this suite controls. No real network.
 *
 * Uses `spawn` (not `spawnSync`) for the HTTP-backed cases: the fake server
 * lives in this same (vitest) process, and `spawnSync` would block this
 * process's event loop for the whole child run, so the server could never
 * accept the child's connection until the library's own 10s AbortSignal
 * timeout gave up (confirmed empirically while building this test — the
 * request took ~10.5s under spawnSync vs ~0.6s under spawn). Same gotcha
 * documented in test/session-start-hook.test.ts's runHookAsync.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadCatalog } from '../src/lib/prefetch/sql-library.js';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(here, '..');
const SCRIPT_PATH = join(HARNESS_DIR, 'scripts', 'check-named-pack.mjs');

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, SCRIPT_PATH], {
      cwd: HARNESS_DIR,
      env: { ...process.env, MIXSHIFT_SKIP_PACK_CHECK: undefined, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('runScript timed out'));
    }, 20_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

/** Spin up a real local HTTP server standing in for the deployed
 *  `/.well-known/mixshift-query-pack` manifest endpoint. */
function startFakeManifestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function jsonHandler(status: number, body: unknown) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

let namedIds: string[];
let emptyDataDir: string;

beforeAll(async () => {
  // Real catalog, not a fixture: this must track whatever `dispatch: named`
  // ids actually ship, or the test drifts from the gate it is locking in.
  const catalog = await loadCatalog();
  namedIds = catalog.queries
    .filter((q) => q.dispatch === 'named')
    .map((q) => q.id)
    .sort();
  expect(namedIds.length).toBeGreaterThan(0);
});

beforeEach(async () => {
  // Empty, credential-free data dir: readFileSync(.../auth/credentials)
  // throws ENOENT -> creds is undefined -> no access token -> the 404
  // fallback branch in checkNamedPackCompat never triggers. This is what an
  // actual GitHub Actions runner looks like (never ran `mixshift auth login`).
  emptyDataDir = await mkdtemp(join(tmpdir(), 'check-named-pack-test-'));
});

afterEach(async () => {
  await rm(emptyDataDir, { recursive: true, force: true }).catch(() => {});
});

describe('check-named-pack.mjs exit-code mapping (fail-closed regression lock)', () => {
  it('(a) manifest 404 -> exit 1 (unverifiable fails CLOSED, not open)', async () => {
    const server = await startFakeManifestServer(jsonHandler(404, { error: 'not found' }));
    try {
      const res = await runScript({
        MIXSHIFT_DATA_DIR: emptyDataDir,
        MIXSHIFT_PACK_CHECK_API_BASE: server.url,
      });
      expect(res.status).toBe(1);
      // Specifically the `!result.checked` branch, not some other failure.
      expect(res.stderr).toContain('returned HTTP 404');
    } finally {
      await server.close();
    }
  });

  it('(b) manifest 200 with valid schema but missing one catalog named id -> exit 1', async () => {
    const missingId = namedIds[0]!;
    const deployedIds = namedIds.slice(1);
    const server = await startFakeManifestServer(
      jsonHandler(200, {
        schema_version: 1,
        ids: deployedIds,
        revisions: Object.fromEntries(deployedIds.map((id) => [id, 'abc12345'])),
      }),
    );
    try {
      const res = await runScript({
        MIXSHIFT_DATA_DIR: emptyDataDir,
        MIXSHIFT_PACK_CHECK_API_BASE: server.url,
      });
      expect(res.status).toBe(1);
      // Specifically the `!result.ok` branch (checked succeeded, one id missing).
      expect(res.stdout).toContain(`MISS ${missingId}`);
      expect(res.stderr).toContain('NOT in the deployed pack');
      expect(res.stderr).toContain(missingId);
    } finally {
      await server.close();
    }
  });

  it('(c) manifest 200 with every named id present + matching schema_version -> exit 0', async () => {
    const server = await startFakeManifestServer(
      jsonHandler(200, {
        schema_version: 1,
        ids: namedIds,
        revisions: Object.fromEntries(namedIds.map((id) => [id, 'abc12345'])),
      }),
    );
    try {
      const res = await runScript({
        MIXSHIFT_DATA_DIR: emptyDataDir,
        MIXSHIFT_PACK_CHECK_API_BASE: server.url,
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`All ${namedIds.length} dispatch:named id(s) resolve`);
      expect(res.stdout).not.toContain('MISS ');
      expect(res.stderr).toBe('');
    } finally {
      await server.close();
    }
  });

  it('(d) MIXSHIFT_SKIP_PACK_CHECK=1 -> exit 0, stdout mentions SKIPPED, no network attempted', async () => {
    // Deliberately point at a closed local port: if the skip check ever
    // regressed and the script tried to reach the network anyway, this would
    // fail/hang instead of short-circuiting instantly and silently.
    const res = await runScript({
      MIXSHIFT_DATA_DIR: emptyDataDir,
      MIXSHIFT_PACK_CHECK_API_BASE: 'http://127.0.0.1:1',
      MIXSHIFT_SKIP_PACK_CHECK: '1',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SKIPPED');
  });
});
