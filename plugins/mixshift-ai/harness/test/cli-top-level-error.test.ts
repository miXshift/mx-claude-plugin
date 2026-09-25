/**
 * End-to-end check that cli.ts wires in its top-level error handling
 * (mx-ops#86). src/lib/cli/top-level-error.test.ts pins the handler itself,
 * but it builds its own program, so it cannot see whether cli.ts applies
 * exitOverride to the real command tree or passes the root --json flag in.
 * Drop either line and a commander usage error goes back to exiting
 * silently: exit 1, commander's stderr line, no envelope, no event. So this
 * spawns the real CLI through the tsx loader, the same way
 * check-named-pack-exit.test.ts does (cli.ts cannot be imported: it parses
 * the real argv and exits at module scope).
 *
 * Hermetic: MIXSHIFT_DATA_DIR is a fresh temp dir, proxy and MIXSHIFT_*
 * variables are cleared, and telemetry points at an ephemeral 127.0.0.1
 * server this suite runs, which records what the CLI's end-of-run flush
 * posts. `spawn`, not `spawnSync`, so this process's event loop can serve
 * that request.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(here, '..');
const CLI_PATH = join(HARNESS_DIR, 'src', 'cli.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface PostedEvent {
  event_name: string;
  error_class?: string | null;
  payload?: Record<string, unknown> | null;
}

let server: Server;
let endpoint: string;
let posted: PostedEvent[] = [];
let dataDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        posted.push(...(JSON.parse(body) as PostedEvent[]));
      } catch {
        // A malformed body leaves `posted` short and fails the assertions.
      }
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rest/v1/events`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  posted = [];
  dataDir = await mkdtemp(join(tmpdir(), 'mixshift-cli-error-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(https?|all|no)_proxy$/i.test(key) || /^MIXSHIFT_/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    MIXSHIFT_DATA_DIR: dataDir,
    MIXSHIFT_TELEMETRY: '1',
    MIXSHIFT_TELEMETRY_ENDPOINT: endpoint,
    MIXSHIFT_TELEMETRY_APIKEY: 'synthetic-test-key',
  };
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
      cwd: HARNESS_DIR,
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('cli.ts routes a commander usage error through the top-level catch', () => {
  it(
    '--json data query --seller-id: exit 1, usage_error envelope on stdout, one flushed plugin.crashed',
    async () => {
      const r = await runCli(['--json', 'data', 'query', '--sql', 'select 1', '--seller-id', '5']);
      expect(r.status, r.stderr).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({
        status: 'error',
        error_class: 'usage_error',
        message: "unknown option '--seller-id'",
      });
      const crashes = posted.filter((e) => e.event_name === 'plugin.crashed');
      expect(crashes).toHaveLength(1);
      expect(crashes[0]).toMatchObject({
        error_class: 'usage_error',
        payload: { user_facing: true, commander_code: 'commander.unknownOption' },
      });
    },
    60_000,
  );
});
