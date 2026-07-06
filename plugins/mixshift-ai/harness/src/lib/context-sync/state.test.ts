import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadState,
  saveState,
  emptyState,
  resolveLedgerIdentity,
  type ContextSyncState,
} from './state.js';
import { contextSyncStatePath, credentialsPath } from '../paths/resolve.js';

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
    schema: 2,
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

  it('cleans up the tmp file when the final rename fails', async () => {
    // Make the state PATH a directory: mkdir(brandDir) and the tmp write
    // succeed, the rename onto a directory fails.
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(path, { recursive: true });
    await expect(saveState('acme', sampleState(), testDir)).resolves.toBeUndefined();
    const entries = await readdir(dirname(path));
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant binding (identity)
// ---------------------------------------------------------------------------

const ID_A = 'https://mcp.mixshift.io#42';
const ID_B = 'https://other.example.com#42';

describe('ledger identity binding', () => {
  it('round-trips docs and identity when identities match', async () => {
    await saveState('acme', { ...sampleState(), identity: ID_A }, testDir);
    const loaded = await loadState('acme', testDir, ID_A);
    expect(loaded.identity).toBe(ID_A);
    expect(loaded.docs).toEqual(sampleState().docs);
  });

  it('treats the ledger as empty when the stored identity differs (tenant switch)', async () => {
    await saveState('acme', { ...sampleState(), identity: ID_A }, testDir);
    const loaded = await loadState('acme', testDir, ID_B);
    expect(loaded.docs).toEqual({});
    // The NEW identity is adopted so the next save rebinds the ledger.
    expect(loaded.identity).toBe(ID_B);
  });

  it('trusts a pre-identity (schema 1) ledger and rebinds it on the next save', async () => {
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(dirname(path), { recursive: true });
    const legacy = { schema: 1, docs: sampleState().docs };
    await writeFile(path, JSON.stringify(legacy), 'utf8');

    const loaded = await loadState('acme', testDir, ID_A);
    expect(loaded.docs).toEqual(sampleState().docs); // tolerated, not dropped
    expect(loaded.schema).toBe(2);
    expect(loaded.identity).toBe(ID_A);

    await saveState('acme', loaded, testDir);
    const raw = JSON.parse(await readFile(path, 'utf8')) as ContextSyncState;
    expect(raw.schema).toBe(2);
    expect(raw.identity).toBe(ID_A);
  });

  it('skips the identity check when no current identity is available', async () => {
    await saveState('acme', { ...sampleState(), identity: ID_A }, testDir);
    expect((await loadState('acme', testDir)).docs).toEqual(sampleState().docs);
    expect((await loadState('acme', testDir, null)).docs).toEqual(sampleState().docs);
  });
});

// ---------------------------------------------------------------------------
// Autosync stamp (last_autosync_at)
// ---------------------------------------------------------------------------

describe('last_autosync_at (autosync throttle stamp)', () => {
  const STAMP = '2026-07-05T12:00:00.000Z';

  it('round-trips through save/load', async () => {
    await saveState('acme', { ...sampleState(), last_autosync_at: STAMP }, testDir);
    const loaded = await loadState('acme', testDir);
    expect(loaded.last_autosync_at).toBe(STAMP);
    expect(loaded.docs).toEqual(sampleState().docs);
  });

  it('is absent on files written before the field existed', async () => {
    await saveState('acme', sampleState(), testDir);
    expect((await loadState('acme', testDir)).last_autosync_at).toBeUndefined();
  });

  it('tolerates a non-string stamp by dropping it', async () => {
    const path = contextSyncStatePath('acme', testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ schema: 2, last_autosync_at: 12345, docs: sampleState().docs }),
      'utf8',
    );
    const loaded = await loadState('acme', testDir);
    expect(loaded.last_autosync_at).toBeUndefined();
    expect(loaded.docs).toEqual(sampleState().docs);
  });

  it('survives an identity rebind (docs drop, stamp stays)', async () => {
    await saveState(
      'acme',
      { ...sampleState(), identity: ID_A, last_autosync_at: STAMP },
      testDir,
    );
    const loaded = await loadState('acme', testDir, ID_B);
    expect(loaded.docs).toEqual({});
    expect(loaded.identity).toBe(ID_B);
    expect(loaded.last_autosync_at).toBe(STAMP);
  });
});

describe('resolveLedgerIdentity', () => {
  async function writeCreds(blocks: Record<string, unknown>): Promise<void> {
    const path = credentialsPath(testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schema_version: 2,
        created_at: '2026-07-01T00:00:00.000Z',
        ...blocks,
      }),
      'utf8',
    );
  }

  it('binds to api_base + user_id from the datahub block', async () => {
    await writeCreds({
      datahub: {
        api_base: 'https://mcp.mixshift.io',
        access_token: 'tok',
        refresh_token: 'ref',
        expires_at: '2026-07-05T00:00:00.000Z',
        refresh_expires_at: '2026-08-01T00:00:00.000Z',
        user_id: '42',
        email: 'ops@example.com',
        person_label: 'sam@example.com',
        device_label: 'test-box',
      },
    });
    expect(await resolveLedgerIdentity(testDir)).toBe('https://mcp.mixshift.io#42');
  });

  it('falls back to api_base + client_id from the service block', async () => {
    await writeCreds({
      service: {
        api_base: 'https://mcp.mixshift.io',
        client_id: 'svc_abcdef1234',
        client_secret: 'x'.repeat(24),
      },
    });
    expect(await resolveLedgerIdentity(testDir)).toBe('https://mcp.mixshift.io#svc_abcdef1234');
  });

  it('returns null when no credentials exist or the file is unreadable', async () => {
    expect(await resolveLedgerIdentity(testDir)).toBeNull();
    const path = credentialsPath(testDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    expect(await resolveLedgerIdentity(testDir)).toBeNull();
  });
});
