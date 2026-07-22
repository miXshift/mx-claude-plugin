import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadUpdateNoticeState,
  saveUpdateNoticeState,
  emptyUpdateNoticeState,
  updateNoticeStatePath,
  updateNoticeStateDir,
  UPDATE_NOTICE_STATE_FILENAME,
} from './update-notice-state.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-update-notice-state-test-'));
});

afterEach(async () => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('updateNoticeStateDir / updateNoticeStatePath', () => {
  it('uses the data dir override by default', () => {
    expect(updateNoticeStateDir(testDir)).toBe(testDir);
    expect(updateNoticeStatePath(testDir)).toBe(join(testDir, UPDATE_NOTICE_STATE_FILENAME));
  });

  it('prefers CLAUDE_PLUGIN_DATA over the data dir override', () => {
    process.env.CLAUDE_PLUGIN_DATA = join(testDir, 'plugin-data');
    expect(updateNoticeStateDir(testDir)).toBe(join(testDir, 'plugin-data'));
  });
});

describe('loadUpdateNoticeState', () => {
  it('returns the empty state when no file exists', async () => {
    const state = await loadUpdateNoticeState(testDir);
    expect(state).toEqual(emptyUpdateNoticeState());
  });

  it('round-trips a saved state', async () => {
    const written = {
      last_seen_version: '0.8.5',
      stale_notice: { version: '0.9.0', at: '2026-07-01T00:00:00.000Z' },
      dismissed_version: null,
      last_fetch_attempt_at: '2026-07-01T00:00:00.000Z',
    };
    await saveUpdateNoticeState(written, testDir);
    const read = await loadUpdateNoticeState(testDir);
    expect(read).toEqual(written);
  });

  it('treats a corrupt (invalid JSON) file as empty state', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(updateNoticeStatePath(testDir), '{ not valid json', 'utf-8');
    const state = await loadUpdateNoticeState(testDir);
    expect(state).toEqual(emptyUpdateNoticeState());
  });

  it('recovers valid fields from a partially-shaped file rather than discarding everything', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      updateNoticeStatePath(testDir),
      JSON.stringify({
        last_seen_version: '0.8.5',
        stale_notice: 'not-an-object', // wrong shape
        dismissed_version: 42, // wrong type
        // last_fetch_attempt_at omitted entirely
      }),
      'utf-8',
    );
    const state = await loadUpdateNoticeState(testDir);
    expect(state.last_seen_version).toBe('0.8.5');
    expect(state.stale_notice).toBeNull();
    expect(state.dismissed_version).toBeNull();
    expect(state.last_fetch_attempt_at).toBeNull();
  });

  it('writes atomically (no .tmp sibling left behind)', async () => {
    await saveUpdateNoticeState(emptyUpdateNoticeState(), testDir);
    const raw = await readFile(updateNoticeStatePath(testDir), 'utf-8');
    expect(JSON.parse(raw)).toEqual(emptyUpdateNoticeState());
  });

  it('honors CLAUDE_PLUGIN_DATA for both save and load', async () => {
    const pluginDataDir = join(testDir, 'plugin-data');
    process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
    const written = { ...emptyUpdateNoticeState(), last_seen_version: '1.2.3' };
    await saveUpdateNoticeState(written, testDir);
    const read = await loadUpdateNoticeState(testDir);
    expect(read.last_seen_version).toBe('1.2.3');
    // Landed under CLAUDE_PLUGIN_DATA, not the plain data dir.
    const raw = await readFile(join(pluginDataDir, UPDATE_NOTICE_STATE_FILENAME), 'utf-8');
    expect(JSON.parse(raw).last_seen_version).toBe('1.2.3');
  });
});
