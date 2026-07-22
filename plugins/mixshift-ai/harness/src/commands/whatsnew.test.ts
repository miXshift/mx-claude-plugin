/**
 * Command-level tests for `mixshift whatsnew --dismiss` — the counterpart to
 * the SessionStart hook's proactive update notice (hooks/session-start.mjs).
 * Full `whatsnew` rendering is covered by lib/changelog.test.ts +
 * manual/integration checks; this file focuses on the state-mutating
 * `--dismiss` path this feature adds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerWhatsnewCommand } from './whatsnew.js';
import { getPluginVersion } from '../lib/plugin-version.js';
import { updateNoticeStatePath } from '../lib/update-notice-state.js';

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

import { track, EventName } from '../lib/telemetry/index.js';
import * as updateNoticeState from '../lib/update-notice-state.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-whatsnew-dismiss-test-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerWhatsnewCommand(program);
  return program;
}

async function runWhatsnew(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'whatsnew', ...args]);
}

let stdoutChunks: string[];
let stderrChunks: string[];

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

describe('whatsnew --dismiss', () => {
  it('falls back to the installed version when there is no version-check cache', async () => {
    await runWhatsnew('--dismiss', '--data-dir', testDir);

    const raw = await readFile(updateNoticeStatePath(testDir), 'utf-8');
    const state = JSON.parse(raw);
    expect(state.dismissed_version).toBe(getPluginVersion());
    expect(stdoutText()).toContain(getPluginVersion());
  });

  it('uses the version-check cache when present, not the installed version', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'version-check.json'),
      JSON.stringify({ checked_at: new Date().toISOString(), latest_version: '99.9.9' }),
    );

    await runWhatsnew('--dismiss', '--data-dir', testDir);

    const raw = await readFile(updateNoticeStatePath(testDir), 'utf-8');
    const state = JSON.parse(raw);
    expect(state.dismissed_version).toBe('99.9.9');
    expect(stdoutText()).toContain('99.9.9');
  });

  it('preserves other state fields already on disk', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      updateNoticeStatePath(testDir),
      JSON.stringify({
        last_seen_version: '0.8.4',
        stale_notice: { version: '0.8.5', at: '2026-07-01T00:00:00.000Z' },
        dismissed_version: null,
        last_fetch_attempt_at: '2026-07-01T00:00:00.000Z',
      }),
    );

    await runWhatsnew('--dismiss', '--data-dir', testDir);

    const raw = await readFile(updateNoticeStatePath(testDir), 'utf-8');
    const state = JSON.parse(raw);
    expect(state.last_seen_version).toBe('0.8.4');
    expect(state.stale_notice).toEqual({ version: '0.8.5', at: '2026-07-01T00:00:00.000Z' });
    expect(state.dismissed_version).toBe(getPluginVersion());
  });

  it('prints a one-line confirmation with no em dash', async () => {
    await runWhatsnew('--dismiss', '--data-dir', testDir);
    const text = stdoutText();
    expect(text).not.toContain('—'); // em dash
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('emits update.dismissed telemetry', async () => {
    await runWhatsnew('--dismiss', '--data-dir', testDir);
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: EventName.UpdateDismissed,
        payload: expect.objectContaining({ latest: getPluginVersion() }),
      }),
    );
  });

  it('honors --json', async () => {
    await runWhatsnew('--dismiss', '--json', '--data-dir', testDir);
    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('ok');
    expect(parsed.dismissed_version).toBe(getPluginVersion());
  });

  it('FIX 7: a state-save failure prints a clean one-line error and exits nonzero, not a stack trace', async () => {
    const saveSpy = vi
      .spyOn(updateNoticeState, 'saveUpdateNoticeState')
      .mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await expect(runWhatsnew('--dismiss', '--data-dir', testDir)).resolves.not.toThrow();

    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // don't leak a nonzero exit code into the test runner

    const text = stderrText();
    expect(text).not.toContain('—'); // no em dash
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('EACCES');
    expect(stdoutText()).toBe(''); // nothing partial on stdout

    saveSpy.mockRestore();
  });

  it('FIX 7: a --json state-save failure reports a clean error envelope', async () => {
    const saveSpy = vi
      .spyOn(updateNoticeState, 'saveUpdateNoticeState')
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    await runWhatsnew('--dismiss', '--json', '--data-dir', testDir);

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;

    const parsed = JSON.parse(stdoutText());
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('ENOSPC');

    saveSpy.mockRestore();
  });
});
