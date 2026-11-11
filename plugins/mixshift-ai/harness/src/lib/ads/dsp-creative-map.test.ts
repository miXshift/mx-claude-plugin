import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildEntriesFromCreate,
  createdAdIds,
  creativeMapForReadiness,
  creativeMapPath,
  loadCreativeMap,
  recordCreativeMappings,
  removeCreativeMapping,
  resolveMappingIdentity,
  scopedEntries,
  type CreativeMappingEntry,
} from './dsp-creative-map.js';
import { saveCredentials, serviceTokenCachePath } from '../auth/credentials.js';
import type { Credentials, DatahubCreds, ServiceCreds } from '../auth/schema.js';

// Synthetic ids and identities only.
const ADV = '1000000000000000001';
const ORDER = '2000000000000000002';
const AD = '4000000000000000011';

function entry(over: Partial<CreativeMappingEntry> = {}): CreativeMappingEntry {
  return {
    tenant: 'user:tenant-1',
    advertiser_id: ADV,
    order_id: ORDER,
    creative_id: AD,
    source: 'user_confirmed',
    recorded_at: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function makeJwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(claims)}.sig`;
}

function datahub(over: Partial<DatahubCreds> = {}): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: makeJwt({ sub: 'tenant-1', actor: 'person@example.test' }),
    refresh_token: 'r'.repeat(24),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    user_id: 'stale-local-id',
    email: 'login@example.test',
    person_label: 'person@example.test',
    device_label: 'test-host',
    client_id: 'mx-claude-plugin',
    ...over,
  };
}

function service(over: Partial<ServiceCreds> = {}): ServiceCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    client_id: 'svc_abcdefgh1234',
    client_secret: 's'.repeat(24),
    label: 'nightly_automation',
    ...over,
  };
}

async function writeCreds(dir: string, blocks: Partial<Credentials>): Promise<void> {
  await saveCredentials({ schema_version: 2, created_at: new Date().toISOString(), ...blocks }, dir);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsp-creative-map-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('creative map file', () => {
  it('reads a missing file as an empty map', async () => {
    expect(await loadCreativeMap(dir)).toEqual({ ok: true, entries: [] });
  });

  it('records, keeps the first record of a key, and reads it back', async () => {
    const first = await recordCreativeMappings([entry({ source: 'plugin_build', audit_id: 'a-1' })], dir);
    expect(first.added).toHaveLength(1);
    const again = await recordCreativeMappings([entry()], dir);
    expect(again.added).toHaveLength(0);
    expect(again.existing[0]?.source).toBe('plugin_build');
    const loaded = await loadCreativeMap(dir);
    expect(loaded).toMatchObject({ ok: true, entries: [{ creative_id: AD, source: 'plugin_build', audit_id: 'a-1' }] });
    const raw = JSON.parse(await readFile(creativeMapPath(dir), 'utf8'));
    expect(raw.schema_version).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('writes the file readable by its owner only', async () => {
    await recordCreativeMappings([entry()], dir);
    expect((await stat(creativeMapPath(dir))).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite a malformed file, and readiness treats it as unavailable, not empty', async () => {
    await mkdir(dirname(creativeMapPath(dir)), { recursive: true });
    await writeFile(creativeMapPath(dir), '{ not json', 'utf8');
    expect((await loadCreativeMap(dir)).ok).toBe(false);
    await expect(recordCreativeMappings([entry()], dir)).rejects.toThrow(/nothing was recorded/);
    expect(await readFile(creativeMapPath(dir), 'utf8')).toBe('{ not json');
    await writeCreds(dir, { datahub: datahub() });
    expect((await creativeMapForReadiness(dir)).status).toBe('unavailable');
  });

  it('rejects an entry with a non-numeric id', async () => {
    await expect(recordCreativeMappings([entry({ creative_id: 'abc' })], dir)).rejects.toThrow();
  });

  it('removes exactly one tenant + advertiser + order + creative', async () => {
    await recordCreativeMappings([entry(), entry({ order_id: '2000000000000000003' }), entry({ tenant: 'user:tenant-2' })], dir);
    const removed = await removeCreativeMapping(
      { tenant: 'user:tenant-1', advertiser_id: ADV, order_id: ORDER, creative_id: AD },
      dir,
    );
    expect(removed).toHaveLength(1);
    const loaded = await loadCreativeMap(dir);
    expect(loaded.ok && loaded.entries.map((e) => `${e.tenant}/${e.order_id}`)).toEqual([
      'user:tenant-1/2000000000000000003',
      'user:tenant-2/2000000000000000002',
    ]);
  });

  it('scopes reads to one tenant and one advertiser', () => {
    const all = [entry(), entry({ tenant: 'user:tenant-2' }), entry({ advertiser_id: '1000000000000000077' })];
    expect(scopedEntries(all, 'user:tenant-1', ADV)).toEqual([entry()]);
  });
});

describe('build records', () => {
  it('takes the created ad ids from success and partialSuccess, never from error', () => {
    const payload = {
      success: [{ index: 0, ad: { adId: AD } }],
      partialSuccess: [{ index: 1, ad: { adId: '4000000000000000012' }, errors: [{}] }],
      error: [{ index: 2, ad: { adId: '4000000000000000013' } }],
    };
    expect(createdAdIds(payload)).toEqual([AD, '4000000000000000012']);
    expect(createdAdIds({ success: [{ ad: { adId: 'not-an-id' } }, { ad: { adId: AD } }, { ad: { adId: AD } }] })).toEqual([AD]);
    expect(createdAdIds(null)).toEqual([]);
    expect(createdAdIds([])).toEqual([]);
  });

  it('builds plugin_build entries for the named order, dropping an audit id that is not a plain token', () => {
    const es = buildEntriesFromCreate({
      tenant: 'user:tenant-1',
      actor: 'person@example.test',
      advertiserId: ADV,
      orderId: ORDER,
      payload: { success: [{ ad: { adId: AD } }] },
      auditId: 'a b;c',
      now: new Date('2026-11-11T00:00:00Z'),
    });
    expect(es).toEqual([
      {
        tenant: 'user:tenant-1',
        advertiser_id: ADV,
        order_id: ORDER,
        creative_id: AD,
        source: 'plugin_build',
        recorded_at: '2026-11-11T00:00:00.000Z',
        recorded_by: 'person@example.test',
      },
    ]);
  });
});

describe('which tenant a data dir belongs to', () => {
  it('has none when nobody is signed in, so readiness cannot use a map', async () => {
    expect((await resolveMappingIdentity(dir)).ok).toBe(false);
    expect(await creativeMapForReadiness(dir)).toEqual({ status: 'unavailable', reason: 'not signed in to MixShift' });
  });

  it('takes the tenant from the signed-in token, not the stored copy', async () => {
    await writeCreds(dir, { datahub: datahub() });
    const who = await resolveMappingIdentity(dir);
    expect(who).toEqual({
      ok: true,
      identity: { tenant: 'user:tenant-1', actor: 'person@example.test', automation: false },
    });
    await recordCreativeMappings([entry()], dir);
    const m = await creativeMapForReadiness(dir);
    expect(m.status === 'ok' && m.tenant).toBe('user:tenant-1');
  });

  it('has none for a service credential that has not reported its owner', async () => {
    await writeCreds(dir, { service: service() });
    expect(await resolveMappingIdentity(dir)).toMatchObject({ ok: false });
  });

  it("uses a service credential's owner and marks it as automation", async () => {
    await writeCreds(dir, { service: service() });
    const path = serviceTokenCachePath(dir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        access_token: 'x',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        client_id: 'svc_abcdefgh1234',
        attribution: { owner_user_id: 'tenant-1' },
      }),
      'utf8',
    );
    expect(await resolveMappingIdentity(dir)).toEqual({
      ok: true,
      identity: { tenant: 'user:tenant-1', actor: 'nightly_automation', automation: true },
    });
  });
});
