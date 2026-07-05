import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, saveState, emptyState, type ContextSyncState } from './state.js';
import { contextSyncStatePath } from '../paths/resolve.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-ctxsync-state-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function sampleState(): ContextSyncState {
  return {
    schema: 1,
    docs: {
      context: {
        server_revision: 4,
        last_synced_hash: 'a'.repeat(64),
        last_synced_at: '2026-07-01T00:00:00.000Z',
      },
      'corpus/tone.md': {
        server_revision: 2,
        last_synced_hash: 'b'.repeat(64),
        last_synced_at: '2026-07-02T00:00:00.000Z',
      },
    },
  };
}

describe('loadState / saveState round trip', () => {
  it('round-trips a state object', async () => {
    await saveState('acme', sampleState(), testDir);
    const loaded = await loadState('acme', testDir);
    expect(loaded).toEqual(sampleState());
  });

  it('returns the empty default when no file exists (missing brand dir too)', async () => {
    expect(await loadState('never-saved', testDir)).toEqual(emptyState());
  });

  it('returns the empty default on corrupt JSON', async () => {
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json !!!', 'utf8');
    expect(await loadState('acme', testDir)).toEqual(emptyState());
  });

  it('returns the empty default on a wrong shape (schema mismatch)', async () => {
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schema: 99, docs: {} }), 'utf8');
    expect(await loadState('acme', testDir)).toEqual(emptyState());
  });

  it('drops malformed per-doc entries but keeps the valid ones', async () => {
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        docs: {
          context: {
            server_revision: 3,
            last_synced_hash: 'c'.repeat(64),
            last_synced_at: '2026-07-01T00:00:00.000Z',
          },
          narrative: { server_revision: 'NaN' },
        },
      }),
      'utf8',
    );
    const loaded = await loadState('acme', testDir);
    expect(Object.keys(loaded.docs)).toEqual(['context']);
    expect(loaded.docs.context!.server_revision).toBe(3);
  });
});

describe('saveState atomicity + safety', () => {
  it('creates the brand dir when missing and leaves the final file (no tmp litter)', async () => {
    await saveState('fresh-brand', sampleState(), testDir);
    const path = contextSyncStatePath('fresh-brand', testDir);
    await access(path); // throws if the file isn't there
    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual(sampleState());
    const entries = await readdir(dirname(path));
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });

  it('never throws outward, even when the target path is unwritable', async () => {
    // Make <brandDir> a FILE so mkdir/rename under it must fail.
    await mkdir(join(testDir, 'clients'), { recursive: true });
    await writeFile(join(testDir, 'clients', 'blocked'), 'not a dir', 'utf8');
    await expect(saveState('blocked', sampleState(), testDir)).resolves.toBeUndefined();
    // And the corresponding load falls back to the default.
    expect(await loadState('blocked', testDir)).toEqual(emptyState());
  });
});
