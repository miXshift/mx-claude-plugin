import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LedgerFailure, PutLedgerBody, RunLedgerClient, WireLedger } from './client.js';
import { hashContent, ledgerDir, readSyncState, statePath } from './local.js';
import { ledgerStatus, pullLedger, pushLedger } from './sync.js';

/**
 * The run ledger sync against an in-memory service that enforces the service's own
 * rules: one revision per ledger, base_revision checked,
 * identical content is a noop, content null deletes. Covers every state the skill
 * acts on: a fresh container, the one-time migration, absent, an older gateway,
 * diverged files, a stale push, a foreign sign-in, a corrupt local ledger.
 */

const BRAND = 'acme-goods';
const SKILL = 'mx-max-report';
let dataDir: string;

class FakeService implements RunLedgerClient {
  ledger: { revision: number; files: Map<string, string>; updated_by: string } | null = null;
  failWith: LedgerFailure | null = null;
  tenantId: string | null = 't-42';
  puts: PutLedgerBody[] = [];
  /** Server-controlled file names, for the traversal test. */
  extraFiles: Array<{ path: string; content: string }> = [];

  async tenant() {
    return this.tenantId;
  }

  async get() {
    if (this.failWith) return this.failWith;
    if (!this.ledger) return { ok: true as const, ledger: null, tenant: this.tenantId };
    const files = [...this.ledger.files, ...this.extraFiles.map((f) => [f.path, f.content] as const)].map(
      ([path, content]) => ({
        path,
        content,
        content_hash: hashContent(content),
        byte_size: Buffer.byteLength(content),
        revision: this.ledger!.revision,
        updated_at: '2026-10-01T00:00:00Z',
        updated_by_actor: this.ledger!.updated_by,
      }),
    );
    const ledger: WireLedger = {
      brand_slug: BRAND,
      skill_id: SKILL,
      revision: this.ledger.revision,
      file_count: files.length,
      total_bytes: 0,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      updated_by_actor: this.ledger.updated_by,
      files,
    };
    return { ok: true as const, ledger, tenant: this.tenantId };
  }

  async put(body: PutLedgerBody) {
    this.puts.push(body);
    if (this.failWith) return this.failWith;
    const current = this.ledger?.revision ?? 0;
    if (body.base_revision !== current) {
      return {
        ok: false as const,
        kind: 'revision_conflict' as const,
        friendly: 'changed',
        http_status: 409,
        server: { revision: current, updated_at: null, updated_by_actor: this.ledger?.updated_by ?? null },
      };
    }
    const next = new Map(this.ledger?.files ?? []);
    let changed = 0;
    for (const f of body.files) {
      if (f.content === null) {
        if (next.delete(f.path)) changed++;
      } else if (next.get(f.path) !== f.content) {
        next.set(f.path, f.content);
        changed++;
      }
    }
    if (changed === 0) return { ok: true as const, status: 'noop' as const, revision: current, tenant: this.tenantId };
    this.ledger = { revision: current + 1, files: next, updated_by: 'session@agency.test' };
    return {
      ok: true as const,
      status: current === 0 ? ('created' as const) : ('updated' as const),
      revision: current + 1,
      tenant: this.tenantId,
    };
  }

  /** Another session writes directly. */
  bump(path: string, content: string) {
    const next = new Map(this.ledger?.files ?? []);
    next.set(path, content);
    this.ledger = { revision: (this.ledger?.revision ?? 0) + 1, files: next, updated_by: 'other@agency.test' };
  }
}

const dir = () => ledgerDir(BRAND, SKILL, dataDir);
async function writeLocal(path: string, content: string | Buffer) {
  const abs = join(dir(), ...path.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
const readLocal = (path: string) => readFile(join(dir(), ...path.split('/')), 'utf8');
const opts = (client: RunLedgerClient, extra: Record<string, unknown> = {}) => ({
  brand: BRAND,
  skill: SKILL,
  client,
  dataDirOverride: dataDir,
  now: () => new Date('2026-10-29T12:00:00Z'),
  ...extra,
});

const REGISTRY = '{"client_hub_url":"https://example.test/hub-client","internal_hub_url":"https://example.test/hub-internal"}';

beforeEach(async () => {
  dataDir = join(tmpdir(), `mxtest-runledger-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(dataDir, { recursive: true });
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('pull', () => {
  it('a fresh container: the service ledger lands in the cache under the OLD folder name', async () => {
    const svc = new FakeService();
    svc.ledger = {
      revision: 4,
      files: new Map([
        ['publish-registry.json', REGISTRY],
        ['fragments/2026-09-client.html', '<section>Sept</section>'],
      ]),
      updated_by: 'am@agency.test',
    };
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('pulled');
    expect(r.revision).toBe(4);
    expect(dir()).toContain(join('runs', 'mx-monthly-report-max'));
    expect(await readLocal('publish-registry.json')).toBe(REGISTRY);
    expect(await readLocal('fragments/2026-09-client.html')).toBe('<section>Sept</section>');
    expect((await readSyncState(BRAND, SKILL, dataDir))?.revision).toBe(4);
    expect((await pullLedger(opts(svc))).state).toBe('up_to_date');
  });

  it('migration: the service has none, the cache has one: uploaded ONCE at base 0, then in sync', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', REGISTRY);
    await writeLocal('commitments.json', '[{"item":"raise budget","owner":"client"}]');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('migrated');
    expect(r.revision).toBe(1);
    expect(svc.puts).toHaveLength(1);
    expect(svc.puts[0]!.base_revision).toBe(0);
    expect(svc.puts[0]!.files.map((f) => f.path).sort()).toEqual(['commitments.json', 'publish-registry.json']);
    expect((await pullLedger(opts(svc))).state).toBe('up_to_date');
    expect(svc.puts).toHaveLength(1);
  });

  it('migration race: another session uploaded first, so the base-0 upload conflicts and nothing is clobbered', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', REGISTRY);
    const realPut = svc.put.bind(svc);
    svc.put = async (body) => {
      svc.bump('publish-registry.json', '{"client_hub_url":"https://example.test/theirs"}');
      return realPut(body);
    };
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('error');
    expect(r.failure?.kind).toBe('revision_conflict');
    expect(svc.ledger!.files.get('publish-registry.json')).toContain('theirs');
    expect(await readSyncState(BRAND, SKILL, dataDir)).toBeNull();
  });

  it('a corrupt local JSON file is never uploaded', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', '{"client_hub_url": "https://example.test/hub-cl');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('local_corrupt');
    expect(r.corrupt).toEqual(['publish-registry.json']);
    expect(svc.puts).toHaveLength(0);
  });

  it('absent: neither side has a ledger', async () => {
    const r = await pullLedger(opts(new FakeService()));
    expect(r.state).toBe('absent');
    expect(r.revision).toBe(0);
  });

  it.each([
    ['unsupported', 404],
    ['unavailable', 503],
    ['host_unreachable', undefined],
  ] as const)('an older or unreachable service (%s) degrades to the local ledger, untouched', async (kind, status) => {
    const svc = new FakeService();
    svc.failWith = { ok: false, kind, friendly: 'x', ...(status ? { http_status: status } : {}) };
    await writeLocal('publish-registry.json', REGISTRY);
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('gateway_unavailable');
    expect(r.local_files).toBe(1);
    expect(r.failure?.kind).toBe(kind);
    expect(await readLocal('publish-registry.json')).toBe(REGISTRY);
    expect(svc.puts).toHaveLength(0);
  });

  it('a sign-in or scope failure is an error, not a fallback', async () => {
    const svc = new FakeService();
    svc.failWith = { ok: false, kind: 'insufficient_scope', friendly: 'no', http_status: 403 };
    expect((await pullLedger(opts(svc))).state).toBe('error');
  });

  it('server_missing: this cache synced before but the service has none now: refuse, upload nothing', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 2, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    svc.ledger = null;
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('server_missing');
    expect(svc.puts).toHaveLength(0);
  });

  it('a local edit not yet pushed survives a pull, and the next push carries it', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['watch.json', '[]']]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await writeLocal('watch.json', '["shared buy box"]');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('up_to_date');
    expect(r.local_edits).toEqual(['watch.json']);
    expect(await readLocal('watch.json')).toBe('["shared buy box"]');
    const p = await pushLedger(opts(svc));
    expect(p.state).toBe('pushed');
    expect(svc.ledger!.files.get('watch.json')).toBe('["shared buy box"]');
  });

  it('diverged: a file changed on both sides is left alone; --force takes the service copy and keeps ours aside', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await writeLocal('publish-registry.json', '{"client_hub_url":"https://example.test/mine"}');
    svc.bump('publish-registry.json', '{"client_hub_url":"https://example.test/theirs"}');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('diverged');
    expect(r.diverged).toEqual(['publish-registry.json']);
    expect(await readLocal('publish-registry.json')).toContain('mine');
    const f = await pullLedger(opts(svc, { force: true }));
    expect(f.state).toBe('pulled');
    expect(await readLocal('publish-registry.json')).toContain('theirs');
    expect(f.kept_aside).toBeDefined();
    expect(await readFile(join(f.kept_aside!, 'publish-registry.json'), 'utf8')).toContain('mine');
    // Kept aside OUTSIDE the ledger folder, so it is never pushed.
    expect(f.kept_aside!.startsWith(dir())).toBe(false);
  });

  it('an old local ledger meeting a service ledger it never synced with: differences diverge, never overwrite', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 3, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await writeLocal('publish-registry.json', '{"client_hub_url":"https://example.test/old"}');
    expect((await pullLedger(opts(svc))).state).toBe('diverged');
    expect(await readLocal('publish-registry.json')).toContain('old');
  });

  it('a server file name that would escape the ledger folder refuses the whole pull', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['ok.json', '{}']]), updated_by: 'x' };
    svc.extraFiles = [{ path: '../../context.yaml', content: 'brand: hijack' }];
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('error');
    expect(existsSync(join(dir(), 'ok.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'clients', BRAND, 'context.yaml'))).toBe(false);
  });

  it('a cache synced under another sign-in is never merged into or uploaded', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    svc.tenantId = 't-77';
    svc.ledger = null;
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('other_account');
    expect(svc.puts).toHaveLength(0);
    await writeLocal('watch.json', '[]');
    expect((await pushLedger(opts(svc))).state).toBe('other_account');
    expect(svc.puts).toHaveLength(0);
  });

  it('binary and unsafe local files are reported as skipped, never uploaded', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', REGISTRY);
    await writeLocal('chart.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeLocal('a/b/c/d/e.json', '{}');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('migrated');
    expect(svc.puts[0]!.files.map((f) => f.path)).toEqual(['publish-registry.json']);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['not_text', 'too_deep']);
  });

  it('a file deleted here but unchanged on the service is restored, not reported as up to date', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await rm(join(dir(), 'publish-registry.json'));
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('pulled');
    expect(r.changes).toEqual([{ path: 'publish-registry.json', change: 'added' }]);
    expect(await readLocal('publish-registry.json')).toBe(REGISTRY);
  });

  it('server_missing fires on a synced cache even when its files are gone', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 3, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await rm(dir(), { recursive: true, force: true });
    svc.ledger = null;
    expect((await pullLedger(opts(svc))).state).toBe('server_missing');
  });

  it('a temp file left by a crash mid-write is never synced', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', REGISTRY);
    await writeLocal('publish-registry.json.tmp-4242', '{"half":');
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('migrated');
    expect(svc.puts[0]!.files.map((f) => f.path)).toEqual(['publish-registry.json']);
  });

  it('service names that differ only in case refuse the whole pull', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['a.json', '{}']]), updated_by: 'x' };
    svc.extraFiles = [{ path: 'A.json', content: '{"other":1}' }];
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('error');
    expect(existsSync(join(dir(), 'a.json'))).toBe(false);
  });

  it('a local file the sync cannot read is never overwritten unseen; --force keeps it byte for byte', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['chart.svg', '<svg/>']]), updated_by: 'x' };
    const binary = Buffer.from([0x3c, 0x00, 0x01, 0x02]);
    await writeLocal('chart.svg', binary);
    const r = await pullLedger(opts(svc));
    expect(r.state).toBe('diverged');
    expect(r.diverged).toEqual(['chart.svg']);
    const f = await pullLedger(opts(svc, { force: true }));
    expect(f.state).toBe('pulled');
    expect(await readLocal('chart.svg')).toBe('<svg/>');
    expect(Buffer.compare(await readFile(join(f.kept_aside!, 'chart.svg')), binary)).toBe(0);
  });

  it('the sync state lives outside the ledger folder', async () => {
    const svc = new FakeService();
    await writeLocal('publish-registry.json', REGISTRY);
    await pullLedger(opts(svc));
    expect(statePath(BRAND, dataDir).startsWith(dir())).toBe(false);
    expect(existsSync(statePath(BRAND, dataDir))).toBe(true);
  });
});

describe('push', () => {
  it('without a sync point and a service ledger it has not seen, it asks for a pull first', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 2, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await writeLocal('publish-registry.json', '{"client_hub_url":"https://example.test/other"}');
    expect((await pushLedger(opts(svc))).state).toBe('pull_first');
    expect(svc.puts).toHaveLength(0);
  });

  it('without a sync point and no service ledger (the pull fell back), it creates the first one', async () => {
    const svc = new FakeService();
    svc.failWith = { ok: false, kind: 'host_unreachable', friendly: 'down' };
    expect((await pullLedger(opts(svc))).state).toBe('gateway_unavailable');
    await writeLocal('publish-registry.json', REGISTRY);
    svc.failWith = null; // the service is back by publish time
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('pushed');
    expect(svc.puts.at(-1)!.base_revision).toBe(0);
    expect(svc.ledger!.files.get('publish-registry.json')).toBe(REGISTRY);
    expect((await pushLedger(opts(svc))).state).toBe('up_to_date');
  });

  it('the first run on a brand: absent at start, then the push after publish creates the service ledger', async () => {
    const svc = new FakeService();
    expect((await pullLedger(opts(svc))).state).toBe('absent');
    await writeLocal('publish-registry.json', REGISTRY);
    await writeLocal('fragments/2026-10-client.html', '<section>Oct</section>');
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('pushed');
    expect(r.revision).toBe(1);
    expect(svc.puts[0]!.base_revision).toBe(0);
    // A fresh container then finds it.
    await rm(join(dataDir, 'clients'), { recursive: true, force: true });
    expect((await pullLedger(opts(svc))).state).toBe('pulled');
    expect(await readLocal('publish-registry.json')).toBe(REGISTRY);
  });

  it('carries only the changed files and the revision they were read at', async () => {
    const svc = new FakeService();
    svc.ledger = {
      revision: 5,
      files: new Map([
        ['publish-registry.json', REGISTRY],
        ['fragments/2026-09-client.html', '<section>Sept</section>'],
      ]),
      updated_by: 'x',
    };
    await pullLedger(opts(svc));
    await writeLocal('fragments/2026-10-client.html', '<section>Oct</section>');
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('pushed');
    expect(r.revision).toBe(6);
    expect(svc.puts.at(-1)).toEqual({
      brand_slug: BRAND,
      skill_id: SKILL,
      base_revision: 5,
      files: [{ path: 'fragments/2026-10-client.html', content: '<section>Oct</section>' }],
    });
    expect((await pushLedger(opts(svc))).state).toBe('up_to_date');
  });

  it('two sessions: the second push is a conflict, nothing is overwritten; pull then push succeeds', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    svc.bump('claims.json', '["recovering"]'); // session A saved first
    await writeLocal('watch.json', '["stockout"]');
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('conflict');
    expect(svc.ledger!.files.has('watch.json')).toBe(false);
    expect(svc.ledger!.revision).toBe(2);
    expect((await pullLedger(opts(svc))).state).toBe('pulled');
    expect((await pushLedger(opts(svc))).state).toBe('pushed');
    expect([...svc.ledger!.files.keys()].sort()).toEqual(['claims.json', 'publish-registry.json', 'watch.json']);
  });

  it('a file missing locally stays on the service unless --prune', async () => {
    const svc = new FakeService();
    svc.ledger = {
      revision: 1,
      files: new Map([
        ['publish-registry.json', REGISTRY],
        ['old.json', '{}'],
      ]),
      updated_by: 'x',
    };
    await pullLedger(opts(svc));
    await rm(join(dir(), 'old.json'));
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('up_to_date');
    expect(r.missing_locally).toEqual(['old.json']);
    expect(svc.ledger!.files.has('old.json')).toBe(true);
    const p = await pushLedger(opts(svc, { prune: true }));
    expect(p.state).toBe('pushed');
    expect(svc.ledger!.files.has('old.json')).toBe(false);
  });

  it('a corrupt JSON file blocks the push', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await writeLocal('publish-registry.json', '{ broken');
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('local_corrupt');
    expect(svc.ledger!.files.get('publish-registry.json')).toBe(REGISTRY);
  });

  it('an older service on push: the ledger stays local and says so', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 1, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    await pullLedger(opts(svc));
    await writeLocal('watch.json', '[]');
    svc.failWith = { ok: false, kind: 'unsupported', friendly: 'x', http_status: 404 };
    const r = await pushLedger(opts(svc));
    expect(r.state).toBe('gateway_unavailable');
    expect(r.message).toMatch(/this computer only/);
  });
});

describe('status', () => {
  it('reports both sides without writing', async () => {
    const svc = new FakeService();
    svc.ledger = { revision: 2, files: new Map([['publish-registry.json', REGISTRY]]), updated_by: 'x' };
    const s = await ledgerStatus(opts(svc));
    expect(s).toMatchObject({ local_files: 0, synced_revision: null, service: { available: true, revision: 2, file_count: 1 } });
    expect(existsSync(dir())).toBe(false);
  });
});
