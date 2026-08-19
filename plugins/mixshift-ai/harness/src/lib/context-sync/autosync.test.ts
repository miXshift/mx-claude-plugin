import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  maybeAutoSync,
  AUTOSYNC_ENV,
  AUTOSYNC_BUDGET_MS,
  AUTOSYNC_THROTTLE_MS,
} from './autosync.js';
import type { ContextSyncClient } from './client.js';
import { hashContent } from './local.js';
import { PUSH_AFTER_WRITE_ENV } from './push-after-write.js';
import { contextSyncStatePath, brandDir, credentialsPath } from '../paths/resolve.js';
import type { ContextSyncState } from './state.js';
import type { WireManifestBrand } from './types.js';
import { resolveBrandFields } from '../brain/read.js';
import { track } from '../telemetry/index.js';

// Telemetry: stub track() so tests never touch the real on-disk queue (a
// bare temp dir can still resolve isTelemetryEnabled()=true off the plugin's
// bundled defaults) — same convention as commands/context.test.ts.
vi.mock('../telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-autosync-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(track).mockClear();
  await rm(testDir, { recursive: true, force: true });
});

/** Fake env WITHOUT VITEST so the test-runner guard doesn't short-circuit
 *  (autosync tests opt back in explicitly; see autosync.ts). */
const LIVE_ENV: NodeJS.ProcessEnv = {};

/** Autosync serves EXISTING local brands only; most tests need the dir. */
async function makeBrandDir(slug: string): Promise<void> {
  await mkdir(brandDir(slug, testDir), { recursive: true });
}

interface FakeClientState {
  manifestCalls: number;
  docFetches: string[];
  /** Docs the two-way half pushed (empty in pull-only mode). */
  docPushes: string[];
}

function countingClient(
  brands: WireManifestBrand[],
  docs: Record<string, { content: string; revision: number }>,
): { client: ContextSyncClient; state: FakeClientState } {
  const state: FakeClientState = { manifestCalls: 0, docFetches: [], docPushes: [] };
  const client: ContextSyncClient = {
    fetchManifest: async () => {
      state.manifestCalls += 1;
      return { ok: true, brands };
    },
    fetchDoc: async (brand, docType, corpusName) => {
      const key = docType === 'corpus' ? `corpus/${corpusName}` : docType;
      state.docFetches.push(key);
      const doc = docs[key];
      if (!doc) {
        return { ok: false, kind: 'not_found', message: 'nf', friendly: 'No such doc.' };
      }
      return {
        ok: true,
        doc: {
          brand_slug: brand,
          doc_type: docType,
          ...(corpusName !== undefined ? { corpus_name: corpusName } : {}),
          revision: doc.revision,
          content_hash: hashContent(doc.content),
          content: doc.content,
          sensitivity: 'internal',
          updated_at: '2026-07-04T00:00:00.000Z',
          updated_by_actor: 'jane@example.com',
        },
      };
    },
    // TWO-WAY since 0.8.8 (Sam 2026-08-04): the push half is legitimate now.
    // Record instead of throwing, so tests can assert exactly WHEN pushes
    // happen (never in pull-only mode; only local-ahead docs otherwise).
    putDoc: async (input) => {
      state.docPushes.push(
        input.doc_type === 'corpus' ? `corpus/${input.corpus_name}` : input.doc_type,
      );
      return { ok: true, status: 'updated', revision: (input.base_revision ?? 0) + 1 };
    },
    putAssignment: async () => ({ ok: true }),
  };
  return { client, state };
}

function manifestBrand(
  slug: string,
  docs: Array<{ key: string; content: string; revision: number }>,
): WireManifestBrand {
  return {
    brand_slug: slug,
    docs: docs.map((d) => {
      const isCorpus = d.key.startsWith('corpus/');
      return {
        doc_type: (isCorpus ? 'corpus' : d.key) as WireManifestBrand['docs'][number]['doc_type'],
        ...(isCorpus ? { corpus_name: d.key.slice('corpus/'.length) } : {}),
        revision: d.revision,
        content_hash: hashContent(d.content),
        sensitivity: 'internal',
        updated_at: '2026-07-04T00:00:00.000Z',
        updated_by_actor: 'jane@example.com',
      };
    }),
  };
}

async function writeLedger(
  brand: string,
  docs: ContextSyncState['docs'],
  extras: { lastAutosyncAt?: string; identity?: string } = {},
): Promise<void> {
  const path = contextSyncStatePath(brand, testDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schema: 2,
      ...(extras.identity !== undefined ? { identity: extras.identity } : {}),
      ...(extras.lastAutosyncAt !== undefined
        ? { last_autosync_at: extras.lastAutosyncAt }
        : {}),
      docs,
    }),
    'utf8',
  );
}

async function readLedger(brand: string): Promise<ContextSyncState> {
  return JSON.parse(
    await readFile(contextSyncStatePath(brand, testDir), 'utf8'),
  ) as ContextSyncState;
}

async function writeCredentials(opts: { expired?: boolean } = {}): Promise<void> {
  const path = credentialsPath(testDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 2,
      created_at: '2026-07-01T00:00:00.000Z',
      datahub: {
        api_base: 'https://mcp.example.test',
        access_token: 'test-token',
        refresh_token: 'refresh-token',
        expires_at: opts.expired
          ? '2020-01-01T00:00:00.000Z'
          : '2099-01-01T00:00:00.000Z',
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        user_id: 'u1',
        email: 'ops@example.com',
        person_label: 'sam@example.com',
        device_label: 'test-device',
        client_id: 'mx-claude-plugin',
      },
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Kill switch + guards
// ---------------------------------------------------------------------------

describe('kill switch', () => {
  it.each(['off', 'OFF', '0', 'false'])(
    `returns disabled and touches nothing when ${AUTOSYNC_ENV}=%s`,
    async (value) => {
      await makeBrandDir('acme');
      const { client, state } = countingClient([], {});
      const result = await maybeAutoSync('acme', {
        dataDirOverride: testDir,
        client,
        env: { [AUTOSYNC_ENV]: value },
      });
      expect(result).toEqual({ ran: false, reason: 'disabled' });
      expect(state.manifestCalls).toBe(0);
      // No throttle stamp either — disabled means ENTIRELY off.
      await expect(readFile(contextSyncStatePath('acme', testDir), 'utf8')).rejects.toThrow();
    },
  );

  it('is disabled by default under the test runner (VITEST guard)', async () => {
    await makeBrandDir('acme');
    const { client, state } = countingClient([], {});
    // No env passed → options.env undefined → process.env.VITEST applies.
    const result = await maybeAutoSync('acme', { dataDirOverride: testDir, client });
    expect(result).toEqual({ ran: false, reason: 'disabled' });
    expect(state.manifestCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Read-path safety: slugs + existence (a read stays a read)
// ---------------------------------------------------------------------------

describe('read-path safety', () => {
  it.each(['../evil', 'a/b', 'a\\b', '..', 'x..y', 'C:evil', 'spaced slug', ''])(
    'unsafe slug %j: skipped with the filesystem untouched',
    async (slug) => {
      const { client, state } = countingClient([], {});
      const result = await maybeAutoSync(slug, {
        dataDirOverride: testDir,
        client,
        env: LIVE_ENV,
      });
      expect(result).toEqual({
        ran: false,
        reason: 'skipped',
        detail: 'not a valid brand slug',
      });
      expect(state.manifestCalls).toBe(0);
      // Nothing was created anywhere under the data dir: the listing is
      // exactly what beforeEach made (empty), so no clients/ tree, no
      // dot-ledger, and nothing that could have escaped upward either.
      expect(await readdir(testDir)).toEqual([]);
    },
  );

  it('unknown-but-safe slug (typo): skipped, no phantom brand dir created', async () => {
    const { client, state } = countingClient([], {});
    const result = await maybeAutoSync('tpyo', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(state.manifestCalls).toBe(0);
    expect(await readdir(testDir)).toEqual([]);
  });

  it('skips the network when the throttle stamp cannot be persisted', async () => {
    await makeBrandDir('acme');
    // Make the state PATH a directory so saveState's rename must fail.
    await mkdir(contextSyncStatePath('acme', testDir), { recursive: true });
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(state.manifestCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant-identity rebind stays an explicit-sync behavior
// ---------------------------------------------------------------------------

describe('identity rebind protection', () => {
  const DOCS: ContextSyncState['docs'] = {
    narrative: {
      server_revision: 3,
      last_synced_hash: 'a'.repeat(64),
      last_synced_at: '2026-07-01T00:00:00.000Z',
    },
  };

  it('foreign-tenant ledger with tracked docs: skipped, disk untouched', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', DOCS, { identity: 'https://mcp.example.test#orgA' });
    const before = await readFile(contextSyncStatePath('acme', testDir), 'utf8');

    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#orgB',
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(state.manifestCalls).toBe(0);
    // The passive read persisted NOTHING: no doc wipe, no stamp.
    expect(await readFile(contextSyncStatePath('acme', testDir), 'utf8')).toBe(before);
  });

  it('foreign identity but EMPTY ledger: harmless, proceeds and rebinds', async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', {}, { identity: 'https://mcp.example.test#orgA' });
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#orgB',
    });
    expect(result.ran).toBe(true);
    expect((await readLedger('acme')).identity).toBe('https://mcp.example.test#orgB');
  });
});

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

describe('throttle', () => {
  it('runs at most once per window; the second call is a no-op', async () => {
    await makeBrandDir('acme');
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const first = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(first.ran).toBe(true);
    expect(state.manifestCalls).toBe(1);

    const second = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(second).toEqual({ ran: false, reason: 'throttled' });
    expect(state.manifestCalls).toBe(1);
  });

  it('persists the window in the ledger and reopens after 15 minutes', async () => {
    await makeBrandDir('acme');
    const t0 = new Date('2026-07-05T12:00:00.000Z');
    const { client, state } = countingClient([manifestBrand('acme', [])], {});

    await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      now: () => t0,
    });
    expect((await readLedger('acme')).last_autosync_at).toBe(t0.toISOString());

    // 14 minutes later: still closed.
    const at14 = new Date(t0.getTime() + 14 * 60_000);
    expect(
      await maybeAutoSync('acme', {
        dataDirOverride: testDir,
        client,
        env: LIVE_ENV,
        now: () => at14,
      }),
    ).toEqual({ ran: false, reason: 'throttled' });
    expect(state.manifestCalls).toBe(1);

    // Just past the window: runs again and restamps.
    const at16 = new Date(t0.getTime() + AUTOSYNC_THROTTLE_MS + 60_000);
    const third = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      now: () => at16,
    });
    expect(third.ran).toBe(true);
    expect(state.manifestCalls).toBe(2);
    expect((await readLedger('acme')).last_autosync_at).toBe(at16.toISOString());
  });

  it('a FAILED attempt also stamps the window (offline machines are not hammered)', async () => {
    await makeBrandDir('acme');
    const failingClient: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: false,
        kind: 'host_unreachable',
        message: 'fetch failed',
        friendly: 'unreachable',
      }),
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    };
    const first = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: failingClient,
      env: LIVE_ENV,
    });
    // pull() surfaces the manifest failure's friendly copy as its message.
    expect(first).toEqual({ ran: false, reason: 'failed', detail: 'unreachable' });

    const second = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: failingClient,
      env: LIVE_ENV,
    });
    expect(second).toEqual({ ran: false, reason: 'throttled' });
  });

  it('--force bypasses the throttle but still restamps', async () => {
    await makeBrandDir('acme');
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    await maybeAutoSync('acme', { dataDirOverride: testDir, client, env: LIVE_ENV });
    const forced = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      force: true,
    });
    expect(forced.ran).toBe(true);
    expect(state.manifestCalls).toBe(2);
  });

  it('throttles per brand, not globally', async () => {
    await makeBrandDir('acme');
    await makeBrandDir('zen');
    const { client, state } = countingClient(
      [manifestBrand('acme', []), manifestBrand('zen', [])],
      {},
    );
    await maybeAutoSync('acme', { dataDirOverride: testDir, client, env: LIVE_ENV });
    const other = await maybeAutoSync('zen', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(other.ran).toBe(true);
    expect(state.manifestCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pull safety: only conflict-free server changes; never pushes
// ---------------------------------------------------------------------------

describe('pull safety', () => {
  it('pulls server-ahead + server-only docs, leaves diverged and local-ahead untouched', async () => {
    const dir = brandDir('acme', testDir);
    await mkdir(join(dir, 'corpora'), { recursive: true });

    // narrative: local matches ledger (rev 1), server moved to rev 2 → server-ahead.
    await writeFile(join(dir, 'narrative.md'), 'old narrative\n', 'utf8');
    // corpus/tone.md: locally EDITED and server moved → diverged.
    await writeFile(join(dir, 'corpora', 'tone.md'), 'local tone edit\n', 'utf8');
    await writeLedger('acme', {
      narrative: {
        server_revision: 1,
        last_synced_hash: hashContent('old narrative\n'),
        last_synced_at: '2026-07-01T00:00:00.000Z',
      },
      'corpus/tone.md': {
        server_revision: 1,
        last_synced_hash: hashContent('synced tone\n'),
        last_synced_at: '2026-07-01T00:00:00.000Z',
      },
    });

    const serverDocs = {
      narrative: { content: 'new narrative\n', revision: 2 },
      'corpus/tone.md': { content: 'server tone\n', revision: 2 },
      'corpus/faq.md': { content: 'server-only faq\n', revision: 1 },
    };
    const { client, state } = countingClient(
      [
        manifestBrand('acme', [
          { key: 'narrative', content: 'new narrative\n', revision: 2 },
          { key: 'corpus/tone.md', content: 'server tone\n', revision: 2 },
          { key: 'corpus/faq.md', content: 'server-only faq\n', revision: 1 },
        ]),
      ],
      serverDocs,
    );

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.pulled).toBe(2); // narrative + faq
      expect(result.conflicts).toBe(1); // tone.md listed, untouched
      expect(result.errors).toBe(0);
    }

    // server-ahead + server-only were written...
    expect(await readFile(join(dir, 'narrative.md'), 'utf8')).toBe('new narrative\n');
    expect(await readFile(join(dir, 'corpora', 'faq.md'), 'utf8')).toBe('server-only faq\n');
    // ...the diverged doc was NOT.
    expect(await readFile(join(dir, 'corpora', 'tone.md'), 'utf8')).toBe('local tone edit\n');
    // And the diverged doc's content was never even fetched.
    expect(state.docFetches).not.toContain('corpus/tone.md');
    // Two-way rule: a DIVERGED doc is never pushed either (no force, ever).
    expect(state.docPushes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two-way + stake leg (Sam 2026-08-04): autosync pushes non-conflicting local
// changes and backfills structural_events, pull-only when publishing is off.
// ---------------------------------------------------------------------------

describe('two-way sync + stake leg', () => {
  const LOCAL_ONLY_CONTEXT = 'schema_version: 1\nbrand_slug: acme\n';

  async function writeLocalOnlyDoc(): Promise<void> {
    const dir = brandDir('acme', testDir);
    await mkdir(dir, { recursive: true });
    // A doc the server has never seen: local-only → the push half creates it.
    await writeFile(join(dir, 'narrative.md'), 'local-only narrative\n', 'utf8');
  }

  it('pushes a local-only doc (the two-way half) and reports pushed/created', async () => {
    await writeLocalOnlyDoc();
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(state.docPushes).toContain('narrative');
      expect(result.created + result.pushed).toBeGreaterThan(0);
      // No context.yaml in this fixture → the stake leg is a local no-op,
      // but it RAN (the publish half was enabled).
      expect(result.stake_events).toMatchObject({ skipped: true });
    }
  });

  it(`${PUSH_AFTER_WRITE_ENV}=off degrades to the original pull-only behavior`, async () => {
    await writeLocalOnlyDoc();
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: { ...LIVE_ENV, [PUSH_AFTER_WRITE_ENV]: 'off' },
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(state.docPushes).toEqual([]); // nothing pushed
      expect(result.stake_events).toBeUndefined(); // no stake leg either
    }
  });

  it('a brand with no structural_events skips the stake leg with zero network', async () => {
    const dir = brandDir('acme', testDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'context.yaml'), LOCAL_ONLY_CONTEXT, 'utf8');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      // Partial context fails validation → 'context not readable'; a VALID
      // context without events reports 'no structural events'. Either way:
      // skipped, no timeline traffic.
      expect(result.stake_events?.skipped).toBe(true);
      expect(result.stake_events?.created).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Budget + failure isolation
// ---------------------------------------------------------------------------

describe('budget and failure isolation', () => {
  it('pins the default budget so a regression cannot silently widen it', () => {
    expect(AUTOSYNC_BUDGET_MS).toBe(2_000);
    expect(AUTOSYNC_THROTTLE_MS).toBe(15 * 60 * 1_000);
  });

  it('a hung request is aborted by the budget and reported as a quiet failure', async () => {
    await makeBrandDir('acme');
    await writeCredentials();
    // fetchImpl that never resolves until its signal aborts.
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('operation aborted')),
        );
      })) as typeof fetch;

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      fetchImpl: hangingFetch,
      budgetMs: 50,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('failed');
  });

  it('a hung TOKEN REFRESH (global fetch, outside the client) is bounded by the deadline race', async () => {
    await makeBrandDir('acme');
    // Expired access token → getValidAccessToken refreshes through the
    // GLOBAL fetch (with its own 30s timeout) before any client fetch —
    // outside the fetchImpl budget, so only the deadline race covers it.
    await writeCredentials({ expired: true });
    const hangingGlobalFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    vi.stubGlobal('fetch', hangingGlobalFetch);

    const t0 = Date.now();
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      budgetMs: 100,
    });
    const elapsed = Date.now() - t0;
    expect(result).toEqual({
      ran: false,
      reason: 'failed',
      detail: 'timed out after 100ms',
    });
    expect(elapsed).toBeLessThan(2_000); // nowhere near the 30s refresh timeout
  });

  it('a client whose fetchManifest THROWS (async) is swallowed by the catch-all', async () => {
    await makeBrandDir('acme');
    const throwingClient: ContextSyncClient = {
      fetchManifest: async () => {
        throw new Error('async boom');
      },
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: true }),
    };
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: throwingClient,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ ran: false, reason: 'failed', detail: 'async boom' });
  });

  it('a client whose fetchManifest THROWS (sync) is swallowed by the catch-all', async () => {
    await makeBrandDir('acme');
    const throwingClient = {
      fetchManifest: () => {
        throw new Error('sync boom');
      },
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: true }),
    } as unknown as ContextSyncClient;
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: throwingClient,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ ran: false, reason: 'failed', detail: 'sync boom' });
  });

  it('no credentials → quiet failure, never a throw', async () => {
    await makeBrandDir('acme');
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      budgetMs: 100,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('failed');
    if (!result.ran && result.reason === 'failed') {
      expect(result.detail).toMatch(/credentials|auth/i);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveBrandFields integration (the real seam)
// ---------------------------------------------------------------------------

describe('resolveBrandFields integration', () => {
  const VALID_CONTEXT = {
    schema_version: 1,
    brand_slug: 'foragers-pantry',
    brand_name: "Forager's Pantry",
    last_updated: '2026-06-10',
    accounts: [
      {
        seller_id: 574,
        seller_name: 'Aspen Outdoor Provisions',
        account_type: 'SC',
        status: 'active',
        role: 'primary',
        marketplace: 'Amazon.com',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    },
    management: {
      primary_metric: 'ACOS',
      acos_target_pct: 22,
      attribution_window_days: 14,
    },
  };

  async function writeBrand(): Promise<string> {
    const dir = brandDir('foragers-pantry', testDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'context.yaml'), stringifyYaml(VALID_CONTEXT), 'utf-8');
    return dir;
  }

  it('offline: the local read is served unaffected', async () => {
    // Opt the hook back in: clear the VITEST guard for this test only.
    vi.stubEnv('VITEST', '');
    const dir = await writeBrand();

    // No credentials in testDir → the hook's sync attempt fails quietly;
    // the local read below must be entirely unaffected.
    const fields = await resolveBrandFields('foragers-pantry', testDir);
    expect(fields.acos_target_pct).toMatchObject({ value: 22, source: 'context' });
    expect(
      await readFile(join(dir, 'context.yaml'), 'utf-8'),
    ).toContain('acos_target_pct: 22');
  });

  it('a hung token refresh cannot hold the read past the default budget', async () => {
    vi.stubEnv('VITEST', '');
    await writeBrand();
    await writeCredentials({ expired: true });
    const hangingGlobalFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    vi.stubGlobal('fetch', hangingGlobalFetch);

    // This exercises the DEFAULT budget end to end: if a regression drops
    // the deadline race, this test hangs into the suite timeout.
    const t0 = Date.now();
    const fields = await resolveBrandFields('foragers-pantry', testDir);
    const elapsed = Date.now() - t0;
    expect(fields.acos_target_pct).toMatchObject({ value: 22, source: 'context' });
    expect(elapsed).toBeLessThan(AUTOSYNC_BUDGET_MS + 3_000);
  });

  it('a typo slug read leaves the clients tree untouched (no phantom dirs)', async () => {
    vi.stubEnv('VITEST', '');
    await writeBrand();
    await resolveBrandFields('tpyo-brand', testDir);
    const clients = await readdir(join(testDir, 'clients'));
    expect(clients).toEqual(['foragers-pantry']);
  });
});

// ---------------------------------------------------------------------------
// Ledger outcome fields + telemetry: written/fired ONLY for attempts that
// clear every early-skip guard (see the module doc).
// ---------------------------------------------------------------------------

describe('ledger outcome + telemetry', () => {
  it('a successful attempt records outcome success + success_at, and fires ContextAutosyncCompleted', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const t0 = new Date('2026-07-05T12:00:00.000Z');

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      now: () => t0,
    });
    expect(result.ran).toBe(true);

    const ledger = await readLedger('acme');
    expect(ledger.last_autosync_outcome).toBe('success');
    expect(ledger.last_autosync_success_at).toBe(t0.toISOString());
    expect(ledger.last_autosync_at).toBe(t0.toISOString());

    expect(vi.mocked(track)).toHaveBeenCalledTimes(1);
    const [event, dataDir] = vi.mocked(track).mock.calls[0]!;
    expect(event).toMatchObject({
      event_name: 'context_sync.autosync_completed',
      outcome: 'ok',
      payload: { trigger: 'preflight', brand: 'acme', ran: true },
    });
    expect(dataDir).toBe(testDir);
  });

  it('a failed attempt (client failure) records outcome failed, leaves success_at absent, fires outcome:failed', async () => {
    await makeBrandDir('acme');
    const failingClient: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: false,
        kind: 'host_unreachable',
        message: 'fetch failed',
        friendly: 'unreachable',
      }),
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    };

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: failingClient,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);

    const ledger = await readLedger('acme');
    expect(ledger.last_autosync_outcome).toBe('failed');
    expect(ledger.last_autosync_success_at).toBeUndefined();

    expect(vi.mocked(track)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(track).mock.calls[0]!;
    expect(event).toMatchObject({
      event_name: 'context_sync.autosync_completed',
      outcome: 'failed',
      payload: {
        trigger: 'preflight',
        brand: 'acme',
        ran: false,
        reason: 'failed',
        detail: 'unreachable',
      },
    });
  });

  it('a ran:true result with per-doc errors counts as ledger/telemetry failed, not success', async () => {
    const dir = brandDir('acme', testDir);
    await mkdir(dir, { recursive: true });
    const erroringClient: ContextSyncClient = {
      fetchManifest: async () => ({ ok: true, brands: [manifestBrand('acme', [])] }),
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'boom', friendly: 'boom' }),
      putAssignment: async () => ({ ok: true }),
    };
    await writeFile(join(dir, 'narrative.md'), 'local-only narrative\n', 'utf8');

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: erroringClient,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    if (result.ran) expect(result.errors).toBeGreaterThan(0);

    const ledger = await readLedger('acme');
    expect(ledger.last_autosync_outcome).toBe('failed');
    expect(ledger.last_autosync_success_at).toBeUndefined();

    const [event] = vi.mocked(track).mock.calls[0]!;
    expect(event).toMatchObject({ outcome: 'failed', payload: { ran: true } });
  });

  it('early-skip (disabled, kill switch): writes no outcome fields and fires no telemetry', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: { [AUTOSYNC_ENV]: 'off' },
    });
    expect(result).toEqual({ ran: false, reason: 'disabled' });
    expect(vi.mocked(track)).not.toHaveBeenCalled();
    // No ledger file at all — the kill switch touches no fs, ever.
    await expect(readFile(contextSyncStatePath('acme', testDir), 'utf8')).rejects.toThrow();
  });

  it('early-skip (unsafe slug): writes no outcome fields and fires no telemetry', async () => {
    const { client } = countingClient([], {});
    const result = await maybeAutoSync('../evil', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ ran: false, reason: 'skipped', detail: 'not a valid brand slug' });
    expect(vi.mocked(track)).not.toHaveBeenCalled();
  });

  it('early-skip (missing brand directory): writes no outcome fields and fires no telemetry', async () => {
    const { client } = countingClient([], {});
    const result = await maybeAutoSync('ghost', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(vi.mocked(track)).not.toHaveBeenCalled();
  });

  it('throttled (second call in-window): writes no NEW outcome fields and fires no telemetry', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    await maybeAutoSync('acme', { dataDirOverride: testDir, client, env: LIVE_ENV });
    vi.mocked(track).mockClear();

    const second = await maybeAutoSync('acme', { dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(second).toEqual({ ran: false, reason: 'throttled' });
    expect(vi.mocked(track)).not.toHaveBeenCalled();
  });

  it('a caller-supplied trigger (e.g. "manual") is threaded into the telemetry payload', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      trigger: 'manual',
    });
    const [event] = vi.mocked(track).mock.calls[0]!;
    expect(event).toMatchObject({ payload: { trigger: 'manual' } });
  });
});
