import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeStatus, migrate, pull, push, sync } from './engine.js';
import type { ContextSyncClient } from './client.js';
import { hashContent } from './local.js';
import { loadState, saveState, type ContextSyncState } from './state.js';
import { brandDir, corporaDir } from '../paths/resolve.js';
import type {
  DocKey,
  DocType,
  DocVerdict,
  PutDocInput,
  PutDocResult,
  WireManifestBrand,
} from './types.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-ctxsync-engine-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const VALID_CONTEXT_YAML = `schema_version: 1
brand_slug: acme
brand_name: Acme
last_updated: "2026-07-01"
accounts:
  - seller_id: 1
    seller_name: Acme Corp
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: sp_campaigns_metric
  ops_revenue: mws_orders
  ops_revenue_field: revenue
  ops_units_field: units
  ops_date_field: date
management:
  primary_metric: ACOS
  acos_target_pct: 25
  attribution_window_days: 14
`;

/** Parses as YAML but violates the brand-context Zod schema. */
const SCHEMA_VIOLATING_CONTEXT_YAML = 'schema_version: 1\nbrand_slug: acme\n';

/** Not YAML at all. */
const MALFORMED_YAML = 'foo: [unclosed\n  - ]: nope: {{\n';

async function writeBrandFile(brand: string, rel: string, content: string): Promise<void> {
  const path = join(brandDir(brand, testDir), rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function readBrandFile(brand: string, rel: string): Promise<string> {
  return readFile(join(brandDir(brand, testDir), rel), 'utf8');
}

interface ServerDoc {
  doc_type: DocType;
  corpus_name?: string;
  revision: number;
  content: string;
  updated_at: string;
  updated_by_actor: string;
}

/**
 * In-memory stand-in for the /api/context service. Implements the frozen
 * wire semantics the engine relies on: manifest listing, doc fetch, and
 * PUT with base_revision checking + identical-content dedupe as noop.
 */
class FakeServer {
  private store = new Map<string, Map<string, ServerDoc>>();

  set(
    brand: string,
    key: DocKey,
    content: string,
    opts: { revision?: number; actor?: string } = {},
  ): void {
    const isCorpus = key.startsWith('corpus/');
    const doc: ServerDoc = {
      doc_type: isCorpus ? 'corpus' : (key as DocType),
      ...(isCorpus ? { corpus_name: key.slice('corpus/'.length) } : {}),
      revision: opts.revision ?? 1,
      content,
      updated_at: '2026-07-03T00:00:00.000Z',
      updated_by_actor: opts.actor ?? 'jane@example.com',
    };
    const brandMap = this.store.get(brand) ?? new Map<string, ServerDoc>();
    brandMap.set(key, doc);
    this.store.set(brand, brandMap);
  }

  get(brand: string, key: DocKey): ServerDoc | undefined {
    return this.store.get(brand)?.get(key);
  }

  manifest(): WireManifestBrand[] {
    return [...this.store.entries()].map(([brand_slug, docs]) => ({
      brand_slug,
      docs: [...docs.values()].map((d) => ({
        doc_type: d.doc_type,
        ...(d.corpus_name !== undefined ? { corpus_name: d.corpus_name } : {}),
        revision: d.revision,
        content_hash: hashContent(d.content),
        sensitivity: 'internal',
        updated_at: d.updated_at,
        updated_by_actor: d.updated_by_actor,
      })),
    }));
  }

  client(): ContextSyncClient {
    return {
      fetchManifest: async () => ({ ok: true, brands: this.manifest() }),
      fetchDoc: async (brand, docType, corpusName) => {
        const key: DocKey = docType === 'corpus' ? `corpus/${corpusName}` : docType;
        const doc = this.get(brand, key);
        if (!doc) {
          return {
            ok: false,
            kind: 'not_found',
            message: 'not found',
            friendly: 'No such doc.',
          };
        }
        return {
          ok: true,
          doc: {
            brand_slug: brand,
            doc_type: doc.doc_type,
            ...(doc.corpus_name !== undefined ? { corpus_name: doc.corpus_name } : {}),
            revision: doc.revision,
            content_hash: hashContent(doc.content),
            content: doc.content,
            sensitivity: 'internal',
            updated_at: doc.updated_at,
            updated_by_actor: doc.updated_by_actor,
          },
        };
      },
      putDoc: async (input: PutDocInput): Promise<PutDocResult> => {
        const key: DocKey =
          input.doc_type === 'corpus' ? `corpus/${input.corpus_name}` : input.doc_type;
        const brandMap = this.store.get(input.brand_slug) ?? new Map<string, ServerDoc>();
        this.store.set(input.brand_slug, brandMap);
        const existing = brandMap.get(key);

        if (!existing) {
          brandMap.set(key, {
            doc_type: input.doc_type,
            ...(input.corpus_name !== undefined ? { corpus_name: input.corpus_name } : {}),
            revision: 1,
            content: input.content,
            updated_at: '2026-07-04T00:00:00.000Z',
            updated_by_actor: 'me@example.com',
          });
          return { ok: true, status: 'created', revision: 1 };
        }
        if (existing.content === input.content) {
          return { ok: true, status: 'noop', revision: existing.revision };
        }
        if (input.base_revision === undefined || input.base_revision !== existing.revision) {
          return {
            ok: false,
            kind: 'revision_conflict',
            message: 'revision conflict',
            friendly: 'Someone else updated this doc.',
            server: {
              revision: existing.revision,
              content: existing.content,
              content_hash: hashContent(existing.content),
              updated_at: existing.updated_at,
              updated_by_actor: existing.updated_by_actor,
            },
          };
        }
        existing.revision += 1;
        existing.content = input.content;
        existing.updated_at = '2026-07-04T00:00:00.000Z';
        existing.updated_by_actor = 'me@example.com';
        return { ok: true, status: 'updated', revision: existing.revision };
      },
    };
  }
}

function stateEntry(revision: number, content: string): ContextSyncState['docs'][string] {
  return {
    server_revision: revision,
    last_synced_hash: hashContent(content),
    last_synced_at: '2026-07-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Verdict matrix
// ---------------------------------------------------------------------------

describe('computeStatus verdict matrix', () => {
  it('reaches all six verdicts', async () => {
    const brand = 'acme';
    const server = new FakeServer();

    // in-sync: same content both sides, tracked.
    await writeBrandFile(brand, 'context.yaml', VALID_CONTEXT_YAML);
    server.set(brand, 'context', VALID_CONTEXT_YAML, { revision: 1 });

    // local-ahead: local edited since sync, server unchanged.
    await writeBrandFile(brand, 'narrative.md', 'edited locally\n');
    server.set(brand, 'narrative', 'original\n', { revision: 1 });

    // server-ahead: server moved, local unchanged since sync.
    await writeBrandFile(brand, 'brand-brain.yaml', 'facts: []\n');
    server.set(brand, 'brain', 'facts: [new]\n', { revision: 2 });

    // diverged: both moved.
    await writeBrandFile(brand, 'config.yaml', 'skills: {a: 1}\n');
    server.set(brand, 'config', 'skills: {b: 2}\n', { revision: 2 });

    // local-only: untracked local file, nothing server-side.
    await writeBrandFile(brand, 'corpora/local.md', 'only here\n');

    // server-only: doc on the server, no local file.
    server.set(brand, 'corpus/server.md', 'only there\n', { revision: 1 });

    await saveState(
      brand,
      {
        schema: 2,
        docs: {
          context: stateEntry(1, VALID_CONTEXT_YAML),
          narrative: stateEntry(1, 'original\n'),
          brain: stateEntry(1, 'facts: []\n'),
          config: stateEntry(1, 'skills: {original}\n'),
        },
      },
      testDir,
    );

    const result = await computeStatus(brand, {
      client: server.client(),
      dataDirOverride: testDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verdicts = new Map<DocKey, DocVerdict>(result.docs.map((d) => [d.key, d.verdict]));
    expect(verdicts.get('context')).toBe('in-sync');
    expect(verdicts.get('narrative')).toBe('local-ahead');
    expect(verdicts.get('brain')).toBe('server-ahead');
    expect(verdicts.get('config')).toBe('diverged');
    expect(verdicts.get('corpus/local.md')).toBe('local-only');
    expect(verdicts.get('corpus/server.md')).toBe('server-only');

    const narrative = result.docs.find((d) => d.key === 'narrative')!;
    expect(narrative.locallyModified).toBe(true);
    expect(narrative.serverRevision).toBe(1);
    expect(narrative.syncedRevision).toBe(1);

    const brain = result.docs.find((d) => d.key === 'brain')!;
    expect(brain.locallyModified).toBe(false);
    expect(brain.serverRevision).toBe(2);
    expect(brain.syncedRevision).toBe(1);
    expect(brain.serverUpdatedBy).toBe('jane@example.com');
  });

  it('treats untracked docs existing on both sides as in-sync (same hash) or diverged (different)', async () => {
    const brand = 'untracked';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'same\n');
    server.set(brand, 'narrative', 'same\n', { revision: 3 });
    await writeBrandFile(brand, 'config.yaml', 'a: 1\n');
    server.set(brand, 'config', 'b: 2\n', { revision: 3 });

    const result = await computeStatus(brand, {
      client: server.client(),
      dataDirOverride: testDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdicts = new Map(result.docs.map((d) => [d.key, d.verdict]));
    expect(verdicts.get('narrative')).toBe('in-sync');
    expect(verdicts.get('config')).toBe('diverged');
  });
});

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

describe('pull', () => {
  it('pulls server-ahead + server-only docs, writes files, and records state', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'brand-brain.yaml', 'facts: []\n');
    server.set(brand, 'brain', 'facts: [new]\n', { revision: 2 });
    server.set(brand, 'corpus/tone.md', 'Friendly.\n', { revision: 1 });
    await saveState(
      brand,
      { schema: 2, docs: { brain: stateEntry(1, 'facts: []\n') } },
      testDir,
    );

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actions = new Map(result.reports.map((r) => [r.key, r.action]));
    expect(actions.get('brain')).toBe('pulled');
    expect(actions.get('corpus/tone.md')).toBe('pulled');

    expect(await readBrandFile(brand, 'brand-brain.yaml')).toBe('facts: [new]\n');
    expect(await readBrandFile(brand, 'corpora/tone.md')).toBe('Friendly.\n');

    const state = await loadState(brand, testDir);
    expect(state.docs.brain!.server_revision).toBe(2);
    expect(state.docs.brain!.last_synced_hash).toBe(hashContent('facts: [new]\n'));
    expect(state.docs['corpus/tone.md']!.server_revision).toBe(1);
  });

  it('rejects a malformed context doc from the server and leaves the local file untouched', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'context.yaml', VALID_CONTEXT_YAML);
    server.set(brand, 'context', SCHEMA_VIOLATING_CONTEXT_YAML, { revision: 2 });
    await saveState(
      brand,
      { schema: 2, docs: { context: stateEntry(1, VALID_CONTEXT_YAML) } },
      testDir,
    );

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = result.reports.find((r) => r.key === 'context')!;
    expect(report.action).toBe('error');
    expect(report.detail).toMatch(/invalid/);
    // Local file + ledger untouched:
    expect(await readBrandFile(brand, 'context.yaml')).toBe(VALID_CONTEXT_YAML);
    const state = await loadState(brand, testDir);
    expect(state.docs.context!.server_revision).toBe(1);
  });

  it('rejects a syntactically broken YAML brain doc from the server', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'brain', MALFORMED_YAML, { revision: 1 });
    await mkdir(brandDir(brand, testDir), { recursive: true });

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.reports.find((r) => r.key === 'brain')!;
    expect(report.action).toBe('error');
    expect(report.detail).toMatch(/malformed YAML/);
  });

  it('skips locally modified docs and reports diverged as conflict without --force', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'local edit\n');
    server.set(brand, 'narrative', 'server edit\n', { revision: 2 });
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(1, 'original\n') } },
      testDir,
    );

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('conflict');
    expect(await readBrandFile(brand, 'narrative.md')).toBe('local edit\n');
  });

  it('--force takes the server version of a diverged doc', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'local edit\n');
    server.set(brand, 'narrative', 'server edit\n', { revision: 2 });
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(1, 'original\n') } },
      testDir,
    );

    const result = await pull(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('pulled');
    expect(await readBrandFile(brand, 'narrative.md')).toBe('server edit\n');
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

describe('push', () => {
  it('pushes local-ahead docs against the synced revision and updates state', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'local edit\n');
    server.set(brand, 'narrative', 'original\n', { revision: 1 });
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(1, 'original\n') } },
      testDir,
    );

    const result = await push(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('pushed');
    expect(server.get(brand, 'narrative')!.content).toBe('local edit\n');
    expect(server.get(brand, 'narrative')!.revision).toBe(2);
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(2);
    expect(state.docs.narrative!.last_synced_hash).toBe(hashContent('local edit\n'));
  });

  it('creates local-only docs (no base_revision)', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'corpora/faq.md', 'Q&A\n');
    // Give the manifest a brand entry so the fake server knows the brand.
    server.set(brand, 'narrative', 'x\n', { revision: 1 });
    await writeBrandFile(brand, 'narrative.md', 'x\n');

    const result = await push(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faq = result.reports.find((r) => r.key === 'corpus/faq.md')!;
    expect(faq.action).toBe('created');
    expect(server.get(brand, 'corpus/faq.md')!.content).toBe('Q&A\n');
  });

  it('surfaces a put-level revision conflict with the server actor (stale manifest race)', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'my edit\n');
    // Server has ALREADY moved to rev 4 by jane...
    server.set(brand, 'narrative', 'jane edit\n', { revision: 4, actor: 'jane@example.com' });
    // ...but this machine's manifest snapshot still says rev 3 = last synced.
    const staleManifest: WireManifestBrand[] = [
      {
        brand_slug: brand,
        docs: [
          {
            doc_type: 'narrative',
            revision: 3,
            content_hash: hashContent('original\n'),
            sensitivity: 'internal',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by_actor: 'jane@example.com',
          },
        ],
      },
    ];
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(3, 'original\n') } },
      testDir,
    );

    const result = await push(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      manifest: staleManifest,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.reports[0]!;
    expect(report.action).toBe('conflict');
    expect(report.detail).toContain('jane@example.com');
    expect(report.detail).toMatch(/pull --brand acme --force/);
    expect(report.detail).toMatch(/push --brand acme --force/);
    // Server untouched; ledger untouched.
    expect(server.get(brand, 'narrative')!.content).toBe('jane edit\n');
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(3);
  });

  it('conflicts on diverged docs without --force and overwrites with --force', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'config.yaml', 'skills: {mine: 1}\n');
    server.set(brand, 'config', 'skills: {theirs: 2}\n', { revision: 2 });
    await saveState(
      brand,
      { schema: 2, docs: { config: stateEntry(1, 'skills: {}\n') } },
      testDir,
    );

    const noForce = await push(brand, { client: server.client(), dataDirOverride: testDir });
    expect(noForce.ok).toBe(true);
    if (!noForce.ok) return;
    expect(noForce.reports[0]!.action).toBe('conflict');
    expect(server.get(brand, 'config')!.content).toBe('skills: {theirs: 2}\n');

    const forced = await push(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      force: true,
    });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.reports[0]!.action).toBe('pushed');
    expect(server.get(brand, 'config')!.content).toBe('skills: {mine: 1}\n');
    expect(server.get(brand, 'config')!.revision).toBe(3);
    const state = await loadState(brand, testDir);
    expect(state.docs.config!.server_revision).toBe(3);
  });

  it('--force never steamrolls a local-ahead doc that 409s mid-flight (M4)', async () => {
    // Same stale-manifest race as the conflict test above, but WITH --force:
    // the computed verdict is 'local-ahead' (per the manifest snapshot the
    // server had not moved), so the mid-flight 409 must surface as a
    // conflict — force-retry is reserved for diverged/server-deleted docs.
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'my edit\n');
    server.set(brand, 'narrative', 'jane edit\n', { revision: 4, actor: 'jane@example.com' });
    const staleManifest: WireManifestBrand[] = [
      {
        brand_slug: brand,
        docs: [
          {
            doc_type: 'narrative',
            revision: 3,
            content_hash: hashContent('original\n'),
            sensitivity: 'internal',
            updated_at: '2026-07-01T00:00:00.000Z',
            updated_by_actor: 'jane@example.com',
          },
        ],
      },
    ];
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(3, 'original\n') } },
      testDir,
    );

    const result = await push(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      manifest: staleManifest,
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('conflict');
    // Jane's edit survives; ledger untouched.
    expect(server.get(brand, 'narrative')!.content).toBe('jane edit\n');
    expect(server.get(brand, 'narrative')!.revision).toBe(4);
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

describe('sync', () => {
  it('pulls server changes, pushes local changes, and lists diverged docs as conflicts', async () => {
    const brand = 'acme';
    const server = new FakeServer();

    // server-ahead → should be pulled
    await writeBrandFile(brand, 'brand-brain.yaml', 'facts: []\n');
    server.set(brand, 'brain', 'facts: [new]\n', { revision: 2 });
    // local-ahead → should be pushed
    await writeBrandFile(brand, 'narrative.md', 'local edit\n');
    server.set(brand, 'narrative', 'original\n', { revision: 1 });
    // diverged → conflict, untouched
    await writeBrandFile(brand, 'config.yaml', 'skills: {mine: 1}\n');
    server.set(brand, 'config', 'skills: {theirs: 2}\n', { revision: 2 });

    await saveState(
      brand,
      {
        schema: 2,
        docs: {
          brain: stateEntry(1, 'facts: []\n'),
          narrative: stateEntry(1, 'original\n'),
          config: stateEntry(1, 'skills: {}\n'),
        },
      },
      testDir,
    );

    const result = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actions = new Map(result.reports.map((r) => [r.key, r.action]));
    expect(actions.get('brain')).toBe('pulled');
    expect(actions.get('narrative')).toBe('pushed');
    expect(actions.get('config')).toBe('conflict');

    expect(await readBrandFile(brand, 'brand-brain.yaml')).toBe('facts: [new]\n');
    expect(server.get(brand, 'narrative')!.content).toBe('local edit\n');
    // Diverged doc untouched on both sides:
    expect(await readBrandFile(brand, 'config.yaml')).toBe('skills: {mine: 1}\n');
    expect(server.get(brand, 'config')!.content).toBe('skills: {theirs: 2}\n');
  });

  it('adopts ledger state for untracked in-sync docs (self-heal after state loss)', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'same\n');
    server.set(brand, 'narrative', 'same\n', { revision: 5 });

    const result = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('up-to-date');
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(5);
    expect(state.docs.narrative!.last_synced_hash).toBe(hashContent('same\n'));
  });
});

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

describe('migrate', () => {
  it('creates every doc on a fresh server and seeds the state ledger', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'context.yaml', VALID_CONTEXT_YAML);
    await writeBrandFile(brand, 'narrative.md', '# Acme\n');
    await writeBrandFile(brand, 'brand-brain.yaml', 'facts: []\n');
    await writeBrandFile(brand, 'config.yaml', 'skills: {}\n');
    await writeBrandFile(brand, 'corpora/tone.md', 'Friendly.\n');

    const result = await migrate({ client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.brands).toHaveLength(1);
    const reports = result.brands[0]!.reports;
    expect(reports).toHaveLength(5);
    expect(reports.every((r) => r.action === 'created')).toBe(true);

    const state = await loadState(brand, testDir);
    expect(Object.keys(state.docs).sort()).toEqual([
      'brain',
      'config',
      'context',
      'corpus/tone.md',
      'narrative',
    ]);
    expect(server.get(brand, 'context')!.content).toBe(VALID_CONTEXT_YAML);
  });

  it('reports noop and adopts the server revision when the server already holds identical content', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'context.yaml', VALID_CONTEXT_YAML);
    server.set(brand, 'context', VALID_CONTEXT_YAML, { revision: 7 });

    const result = await migrate({ client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.brands[0]!.reports[0]!;
    expect(report.action).toBe('noop');

    const state = await loadState(brand, testDir);
    expect(state.docs.context!.server_revision).toBe(7);
    expect(state.docs.context!.last_synced_hash).toBe(hashContent(VALID_CONTEXT_YAML));
    // Server untouched:
    expect(server.get(brand, 'context')!.revision).toBe(7);
  });

  it('surfaces differing existing server content as a conflict, never forced', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'mine\n');
    server.set(brand, 'narrative', 'theirs\n', { revision: 2, actor: 'jane@example.com' });

    const result = await migrate({ client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.brands[0]!.reports[0]!;
    expect(report.action).toBe('conflict');
    expect(report.detail).toContain('jane@example.com');
    expect(server.get(brand, 'narrative')!.content).toBe('theirs\n');
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative).toBeUndefined();
  });

  it('skips an invalid context.yaml with a clear message but migrates the brand\'s other docs', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'context.yaml', SCHEMA_VIOLATING_CONTEXT_YAML);
    await writeBrandFile(brand, 'narrative.md', '# Acme\n');

    const result = await migrate({ client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reports = result.brands[0]!.reports;
    const context = reports.find((r) => r.key === 'context')!;
    const narrative = reports.find((r) => r.key === 'narrative')!;
    expect(context.action).toBe('skipped');
    expect(context.detail).toMatch(/invalid/);
    expect(narrative.action).toBe('created');
    expect(server.get(brand, 'context')).toBeUndefined();
  });

  it('covers multiple brands and respects an explicit brand subset', async () => {
    const server = new FakeServer();
    await writeBrandFile('alpha', 'narrative.md', 'a\n');
    await writeBrandFile('beta', 'narrative.md', 'b\n');

    const all = await migrate({ client: server.client(), dataDirOverride: testDir });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.brands.map((b) => b.brand).sort()).toEqual(['alpha', 'beta']);

    await writeBrandFile('alpha', 'narrative.md', 'a2\n');
    const subset = await migrate({
      client: server.client(),
      dataDirOverride: testDir,
      brands: ['beta'],
    });
    expect(subset.ok).toBe(true);
    if (!subset.ok) return;
    expect(subset.brands.map((b) => b.brand)).toEqual(['beta']);
    // alpha's newer local edit was NOT pushed by the subset run.
    expect(server.get('alpha', 'narrative')!.content).toBe('a\n');
  });
});

// ---------------------------------------------------------------------------
// Unsafe corpus names from the manifest (C1 — path traversal)
// ---------------------------------------------------------------------------

describe('unsafe corpus names from the manifest', () => {
  it('errors on the evil doc, syncs the good one, and writes nothing outside corpora/', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    // Unique traversal target so a stale leftover from another run can't
    // false-negative the "nothing escaped" assertion below.
    const evil = `../../../../mxtest-evil-${process.pid}-${Date.now()}.txt`;
    server.set(brand, `corpus/${evil}`, 'pwned\n');
    server.set(brand, 'corpus/tone.md', 'Friendly.\n');
    await mkdir(brandDir(brand, testDir), { recursive: true });

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const actions = new Map(result.reports.map((r) => [r.key, r.action]));
    expect(actions.get('corpus/tone.md')).toBe('pulled');
    expect(actions.get(`corpus/${evil}`)).toBe('error');
    const evilReport = result.reports.find((r) => r.key === `corpus/${evil}`)!;
    expect(evilReport.detail).toMatch(/unsafe corpus name/);

    // The good doc landed inside corpora/ and is the ONLY thing there.
    expect(await readBrandFile(brand, 'corpora/tone.md')).toBe('Friendly.\n');
    expect(await readdir(corporaDir(brand, testDir))).toEqual(['tone.md']);
    // The traversal target (outside the data dir) was never created.
    const escaped = resolve(corporaDir(brand, testDir), evil);
    await expect(readFile(escaped, 'utf8')).rejects.toThrow();
    // And the evil key never entered the ledger.
    const state = await loadState(brand, testDir);
    expect(Object.keys(state.docs)).toEqual(['corpus/tone.md']);
  });

  it('refuses separators, ADS streams, and dot-names on pull and sync alike', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'corpus/a/b.md', 'sep\n');
    server.set(brand, 'corpus/a\\b.md', 'backslash\n');
    server.set(brand, 'corpus/note.md:stream', 'ads\n');
    server.set(brand, 'corpus/.hidden', 'dot\n');
    await mkdir(brandDir(brand, testDir), { recursive: true });

    for (const run of [pull, sync]) {
      const result = await run(brand, { client: server.client(), dataDirOverride: testDir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reports).toHaveLength(4);
      expect(result.reports.every((r) => r.action === 'error')).toBe(true);
    }
    // Nothing was written at all — corpora/ was never even created.
    await expect(readdir(corporaDir(brand, testDir))).rejects.toThrow();
  });

  it('skips unknown doc types from the manifest instead of aborting the brand', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'narrative', 'new\n', { revision: 2 });
    await writeBrandFile(brand, 'narrative.md', 'old\n');
    await saveState(
      brand,
      { schema: 2, docs: { narrative: stateEntry(1, 'old\n') } },
      testDir,
    );
    const manifest = server.manifest();
    manifest[0]!.docs.push({
      doc_type: 'hologram' as DocType, // a future server-side type
      revision: 1,
      content_hash: 'x'.repeat(64),
      sensitivity: 'internal',
      updated_at: '2026-07-03T00:00:00.000Z',
      updated_by_actor: 'jane@example.com',
    });

    const result = await pull(brand, {
      client: server.client(),
      manifest,
      dataDirOverride: testDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const skipped = result.reports.find((r) => r.action === 'skipped')!;
    expect(skipped.detail).toMatch(/unknown doc_type 'hologram'/);
    // The known doc still synced — the brand loop was not aborted.
    const narrative = result.reports.find((r) => r.key === 'narrative')!;
    expect(narrative.action).toBe('pulled');
    expect(await readBrandFile(brand, 'narrative.md')).toBe('new\n');
  });
});

// ---------------------------------------------------------------------------
// Atomic write hygiene (M1)
// ---------------------------------------------------------------------------

describe('atomic write hygiene', () => {
  it('reports a per-doc error and leaves no tmp litter when the local write fails', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'corpus/blocked.md', 'content\n');
    // Local target is a DIRECTORY → the final rename must fail.
    await mkdir(join(brandDir(brand, testDir), 'corpora', 'blocked.md'), { recursive: true });

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.reports.find((r) => r.key === 'corpus/blocked.md')!;
    expect(report.action).toBe('error');
    expect(report.detail).toMatch(/local write failed/);

    // No tmp file left behind — a bare leftover would be enumerated as a
    // corpus doc and pushed org-wide on the next push.
    const entries = await readdir(corporaDir(brand, testDir));
    expect(entries.filter((e) => e.includes('.tmp.'))).toEqual([]);
    // Ledger untouched for the failed doc.
    const state = await loadState(brand, testDir);
    expect(state.docs['corpus/blocked.md']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// server-deleted (M2)
// ---------------------------------------------------------------------------

describe('server-deleted', () => {
  const brand = 'acme';

  /** narrative was synced once (ledger proves it was on the server) but is
   *  gone from the manifest; tone.md keeps the brand present server-side. */
  async function seedDeleted(server: FakeServer): Promise<void> {
    server.set(brand, 'corpus/tone.md', 'Friendly.\n');
    await writeBrandFile(brand, 'corpora/tone.md', 'Friendly.\n');
    await writeBrandFile(brand, 'narrative.md', 'kept\n');
    await saveState(
      brand,
      {
        schema: 2,
        docs: {
          narrative: stateEntry(2, 'kept\n'),
          'corpus/tone.md': stateEntry(1, 'Friendly.\n'),
        },
      },
      testDir,
    );
  }

  it('classifies local+ledger+no-manifest as server-deleted (not local-only)', async () => {
    const server = new FakeServer();
    await seedDeleted(server);
    const result = await computeStatus(brand, {
      client: server.client(),
      dataDirOverride: testDir,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdicts = new Map(result.docs.map((d) => [d.key, d.verdict]));
    expect(verdicts.get('narrative')).toBe('server-deleted');
    expect(verdicts.get('corpus/tone.md')).toBe('in-sync');
  });

  it('plain sync and push do NOT resurrect the doc; pull leaves the local file alone', async () => {
    const server = new FakeServer();
    await seedDeleted(server);

    const synced = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    const syncReport = synced.reports.find((r) => r.key === 'narrative')!;
    expect(syncReport.action).toBe('skipped');
    expect(syncReport.detail).toMatch(/delete the local file/);
    expect(syncReport.detail).toMatch(/push --brand acme --force/);
    expect(server.get(brand, 'narrative')).toBeUndefined();

    const pushed = await push(brand, { client: server.client(), dataDirOverride: testDir });
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.reports.find((r) => r.key === 'narrative')!.action).toBe('skipped');
    expect(server.get(brand, 'narrative')).toBeUndefined();

    const pulled = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.reports.find((r) => r.key === 'narrative')!.action).toBe('skipped');
    expect(await readBrandFile(brand, 'narrative.md')).toBe('kept\n');
  });

  it('push --force recreates the doc and rewrites the ledger', async () => {
    const server = new FakeServer();
    await seedDeleted(server);

    const result = await push(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports.find((r) => r.key === 'narrative')!.action).toBe('created');
    expect(server.get(brand, 'narrative')!.content).toBe('kept\n');
    const state = await loadState(brand, testDir);
    expect(state.docs.narrative!.server_revision).toBe(1);
    expect(state.docs.narrative!.last_synced_hash).toBe(hashContent('kept\n'));
  });

  it('drops a stale ledger entry once the doc is gone from both sides', async () => {
    const server = new FakeServer();
    server.set(brand, 'corpus/tone.md', 'Friendly.\n');
    await writeBrandFile(brand, 'corpora/tone.md', 'Friendly.\n');
    await saveState(
      brand,
      {
        schema: 2,
        docs: {
          'corpus/gone.md': stateEntry(3, 'bye\n'), // no local file, no manifest entry
          'corpus/tone.md': stateEntry(1, 'Friendly.\n'),
        },
      },
      testDir,
    );

    const result = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports.some((r) => r.key === 'corpus/gone.md')).toBe(false);

    const state = await loadState(brand, testDir);
    expect(state.docs['corpus/gone.md']).toBeUndefined();
    expect(state.docs['corpus/tone.md']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Case/unicode collision guard (M3)
// ---------------------------------------------------------------------------

describe('case collision guard', () => {
  it('refuses to act when a manifest key and a local key differ only by case', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'corpus/Tone.md', 'SERVER\n');
    await writeBrandFile(brand, 'corpora/tone.md', 'local unsynced\n');

    const pulled = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(pulled.reports).toHaveLength(2);
    expect(pulled.reports.every((r) => r.action === 'error')).toBe(true);
    expect(pulled.reports[0]!.detail).toMatch(/collision/);
    expect(pulled.reports[0]!.detail).toContain('corpus/Tone.md');
    expect(pulled.reports[0]!.detail).toContain('corpus/tone.md');
    // The unsynced local edit survives — on a case-insensitive filesystem a
    // 'server-only' pull of Tone.md would have silently clobbered it.
    expect(await readBrandFile(brand, 'corpora/tone.md')).toBe('local unsynced\n');

    const pushed = await push(brand, { client: server.client(), dataDirOverride: testDir });
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) return;
    expect(pushed.reports.every((r) => r.action === 'error')).toBe(true);
    expect(server.get(brand, 'corpus/Tone.md')!.content).toBe('SERVER\n');
    expect(server.get(brand, 'corpus/tone.md')).toBeUndefined();

    const synced = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.reports.every((r) => r.action === 'error')).toBe(true);
  });

  it('refuses two colliding manifest keys and writes neither', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'corpus/FAQ.md', 'upper\n');
    server.set(brand, 'corpus/faq.md', 'lower\n');
    await mkdir(brandDir(brand, testDir), { recursive: true });

    const result = await pull(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports).toHaveLength(2);
    expect(result.reports.every((r) => r.action === 'error')).toBe(true);
    await expect(readdir(corporaDir(brand, testDir))).rejects.toThrow();
  });

  it('leaves identical-case keys untouched by the guard', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    server.set(brand, 'corpus/tone.md', 'same\n');
    await writeBrandFile(brand, 'corpora/tone.md', 'same\n');

    const result = await sync(brand, { client: server.client(), dataDirOverride: testDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('up-to-date');
  });
});

// ---------------------------------------------------------------------------
// Tenant-bound ledger (M5)
// ---------------------------------------------------------------------------

describe('tenant-bound ledger', () => {
  const ID_A = 'https://mcp.mixshift.io#42';
  const ID_B = 'https://other.example.com#7';

  it('computes verdicts as untracked when the ledger belongs to another identity', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'original\n');
    server.set(brand, 'narrative', 'server edit\n', { revision: 2 });
    await saveState(
      brand,
      { schema: 2, identity: ID_A, docs: { narrative: stateEntry(1, 'original\n') } },
      testDir,
    );

    // Matching identity: the ledger applies → server-ahead.
    const match = await computeStatus(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      identity: ID_A,
    });
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    expect(match.docs[0]!.verdict).toBe('server-ahead');

    // Different tenant: org A's revisions say nothing about org B's
    // manifest → untracked + differing content = diverged (fail safe,
    // needs an explicit --force instead of a silent overwrite).
    const mismatch = await computeStatus(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      identity: ID_B,
    });
    expect(mismatch.ok).toBe(true);
    if (!mismatch.ok) return;
    expect(mismatch.docs[0]!.verdict).toBe('diverged');
  });

  it('self-heals identical content across a tenant switch and rebinds the ledger', async () => {
    const brand = 'acme';
    const server = new FakeServer();
    await writeBrandFile(brand, 'narrative.md', 'same\n');
    server.set(brand, 'narrative', 'same\n', { revision: 7 });
    // Old-tenant ledger with a now-meaningless revision.
    await saveState(
      brand,
      { schema: 2, identity: ID_A, docs: { narrative: stateEntry(3, 'other\n') } },
      testDir,
    );

    const result = await sync(brand, {
      client: server.client(),
      dataDirOverride: testDir,
      identity: ID_B,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports[0]!.action).toBe('up-to-date');

    const state = await loadState(brand, testDir);
    expect(state.identity).toBe(ID_B);
    expect(state.docs.narrative!.server_revision).toBe(7);
    expect(state.docs.narrative!.last_synced_hash).toBe(hashContent('same\n'));
  });
});
