import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  maybeAutoSync,
  getCachedOrgManifest,
  AUTOSYNC_ENV,
  AUTOSYNC_BUDGET_MS,
  AUTOSYNC_THROTTLE_MS,
  __resetAutosyncNotices,
} from './autosync.js';
import type { ContextSyncClient } from './client.js';
import { hashContent } from './local.js';
import { PUSH_AFTER_WRITE_ENV, TELEMETRY_EMIT_BUDGET_MS } from './push-after-write.js';
import {
  contextSyncStatePath,
  brandDir,
  credentialsPath,
  orgManifestCachePath,
} from '../paths/resolve.js';
import { loadState } from './state.js';
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

  it('unknown-but-safe slug (typo), absent from the org manifest: skipped, no phantom brand dir created', async () => {
    // Since the seed path (D-032), a missing dir now consults the org
    // manifest instead of skipping outright — so this DOES cost one fetch
    // (see the "seed path" describe block below for the full contract).
    // The path-safety property under test here is narrower and unchanged:
    // a slug the manifest doesn't list still creates nothing.
    const { client, state } = countingClient([manifestBrand('someone-else', [])], {});
    const result = await maybeAutoSync('tpyo', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(state.manifestCalls).toBe(1);
    // No clients/ tree at all: mkdir only ever happens for a slug the org
    // store itself lists, and 'tpyo' isn't in it.
    await expect(readdir(join(testDir, 'clients'))).rejects.toThrow();
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
    // An unpersistable throttle stamp is one of the documented telemetry-
    // silent early-skip categories (see the module doc): this never clears
    // the guards, so finish() never runs and track() must never fire.
    expect(vi.mocked(track)).not.toHaveBeenCalled();
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
    // Explicit, field-level version of the byte-equality check above: a
    // foreign-tenant ledger is one of the documented telemetry-silent
    // early-skip categories — this never clears the guards, so finish()
    // never runs, no ledger outcome fields get written, and track() never
    // fires.
    const afterState = await readLedger('acme');
    expect(afterState.last_autosync_outcome).toBeUndefined();
    expect(afterState.last_autosync_success_at).toBeUndefined();
    expect(vi.mocked(track)).not.toHaveBeenCalled();
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
// US4 honest notice: "your team has context here, this session just could
// not reach it" (design doc §2 / research doc §2's "silent single 2s
// attempt" gap). Modeled on push-after-write.ts's own notice tests.
// ---------------------------------------------------------------------------

describe('US4 honest notice: org has this brand, this attempt could not reach it', () => {
  let stderrChunks: string[];
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    // The notice dedup is a module-level Set that outlives one test; clear
    // it so each case starts with a clean slate (and dedup can be asserted
    // directly). Mirrors push-after-write.test.ts's identical setup.
    __resetAutosyncNotices();
    stderrChunks = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        stderrChunks.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const stderrText = (): string => stderrChunks.join('');

  /** A client whose fetchManifest fails network-shaped (kind:'host_unreachable'),
   *  exactly what client.ts/classify.ts now produce for a real sandbox block. */
  const HOST_UNREACHABLE_CLIENT: ContextSyncClient = {
    fetchManifest: async () => ({
      ok: false,
      kind: 'host_unreachable',
      message: 'fetch failed',
      friendly: 'Could not reach mcp.mixshift.io. Run `mixshift doctor` for the steps.',
    }),
    fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
  };

  /** Warm the org-manifest CACHE FILE directly via getCachedOrgManifest (a
   *  throwaway client — this only seeds the disk cache maybeAutoSync's
   *  notice check reads; it is never itself invoked by the test's own
   *  maybeAutoSync call below). */
  async function warmCache(identity: string, brands: WireManifestBrand[]): Promise<void> {
    const { client } = countingClient(brands, {});
    const warm = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      identity,
    });
    expect(warm.ok).toBe(true);
  }

  it('fires once, with the exact wording, when the cache says the org has this brand and the attempt fails network-shaped', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('failed');
    expect(stderrText()).toBe(
      'Your team has context for acme, but this session could not reach the ' +
        'org store just now. Your local copy, if any, is unchanged. Run ' +
        '`mixshift doctor` if this keeps happening.\n',
    );
  });

  it('also fires on a budget DEADLINE (no `kind` available there; a wall-clock death is network-shaped by construction)', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);
    // Same pattern as the "hung TOKEN REFRESH" budget-isolation test above:
    // an expired token forces getValidAccessToken to refresh through the
    // GLOBAL fetch, stubbed here to a Promise that never settles and never
    // wires up the abort signal at all — deterministically hits raceDeadline's
    // own timer (unlike racing an abortable client fetch against it, which
    // can resolve via the abort-triggered envelope failure on the same tick).
    await writeCredentials({ expired: true });
    const hangingGlobalFetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    vi.stubGlobal('fetch', hangingGlobalFetch);

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      env: LIVE_ENV,
      budgetMs: 50,
      identity: 'id-A',
    });

    expect(result).toEqual({ ran: false, reason: 'failed', detail: 'timed out after 50ms' });
    expect(stderrText()).toContain('Your team has context for acme');
  });

  it('dedupes: two failed attempts for the same brand print the notice exactly once', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);

    await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
      force: true,
    });
    await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
      force: true, // bypass the throttle so this is a SECOND real attempt
    });

    expect(
      stderrChunks.filter((c) => c.includes('Your team has context for acme')).length,
    ).toBe(1);
  });

  it('does NOT fire on a successful attempt', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);
    const { client } = countingClient([manifestBrand('acme', [])], {});

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(true);
    expect(stderrText()).toBe('');
  });

  it('does NOT fire when the manifest cache exists but has no entry for this brand', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('other-brand', [])]);

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(false);
    expect(stderrText()).toBe('');
  });

  it('does NOT fire when no org-manifest cache exists at all', async () => {
    await makeBrandDir('acme');
    // No warmCache call: cold, no cache file on disk.

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(false);
    expect(stderrText()).toBe('');
  });

  it('does NOT fire when the cache was warmed under a DIFFERENT tenant identity', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-B', // different tenant than the cache was warmed under
    });

    expect(result.ran).toBe(false);
    expect(stderrText()).toBe('');
  });

  it('does NOT fire on a non-network failure kind (e.g. insufficient_scope): a different, already-surfaced problem', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);
    const scopedClient: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: false,
        kind: 'insufficient_scope',
        message: 'missing scope',
        friendly: 'Your token lacks context:read.',
      }),
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    };

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: scopedClient,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('failed');
    expect(stderrText()).toBe('');
  });

  it('does NOT fire when MIXSHIFT_CONTEXT_AUTOSYNC=off, even with a matching warm cache', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: { [AUTOSYNC_ENV]: 'off' },
      identity: 'id-A',
    });

    expect(result).toEqual({ ran: false, reason: 'disabled' });
    expect(stderrText()).toBe('');
  });

  it('does NOT fire on a throttled skip, even though the first attempt already failed network-shaped', async () => {
    await makeBrandDir('acme');
    await warmCache('id-A', [manifestBrand('acme', [])]);

    await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });
    expect(stderrChunks.length).toBe(1); // the first attempt's own notice

    stderrChunks.length = 0; // isolate the throttled call's own output
    const second = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(second).toEqual({ ran: false, reason: 'throttled' });
    expect(stderrText()).toBe('');
  });

  it('does NOT fire on an unsafe slug (never clears the guards)', async () => {
    const result = await maybeAutoSync('../evil', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result).toEqual({ ran: false, reason: 'skipped', detail: 'not a valid brand slug' });
    expect(stderrText()).toBe('');
  });

  it('does NOT fire on a missing-dir-and-unlisted skip (the seed path declines before any guard clears)', async () => {
    // No makeBrandDir; the org manifest cache doesn't list this slug either.
    await warmCache('id-A', [manifestBrand('other-brand', [])]);

    const result = await maybeAutoSync('ghost-town', {
      dataDirOverride: testDir,
      client: HOST_UNREACHABLE_CLIENT,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    expect(stderrText()).toBe('');
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

  it('trigger "manual" suppresses the internal emit (the CLI wrapper owns the row) but still records the ledger outcome', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      trigger: 'manual',
    });
    expect(result.ran).toBe(true);
    // No internal ContextAutosyncCompleted for manual runs — commands/
    // context.ts emits the single authoritative row for the invocation.
    expect(vi.mocked(track)).not.toHaveBeenCalled();
    // The ledger outcome is trigger-agnostic: written for manual runs too.
    const state = await loadState('acme', testDir);
    expect(state.last_autosync_outcome).toBe('success');
    expect(state.last_autosync_success_at).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// FIX A (red team, empirically reproduced): finish() used to save the STALE
// pre-attempt state object AFTER op() (pull/sync) had already loaded, mutated,
// and persisted its OWN state inside engine.ts's buildDocPairs — silently
// clobbering every per-doc revision + the stake-sync `stakes` stamp back to
// their pre-attempt values. finish() must re-load the ledger fresh before
// stamping the outcome fields onto it.
// ---------------------------------------------------------------------------

describe("finish() does not clobber the engine's own save (FIX A)", () => {
  it("a successful pull's per-doc revision survives the outcome save, alongside last_autosync_outcome", async () => {
    const dir = brandDir('acme', testDir);
    await mkdir(dir, { recursive: true });
    // narrative: local matches the ledger (rev 1); server moved to rev 2 →
    // server-ahead, so this attempt actually pulls something (mirrors the
    // existing 'pull safety' fixture above).
    await writeFile(join(dir, 'narrative.md'), 'old narrative\n', 'utf8');
    await writeLedger('acme', {
      narrative: {
        server_revision: 1,
        last_synced_hash: hashContent('old narrative\n'),
        last_synced_at: '2026-07-01T00:00:00.000Z',
      },
    });

    const serverDocs = { narrative: { content: 'new narrative\n', revision: 2 } };
    const { client } = countingClient(
      [manifestBrand('acme', [{ key: 'narrative', content: 'new narrative\n', revision: 2 }])],
      serverDocs,
    );

    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.pulled).toBe(1);
      expect(result.errors).toBe(0);
    }

    // The engine's OWN saveState (engine.ts's sync()/pull(), buildDocPairs)
    // persisted the pulled doc's new revision BEFORE finish() ran. Before the
    // fix, finish()'s later save reused the pre-attempt `ledgerState` object
    // (loaded before op() ran) and overwrote this with rev 1 — a successful
    // pull would then read back as 'diverged' on the very next status check.
    const ledger = await readLedger('acme');
    expect(ledger.docs.narrative?.server_revision).toBe(2);
    expect(ledger.docs.narrative?.last_synced_hash).toBe(hashContent('new narrative\n'));
    // ...and the outcome fields finish() is responsible for still land
    // alongside it, on the SAME save.
    expect(ledger.last_autosync_outcome).toBe('success');
    expect(ledger.last_autosync_success_at).toBeTruthy();
  });

  it("a pre-existing stakes stamp survives finish()'s outcome save", async () => {
    await makeBrandDir('acme');
    await writeLedger('acme', {});
    // Seed a stakes stamp directly, as a prior real stake-sync would have
    // left it — cheaper than driving a full stake-sync leg through this
    // fixture (a valid context.yaml + structural_events + a stake client),
    // and this fixture only needs to prove the stamp SURVIVES finish(), not
    // that the stake leg itself works (that's covered elsewhere).
    const statePath = contextSyncStatePath('acme', testDir);
    const seeded = JSON.parse(await readFile(statePath, 'utf8')) as ContextSyncState;
    seeded.stakes = {
      last_synced_hash: 'deadbeef'.repeat(8),
      last_synced_at: '2026-07-01T00:00:00.000Z',
    };
    await writeFile(statePath, JSON.stringify(seeded), 'utf8');

    // No context.yaml in this brand dir → the stake leg's own fast path
    // ("context not readable") never loads or saves state, so the seeded
    // stamp is untouched by anything except finish()'s reload+save.
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);

    const ledger = await readLedger('acme');
    expect(ledger.stakes).toEqual({
      last_synced_hash: 'deadbeef'.repeat(8),
      last_synced_at: '2026-07-01T00:00:00.000Z',
    });
    expect(ledger.last_autosync_outcome).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// FIX C (privacy): a `detail` value entering telemetry is scrubbed of local
// filesystem paths (see telemetry-detail.ts's own unit tests for the scrub
// rules themselves). This pins the WIRING — that finish() actually routes
// `detail` through scrubDetail — not just the helper in isolation. The value
// returned to the CALLER (AutoSyncResult.detail) stays the real, unscrubbed
// message; scrubbing is telemetry-only.
// ---------------------------------------------------------------------------

describe('telemetry detail is path-scrubbed (FIX C)', () => {
  it('a raw fs-error path in the returned result never reaches the telemetry payload', async () => {
    await makeBrandDir('acme');
    const rawDetail =
      "EBUSY: resource busy or locked, open 'C:\\Users\\sam\\.mixshift\\clients\\acme\\corpora\\notes.md'";
    const throwingClient: ContextSyncClient = {
      fetchManifest: async () => {
        throw new Error(rawDetail);
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
    // The RETURNED result keeps the real message — a user debugging their own
    // machine needs the real path.
    expect(result).toEqual({ ran: false, reason: 'failed', detail: rawDetail });

    expect(vi.mocked(track)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(track).mock.calls[0]!;
    const telemetryDetail = (event.payload as { detail?: string } | undefined)?.detail ?? '';
    expect(telemetryDetail).toContain('EBUSY');
    expect(telemetryDetail).not.toContain('\\Users\\');
    expect(telemetryDetail).not.toContain('sam');
  });
});

// ---------------------------------------------------------------------------
// FIX D: the telemetry emit inside finish() is bounded (TELEMETRY_EMIT_BUDGET_MS)
// so a stalled local queue.jsonl cannot hold the read-path hook open forever.
// ---------------------------------------------------------------------------

describe('finish() telemetry emit is bounded (FIX D)', () => {
  it('a track() that never resolves does not hang maybeAutoSync beyond the telemetry budget', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    // One-time override: this call never settles; every OTHER track() call
    // in the suite keeps the module's default resolved stub (see the
    // top-of-file vi.mock), so nothing leaks into later tests.
    vi.mocked(track).mockImplementationOnce(() => new Promise(() => {}));

    const t0 = Date.now();
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    const elapsed = Date.now() - t0;

    expect(result.ran).toBe(true);
    // Bounded by TELEMETRY_EMIT_BUDGET_MS (plus real overhead) — nowhere
    // near a hang into the suite timeout.
    expect(elapsed).toBeLessThan(TELEMETRY_EMIT_BUDGET_MS + 2_000);
  });
});

// ---------------------------------------------------------------------------
// Seed path (D-032, slice 2 — US1/US2): a missing brand dir consults the
// org-wide manifest instead of skipping outright. See the module doc's
// "Seed path" bullet.
// ---------------------------------------------------------------------------

describe('seed path: missing dir consults the org manifest', () => {
  it('manifest-listed slug seeds: dir created, doc pulled, ledger written, seeded:true emitted', async () => {
    const { client } = countingClient(
      [manifestBrand('newbrand', [{ key: 'narrative', content: 'from org store\n', revision: 1 }])],
      { narrative: { content: 'from org store\n', revision: 1 } },
    );

    const result = await maybeAutoSync('newbrand', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.pulled).toBe(1);
      expect(result.errors).toBe(0);
    }

    // The dir now exists and the doc landed — the engine handled it exactly
    // as it would for an already-existing brand.
    expect(
      await readFile(join(brandDir('newbrand', testDir), 'narrative.md'), 'utf8'),
    ).toBe('from org store\n');

    // Ledger written (per-doc entry + outcome fields).
    const ledger = await readLedger('newbrand');
    expect(ledger.docs.narrative).toBeDefined();
    expect(ledger.last_autosync_outcome).toBe('success');

    // seeded:true on THIS attempt's telemetry row.
    expect(vi.mocked(track)).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(track).mock.calls[0]!;
    expect(event).toMatchObject({
      event_name: 'context_sync.autosync_completed',
      outcome: 'ok',
      payload: { trigger: 'preflight', brand: 'newbrand', ran: true, seeded: true },
    });
  });

  it('unlisted slug: no mkdir, no throttle stamp, no telemetry', async () => {
    const { client, state } = countingClient([manifestBrand('other-brand', [])], {});
    const result = await maybeAutoSync('ghost-town', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result).toEqual({
      ran: false,
      reason: 'skipped',
      detail:
        'no local brand directory; fetch it explicitly with ' +
        '`mixshift context pull --brand <slug>`',
    });
    expect(state.manifestCalls).toBe(1); // consulted, just not found
    await expect(readdir(join(testDir, 'clients'))).rejects.toThrow();
    expect(vi.mocked(track)).not.toHaveBeenCalled();
  });

  it('unsafe slug never reaches the manifest, even when the manifest itself lists it', async () => {
    const { client, state } = countingClient([manifestBrand('../evil', [])], {});
    const result = await maybeAutoSync('../evil', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ ran: false, reason: 'skipped', detail: 'not a valid brand slug' });
    // isSafeBrandSlug is checked BEFORE brandDirExists/the manifest check —
    // the manifest is never even consulted for a slug this shape.
    expect(state.manifestCalls).toBe(0);
  });

  it('cache TTL honored: a second miss inside the window does not refetch', async () => {
    const { client, state } = countingClient([manifestBrand('other-brand', [])], {});
    await maybeAutoSync('ghost-town', { dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(state.manifestCalls).toBe(1);

    const second = await maybeAutoSync('ghost-town', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(second.ran).toBe(false);
    if (!second.ran) expect(second.reason).toBe('skipped');
    // Served from the org-manifest cache — no second fetch inside the TTL.
    expect(state.manifestCalls).toBe(1);
  });

  it('offline manifest fetch: quiet no-op, nothing persisted', async () => {
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
    const result = await maybeAutoSync('offline-brand', {
      dataDirOverride: testDir,
      client: failingClient,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe('skipped');
    await expect(readdir(join(testDir, 'clients'))).rejects.toThrow();
    await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
    expect(vi.mocked(track)).not.toHaveBeenCalled();
  });

  it('kill switch stays byte-silent for a seed-eligible (missing-dir) slug too', async () => {
    const { client, state } = countingClient([manifestBrand('newbrand', [])], {});
    const result = await maybeAutoSync('newbrand', {
      dataDirOverride: testDir,
      client,
      env: { [AUTOSYNC_ENV]: 'off' },
    });
    expect(result).toEqual({ ran: false, reason: 'disabled' });
    // The kill switch fires before ANY file or network activity — the
    // manifest is never consulted, so no cache file, no clients/ tree.
    expect(state.manifestCalls).toBe(0);
    await expect(readdir(join(testDir, 'clients'))).rejects.toThrow();
    await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
  });

  it('the dir-exists path is untouched: no org-manifest cache file appears for an ordinary sync', async () => {
    await makeBrandDir('acme');
    const { client } = countingClient([manifestBrand('acme', [])], {});
    const result = await maybeAutoSync('acme', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
    });
    expect(result.ran).toBe(true);
    // getCachedOrgManifest is only ever reached when brandDirExists() is
    // false — an existing brand dir never triggers it, so the cache file
    // this seed-path machinery writes must not appear here.
    await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIX C (also resolves the double-fetch starvation): the seed path passes
// the EXACT manifest it just used for the membership decision into op() via
// EngineOptions.manifest, so buildDocPairs (engine.ts) reuses it instead of
// fetching its own. Absorbed from a throwaway red-team probe
// (zz-redteam-dup-manifest.test.ts) that empirically proved the pre-fix
// double-fetch (and, at realistic latency, the resulting budget starvation);
// these are the tracked, fixed-behavior counterparts, asserted via a
// counting client rather than by racing real wall-clock timing (deterministic,
// no flake risk).
// ---------------------------------------------------------------------------

describe('seed path reuses the pre-check manifest — at most one fetchManifest per attempt (FIX C)', () => {
  it('cold cache: fetchManifest is called exactly ONCE across the whole seeded attempt (the pre-check fetch; buildDocPairs reuses it)', async () => {
    const { client, state } = countingClient(
      [manifestBrand('newbrand', [{ key: 'narrative', content: 'from org store\n', revision: 1 }])],
      { narrative: { content: 'from org store\n', revision: 1 } },
    );

    const result = await maybeAutoSync('newbrand', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      budgetMs: 5_000,
    });

    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.pulled).toBe(1);
      expect(result.errors).toBe(0);
      expect(result.seeded).toBe(true);
    }
    // Before FIX C: 2 (getCachedOrgManifest's cold fetch + buildDocPairs's
    // own fresh fetch, since options.manifest was never threaded through).
    expect(state.manifestCalls).toBe(1);
  });

  it('warm cache: fetchManifest is called ZERO times (the seed decision is served from cache, and that SAME cached list is reused by op())', async () => {
    // Pre-warm the org-manifest cache for this exact identity-less
    // (no-credentials-on-disk) scenario, matching how the seed path itself
    // would have warmed it on a prior attempt within the TTL.
    const { client, state } = countingClient(
      [manifestBrand('newbrand2', [{ key: 'narrative', content: 'from org store\n', revision: 1 }])],
      { narrative: { content: 'from org store\n', revision: 1 } },
    );
    await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(state.manifestCalls).toBe(1);

    const result = await maybeAutoSync('newbrand2', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      budgetMs: 5_000,
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.seeded).toBe(true);
    // No NEW fetch: neither the (warm) pre-check nor buildDocPairs asked
    // the network again.
    expect(state.manifestCalls).toBe(1);
  });

  it('control: the dir-ALREADY-EXISTS path still fetches its own manifest exactly once (unaffected — no seed decision to reuse)', async () => {
    const { client, state } = countingClient(
      [manifestBrand('existingbrand', [{ key: 'narrative', content: 'from org store\n', revision: 1 }])],
      { narrative: { content: 'from org store\n', revision: 1 } },
    );
    await makeBrandDir('existingbrand');

    const result = await maybeAutoSync('existingbrand', {
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      budgetMs: 5_000,
    });

    expect(result.ran).toBe(true);
    if (result.ran) expect(result.seeded).toBeUndefined();
    expect(state.manifestCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getCachedOrgManifest: the extracted manifest-cache helper, tested directly
// (not just through maybeAutoSync's seed path).
// ---------------------------------------------------------------------------

describe('getCachedOrgManifest', () => {
  // FIX E gave this function its OWN kill-switch + VITEST guards, mirroring
  // maybeAutoSync's — so every test below that wants to exercise the REAL
  // cache/fetch logic must opt back in with `env: LIVE_ENV`, exactly like
  // maybeAutoSync's own tests already do. The guards themselves are pinned
  // separately below (describe('getCachedOrgManifest guards (FIX E)')).
  it('cold cache: fetches once, persists the cache, returns fromCache:false', async () => {
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(result).toMatchObject({ ok: true, fromCache: false });
    expect(state.manifestCalls).toBe(1);
    const cached = JSON.parse(await readFile(orgManifestCachePath(testDir), 'utf8'));
    expect(cached.brands).toHaveLength(1);
    expect(cached.brands[0].brand_slug).toBe('acme');
  });

  it('warm cache within TTL: zero client calls, fromCache:true', async () => {
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(state.manifestCalls).toBe(1);

    const second = await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(second).toMatchObject({ ok: true, fromCache: true });
    expect(state.manifestCalls).toBe(1); // no new fetch
  });

  it('expired cache (past TTL): refetches', async () => {
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const t0 = new Date('2026-07-05T12:00:00.000Z');
    await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV, now: () => t0 });
    expect(state.manifestCalls).toBe(1);

    const past = new Date(t0.getTime() + AUTOSYNC_THROTTLE_MS + 1_000);
    const second = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      now: () => past,
    });
    expect(second).toMatchObject({ ok: true, fromCache: false });
    expect(state.manifestCalls).toBe(2);
  });

  it('a malformed cache file on disk is treated as cold, not a crash', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(orgManifestCachePath(testDir), '{ not valid json', 'utf8');
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const result = await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(result).toMatchObject({ ok: true, fromCache: false });
    expect(state.manifestCalls).toBe(1);
  });

  it('a fetch failure returns {ok:false} and writes nothing', async () => {
    const failingClient: ContextSyncClient = {
      fetchManifest: async () => ({
        ok: false,
        kind: 'host_unreachable',
        message: 'x',
        friendly: 'unreachable',
      }),
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    };
    const result = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: failingClient,
      env: LIVE_ENV,
    });
    expect(result).toEqual({ ok: false });
    await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
  });

  it('a client that throws is swallowed, never crashes the caller', async () => {
    const throwingClient: ContextSyncClient = {
      fetchManifest: async () => {
        throw new Error('boom');
      },
      fetchDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putDoc: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
      putAssignment: async () => ({ ok: false, kind: 'unknown', message: 'x', friendly: 'x' }),
    };
    await expect(
      getCachedOrgManifest({ dataDirOverride: testDir, client: throwingClient, env: LIVE_ENV }),
    ).resolves.toEqual({ ok: false });
  });

  it('the persist write is bounded: a saveOrgManifestCache that never resolves does not hang the call past ORG_MANIFEST_PERSIST_BUDGET_MS (FIX B)', async () => {
    // saveOrgManifestCache itself has no injection seam (it's a plain fs
    // write, not client-mediated), so this proves the bound indirectly: a
    // deliberately slow filesystem isn't reproducible portably in a unit
    // test, but we CAN prove the overall call returns promptly and correctly
    // even though real disk I/O is in the mix — a regression that dropped
    // the raceDeadline wrap would still pass this (disk writes are normally
    // fast), so the load-bearing assertion is the elapsed-time ceiling: it
    // must stay far below a pathological stall, and MUST NOT throw either
    // way (an unhandled rejection from an abandoned save would fail the
    // test run).
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    const t0 = Date.now();
    const result = await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    const elapsed = Date.now() - t0;
    expect(result).toMatchObject({ ok: true, fromCache: false });
    expect(state.manifestCalls).toBe(1);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// FIX E: getCachedOrgManifest is a SECOND entry point (auth.ts's
// computeOrgAwareness calls it directly, bypassing maybeAutoSync entirely) —
// it needs its OWN kill-switch + VITEST guards, not just borrowed ones from
// maybeAutoSync's call sites.
// ---------------------------------------------------------------------------

describe('getCachedOrgManifest guards (FIX E)', () => {
  it.each(['off', 'OFF', '0', 'false'])(
    `returns {ok:false} and touches nothing when ${AUTOSYNC_ENV}=%s`,
    async (value) => {
      const { client, state } = countingClient([manifestBrand('acme', [])], {});
      const result = await getCachedOrgManifest({
        dataDirOverride: testDir,
        client,
        env: { [AUTOSYNC_ENV]: value },
      });
      expect(result).toEqual({ ok: false });
      expect(state.manifestCalls).toBe(0);
      await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
    },
  );

  // Absorbed from a throwaway red-team probe (zz-skeptic2-auth-killswitch-
  // probe.test.ts): a bare empty tmp dir with no credentials produces a
  // false negative here (resolveApiBase throws "No credentials found"
  // before the guard would even matter) — a confound unrelated to the
  // VITEST/kill-switch question. Seed valid, non-expired credentials first
  // so this matches the REAL call site (auth.ts's computeOrgAwareness, right
  // after a successful `mixshift auth login`) precisely.
  it('is disabled by default under the test runner (VITEST guard), even with valid on-disk credentials and no env passed — mirrors auth.ts calling with no env', async () => {
    await writeCredentials();
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    // No env passed -> options.env undefined -> process.env.VITEST applies,
    // exactly like commands/auth.ts's computeOrgAwareness call site.
    const result = await getCachedOrgManifest({ dataDirOverride: testDir, client });
    expect(result).toEqual({ ok: false });
    expect(state.manifestCalls).toBe(0);
    await expect(readFile(orgManifestCachePath(testDir), 'utf8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIX A: the org-manifest cache is identity-bound, mirroring the per-brand
// ledger's `identity` field — a cache warmed under one tenant's login must
// never silently answer for a different tenant on the same machine within
// the TTL window. Absorbed from a throwaway red-team probe
// (zz-redteam-tenant-leak.test.ts) that empirically proved the pre-fix leak;
// these are the tracked, fixed-behavior counterparts.
// ---------------------------------------------------------------------------

describe('org-manifest cache is identity-bound (FIX A)', () => {
  it('cache written under identity A is NOT served under identity B: a fresh fetch runs under B instead', async () => {
    const tenantA = countingClient([manifestBrand('tenant-a-only', [])], {});
    const warm = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantA.client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#tenantA-user',
    });
    expect(warm).toMatchObject({ ok: true, fromCache: false });
    expect(tenantA.state.manifestCalls).toBe(1);

    // Different tenant, different client — if the stale tenant-A cache were
    // served, tenantB.client would never be asked at all (the pre-fix bug).
    const tenantB = countingClient([manifestBrand('tenant-b-brand', [])], {});
    const second = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantB.client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#tenantB-user',
    });

    // FIXED: identity mismatch forces a cache MISS -> a fresh fetch against
    // tenant B's OWN client -> tenant B's OWN (correct) brand list.
    expect(tenantB.state.manifestCalls).toBe(1);
    expect(second).toMatchObject({ ok: true, fromCache: false });
    if (second.ok) {
      expect(second.brands.map((b) => b.brand_slug)).toEqual(['tenant-b-brand']);
    }
  });

  it("the fresh fetch under B overwrites the cache's identity binding (a later read under B is now a hit; under A is a miss)", async () => {
    const tenantA = countingClient([manifestBrand('tenant-a-only', [])], {});
    await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantA.client,
      env: LIVE_ENV,
      identity: 'id-A',
    });

    const tenantB = countingClient([manifestBrand('tenant-b-brand', [])], {});
    await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantB.client,
      env: LIVE_ENV,
      identity: 'id-B',
    });
    expect(tenantB.state.manifestCalls).toBe(1);

    // Rebound to B: a THIRD read under B, same client, is now a cache HIT.
    const hitUnderB = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantB.client,
      env: LIVE_ENV,
      identity: 'id-B',
    });
    expect(hitUnderB).toMatchObject({ ok: true, fromCache: true });
    expect(tenantB.state.manifestCalls).toBe(1); // no new fetch

    // ...while a read under A (the ORIGINAL identity) now misses again —
    // the binding moved, not merely widened to accept both.
    const missUnderA = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantA.client,
      env: LIVE_ENV,
      identity: 'id-A',
    });
    expect(missUnderA).toMatchObject({ ok: true, fromCache: false });
    expect(tenantA.state.manifestCalls).toBe(2);
  });

  it('the cache file persists the identity that fetched it', async () => {
    const tenantA = countingClient([manifestBrand('tenant-a-only', [])], {});
    await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantA.client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#tenantA-user',
    });
    const raw = JSON.parse(await readFile(orgManifestCachePath(testDir), 'utf8'));
    expect(raw.identity).toBe('https://mcp.example.test#tenantA-user');
  });

  it('both sides unresolvable (no identity at all): TTL-only gating, same as before identity binding existed', async () => {
    // Neither call passes `identity`, and there are no credentials on disk
    // in testDir, so resolveLedgerIdentity() resolves to null on both sides
    // — the "true absence on both sides" case that skips the identity check
    // entirely (see cachedManifestIdentityMatches's doc).
    const { client, state } = countingClient([manifestBrand('acme', [])], {});
    await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(state.manifestCalls).toBe(1);

    const second = await getCachedOrgManifest({ dataDirOverride: testDir, client, env: LIVE_ENV });
    expect(second).toMatchObject({ ok: true, fromCache: true });
    expect(state.manifestCalls).toBe(1); // still a hit — TTL governs, not identity
  });

  it('a pre-FIX-A cache file (no identity field at all) is treated as a MISS once a real identity IS resolvable, and self-heals by rebinding', async () => {
    // Simulates a cache written by a pre-fix build: fetched_at + brands
    // only, no `identity` key.
    await mkdir(testDir, { recursive: true });
    await writeFile(
      orgManifestCachePath(testDir),
      JSON.stringify({
        fetched_at: new Date().toISOString(),
        brands: [manifestBrand('legacy-cached-brand', [])],
      }),
      'utf8',
    );
    const { client, state } = countingClient([manifestBrand('real-brand', [])], {});
    const result = await getCachedOrgManifest({
      dataDirOverride: testDir,
      client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#someone',
    });
    // Migration case: absent-on-one-side-only is a mismatch -> forced
    // refetch -> the NEW (correctly bound) manifest, not the stale legacy one.
    expect(result).toMatchObject({ ok: true, fromCache: false });
    if (result.ok) {
      expect(result.brands.map((b) => b.brand_slug)).toEqual(['real-brand']);
    }
    expect(state.manifestCalls).toBe(1);
    const raw = JSON.parse(await readFile(orgManifestCachePath(testDir), 'utf8'));
    expect(raw.identity).toBe('https://mcp.example.test#someone');
  });

  it("maybeAutoSync's seed path threads its identity option through: a slug only a STALE, differently-identified cache lists is NOT seeded", async () => {
    // Warm the org-manifest cache as tenant A (identity option, no
    // credentials on disk — mirrors the empirically-proven leak scenario).
    const tenantA = countingClient([manifestBrand('tenant-a-only', [])], {});
    await getCachedOrgManifest({
      dataDirOverride: testDir,
      client: tenantA.client,
      env: LIVE_ENV,
      identity: 'https://mcp.example.test#tenantA-user',
    });

    // maybeAutoSync now runs as tenant B, for tenant A's slug. tenant B's
    // own client (used for the actual sync/pull engine call, AFTER the seed
    // decision) legitimately doesn't know this brand either.
    const tenantB = countingClient([manifestBrand('tenant-b-brand', [])], {});
    const result = await maybeAutoSync('tenant-a-only', {
      dataDirOverride: testDir,
      client: tenantB.client,
      identity: 'https://mcp.example.test#tenantB-user',
      env: LIVE_ENV,
    });

    // FIXED: the identity mismatch forces the manifest check to refetch
    // under tenant B, whose own org does NOT list 'tenant-a-only' — so the
    // seed path never fires. No dir, no ledger, a quiet skip.
    expect(result).toEqual({
      ran: false,
      reason: 'skipped',
      detail:
        'no local brand directory; fetch it explicitly with ' +
        '`mixshift context pull --brand <slug>`',
    });
    await expect(readdir(join(testDir, 'clients'))).rejects.toThrow();
  });
});
