/**
 * Integration tests for hooks/session-start.mjs — spawned as a real
 * subprocess (it's a standalone, zero-dependency script; it cannot be
 * imported into the vitest module graph the way harness code can). Every
 * test controls the hook's env explicitly: a temp fake plugin root (with its
 * own .claude-plugin/plugin.json), a temp MIXSHIFT_DATA_DIR, a temp
 * CLAUDE_ENV_FILE, and MIXSHIFT_VERSION_CHECK_URL pointed at a closed local
 * port (http://127.0.0.1:1) so any live-fetch path fails instantly instead of
 * hitting the real network or timing out for 2.5s.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(here, '..', '..', 'hooks', 'session-start.mjs');
const DEAD_PORT_URL = 'http://127.0.0.1:1';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Spin up a real local HTTP server on 127.0.0.1 (an allowed
 *  MIXSHIFT_VERSION_CHECK_URL host) so a test can control exactly what the
 *  "marketplace fetch" returns, and/or prove whether it was ever hit. */
function startFakeMarketplace(
  handler: (res: import('node:http').ServerResponse) => void,
): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    let count = 0;
    const server = createServer((_req, res) => {
      count += 1;
      handler(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        requestCount: () => count,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'mixshift-hook-test-'));
});

afterEach(async () => {
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makePluginRoot(version: string): Promise<string> {
  const root = join(workDir, `plugin-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mixshift-ai', version }),
  );
  return root;
}

function setPluginVersion(pluginRoot: string, version: string): Promise<void> {
  return writeFile(
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'mixshift-ai', version }),
  );
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Async counterpart to runHook(), using `spawn` instead of `spawnSync`. Only
 * needed by tests that also run a local HTTP server IN THIS SAME (vitest)
 * process and expect the hook's live fetch to reach it: `spawnSync` blocks
 * this process's event loop for the whole child run, so the in-process
 * server could never accept the child's connection and every such request
 * would time out. `spawn` doesn't block, so the server can respond normally
 * while we await the child's exit.
 */
function runHookAsync(env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('runHookAsync timed out'));
    }, 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

function runHook(env: Record<string, string | undefined>): RunResult {
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function readStateFile(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'update-notice-state.json'), 'utf-8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

describe('session-start hook: first run', () => {
  it('records last_seen_version and prints nothing (no prior state)', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');

    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.5');
  });
});

describe('session-start hook: just-updated notice', () => {
  it('emits an "updated" notice exactly once, then falls silent', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    // Seed prior state as if the last session saw 0.8.5.
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: new Date().toISOString(),
      }),
    );

    // Now the install has moved on to 0.8.6.
    await setPluginVersion(pluginRoot, '0.8.6');

    const env = {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    };

    const first = runHook(env);
    expect(first.status).toBe(0);
    const parsed = JSON.parse(first.stdout.trim());
    expect(parsed.systemMessage).toContain('Updated 0.8.5 -> 0.8.6');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      'just updated from 0.8.5 to 0.8.6',
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain('mixshift whatsnew --dismiss');
    // No em dashes in customer-facing copy.
    expect(parsed.systemMessage).not.toContain('—');
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('—');

    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.6');

    const second = runHook(env);
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe('');
  });
});

describe('session-start hook: staleness notice', () => {
  it('emits a "stale" notice when the version-check cache says a newer version exists', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '0.9.0' }),
    );
    // Not a first-ever run: seed a prior last_seen_version equal to the
    // current version, so the staleness check (FIX 3 — never fire on a
    // genuinely fresh first install) is allowed to evaluate this run.
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.systemMessage).toContain('Update available: 0.8.5 -> 0.9.0');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('mixshift version');

    const state = await readStateFile(dataDir);
    expect(state?.stale_notice).toMatchObject({ version: '0.9.0' });
  });

  it('dismissed_version suppresses the stale notice for that version', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '0.9.0' }),
    );
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: '0.9.0',
        last_fetch_attempt_at: new Date().toISOString(),
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('throttles a repeat stale notice within 24h (records stale_notice.at)', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '0.9.0' }),
    );
    // Not a first-ever run — see comment in the previous test.
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const env = {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    };

    const first = runHook(env);
    expect(JSON.parse(first.stdout.trim()).systemMessage).toContain('Update available');
    const stateAfterFirst = await readStateFile(dataDir);
    expect(stateAfterFirst?.stale_notice).toMatchObject({ version: '0.9.0' });
    expect(typeof (stateAfterFirst?.stale_notice as { at?: string })?.at).toBe('string');

    // Second run within the same 24h window: silent, and stale_notice.at
    // does not get bumped (still the first timestamp).
    const second = runHook(env);
    expect(second.stdout.trim()).toBe('');
    const stateAfterSecond = await readStateFile(dataDir);
    expect(stateAfterSecond?.stale_notice).toEqual(stateAfterFirst?.stale_notice);
  });
});

describe('session-start hook: corrupt state file', () => {
  it('does not crash and always exits 0', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'update-notice-state.json'), '{ this is not json');

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    // Corrupt file collapses to empty state -> treated as first run.
    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.5');
  });

  it('does not crash when plugin.json itself is missing (skips the whole stage)', async () => {
    const pluginRoot = join(workDir, 'no-plugin-json');
    await mkdir(pluginRoot, { recursive: true });
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});

describe('session-start hook: CLAUDE_PLUGIN_DATA', () => {
  it('writes the state file under CLAUDE_PLUGIN_DATA when set, not MIXSHIFT_DATA_DIR', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    const pluginDataDir = join(workDir, 'plugin-data');
    await mkdir(dataDir, { recursive: true });
    await mkdir(pluginDataDir, { recursive: true });

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    const stateInPluginData = await readStateFile(pluginDataDir);
    const stateInDataDir = await readStateFile(dataDir);
    expect(stateInPluginData?.last_seen_version).toBe('0.8.5');
    expect(stateInDataDir).toBeNull();
  });
});

describe('session-start hook: PATH stage (unchanged semantics)', () => {
  it('still writes the PATH/MIXSHIFT_CLI exports exactly once across repeated invocations', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    const envFile = join(workDir, 'env-file.sh');

    const env = {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_ENV_FILE: envFile,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    };

    const first = runHook(env);
    expect(first.status).toBe(0);
    const afterFirst = await readFile(envFile, 'utf-8');
    expect(afterFirst).toContain('export MIXSHIFT_CLI=');
    expect(afterFirst).toContain('# mixshift-ai session PATH registration');

    // Simulate a resume: the hook fires again against the SAME env file.
    const second = runHook(env);
    expect(second.status).toBe(0);
    const afterSecond = await readFile(envFile, 'utf-8');

    const markerCount = (afterSecond.match(/# mixshift-ai session PATH registration/g) ?? [])
      .length;
    expect(markerCount).toBe(1);
    const cliExportCount = (afterSecond.match(/export MIXSHIFT_CLI=/g) ?? []).length;
    expect(cliExportCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Red-team regression coverage
// ---------------------------------------------------------------------------

describe('session-start hook: FIX 1 — poisoned marketplace version is rejected', () => {
  it('rejects a version containing a newline/backtick/space -> no notice, no crash', async () => {
    const pluginRoot = await makePluginRoot('0.1.0'); // deliberately far behind
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    const server = await startFakeMarketplace((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          plugins: [{ name: 'mixshift-ai', version: '9.9.9\n`rm -rf /` echo pwned' }],
        }),
      );
    });

    try {
      const res = await runHookAsync({
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        MIXSHIFT_DATA_DIR: dataDir,
        MIXSHIFT_VERSION_CHECK_URL: server.url,
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
      // The poisoned string never becomes a notice, in either channel.
      expect(res.stdout.trim()).toBe('');
      // It WAS fetched (the URL itself is a legitimate allowed host) — it was
      // rejected only after parsing, by isValidVersion.
      expect(server.requestCount()).toBe(1);

      const state = await readStateFile(dataDir);
      expect(state?.stale_notice).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe('session-start hook: FIX 1 — poisoned state file version is rejected', () => {
  it('treats a poisoned last_seen_version as absent (first-run), emits no notice', async () => {
    const pluginRoot = await makePluginRoot('0.8.6');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5\n`whoami`',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    // No "Updated <poisoned> -> 0.8.6" notice — the poisoned value never
    // reaches renderNotice(); it's dropped to null at readState() and this
    // becomes an (otherwise silent) first-ever run.
    expect(res.stdout.trim()).toBe('');

    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.6');
  });
});

describe('session-start hook: FIX 2 — MIXSHIFT_VERSION_CHECK_URL host restriction', () => {
  it('never dials a non-https override (protocol not in the allowlist)', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });

    // A real, listening local server — if the override were honored despite
    // its disallowed scheme, this would receive the request.
    const server = await startFakeMarketplace((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plugins: [{ name: 'mixshift-ai', version: '99.0.0' }] }));
    });
    const port = new URL(server.url).port;

    try {
      const res = runHook({
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        MIXSHIFT_DATA_DIR: dataDir,
        MIXSHIFT_VERSION_CHECK_URL: `ftp://127.0.0.1:${port}`,
      });

      expect(res.status).toBe(0);
      // The override was ignored outright — never contacted, at any protocol.
      expect(server.requestCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('honors an http://127.0.0.1 override (test affordance kept working)', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    // Not a first-ever run, so a stale notice is eligible to fire (FIX 3).
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const server = await startFakeMarketplace((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ plugins: [{ name: 'mixshift-ai', version: '0.9.0' }] }));
    });

    try {
      const res = await runHookAsync({
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        MIXSHIFT_DATA_DIR: dataDir,
        MIXSHIFT_VERSION_CHECK_URL: server.url,
      });

      expect(res.status).toBe(0);
      expect(server.requestCount()).toBe(1);
      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.systemMessage).toContain('Update available: 0.8.5 -> 0.9.0');
    } finally {
      await server.close();
    }
  });
});

describe('session-start hook: FIX 3 — no stale notice on a genuinely fresh first run', () => {
  it('emits nothing on a first-ever run even with a stale cache already present', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '9.9.9' }),
    );
    // No update-notice-state.json at all: first-ever run.

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.5');
    expect(state?.stale_notice).toBeNull();
  });
});

describe('session-start hook: FIX 4 — downgrades never emit an "updated" notice', () => {
  it('emits no notice on a downgrade, but still advances last_seen_version', async () => {
    const pluginRoot = await makePluginRoot('0.8.5'); // this install is OLDER than last seen
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.9.0',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: new Date().toISOString(), // throttled: no fetch this run
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(''); // no "Updated 0.9.0 -> 0.8.5"
    const state = await readStateFile(dataDir);
    expect(state?.last_seen_version).toBe('0.8.5');
  });

  it('a downgrade can still surface a legitimate stale notice', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '0.9.5' }),
    );
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.9.0',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
    });

    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.systemMessage).toContain('Update available: 0.8.5 -> 0.9.5');
  });
});

describe('session-start hook: FIX 5 — a future-dated cache timestamp is not "fresh"', () => {
  it('treats a future checked_at as expired and re-fetches instead of trusting it', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    const future = new Date(Date.now() + 10 * DAY_MS).toISOString();
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: future, latest_version: '9.9.9' }),
    );
    // Not a first-ever run, so a stale notice would normally be eligible.
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL, // re-fetch attempt fails instantly
    });

    expect(res.status).toBe(0);
    // If the future timestamp were trusted as "fresh" this would have
    // printed "Update available: 0.8.5 -> 9.9.9" straight from the corrupt
    // cache. Instead the cache is treated as expired, a live re-fetch is
    // attempted (and fails against the dead port), so nothing fires.
    expect(res.stdout.trim()).toBe('');
    const state = await readStateFile(dataDir);
    expect(typeof state?.last_fetch_attempt_at).toBe('string');
  });
});

describe('session-start hook: FIX 6 — full stdout flush before exit', () => {
  it('delivers the complete notice JSON even on the telemetry-disabled fast path', async () => {
    const pluginRoot = await makePluginRoot('0.8.5');
    const dataDir = join(workDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '0.9.0' }),
    );
    await writeFile(
      join(dataDir, 'update-notice-state.json'),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: null,
        dismissed_version: null,
        last_fetch_attempt_at: null,
      }),
    );

    const res = runHook({
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      MIXSHIFT_DATA_DIR: dataDir,
      MIXSHIFT_VERSION_CHECK_URL: DEAD_PORT_URL,
      MIXSHIFT_TELEMETRY: 'off', // forces the fast, no-telemetry path
    });

    expect(res.status).toBe(0);
    // JSON.parse throws on a truncated payload — this is the regression
    // check for the write-then-exit race.
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.systemMessage).toContain('Update available: 0.8.5 -> 0.9.0');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('mixshift version');
  });
});
