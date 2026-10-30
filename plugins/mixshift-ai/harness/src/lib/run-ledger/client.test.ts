import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunLedgerClient, tenantFromBearer } from './client.js';

/**
 * The run ledger HTTP client against a stubbed fetch: the wire shapes, and above all
 * that an older service (404/405 on the route) and an unprovisioned store (503) read
 * as "use the local ledger", never as "this brand has no ledger".
 */

const API_BASE = 'https://mcp.example.test';
let testDir: string;

function jwt(sub: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256' })}.${enc({ sub, aud: 'x' })}.sig`;
}

async function writeCredentials(accessToken: string): Promise<void> {
  const authDir = join(testDir, 'auth');
  await mkdir(authDir, { recursive: true });
  await writeFile(
    join(authDir, 'credentials'),
    JSON.stringify({
      schema_version: 2,
      created_at: '2026-07-01T00:00:00.000Z',
      datahub: {
        api_base: API_BASE,
        access_token: accessToken,
        refresh_token: 'refresh-token',
        expires_at: '2099-01-01T00:00:00.000Z',
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        user_id: 'u1',
        email: 'ops@example.com',
        person_label: 'am@example.com',
        device_label: 'test-device',
        client_id: 'mx-claude-plugin',
      },
    }),
    'utf8',
  );
}

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const LEDGER = {
  brand_slug: 'acme-goods',
  skill_id: 'mx-max-report',
  revision: 3,
  file_count: 1,
  total_bytes: 2,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  updated_by_actor: 'am@example.com',
  files: [{ path: 'publish-registry.json', content_hash: 'a'.repeat(64), byte_size: 2, revision: 3, updated_at: 'x', updated_by_actor: 'y', content: '{}' }],
};

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-runledger-client-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
  await writeCredentials(jwt('42'));
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('createRunLedgerClient', () => {
  it('GET: a brand with no ledger is ledger:null, with the tenant from the token', async () => {
    const { fetchImpl, calls } = stub(200, { ok: true, ledger: null });
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r).toEqual({ ok: true, ledger: null, tenant: '42' });
    expect(calls[0]!.url).toBe(`${API_BASE}/api/run-ledger?brand=acme-goods&skill=mx-max-report`);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it('GET: a ledger comes back whole', async () => {
    const { fetchImpl } = stub(200, { ok: true, ledger: LEDGER });
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r.ok && r.ledger?.revision).toBe(3);
  });

  it('GET: a ledger for a different brand than asked is refused', async () => {
    const { fetchImpl } = stub(200, { ok: true, ledger: { ...LEDGER, brand_slug: 'other' } });
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it.each([
    [404, { ok: false, kind: 'unknown', friendly: 'not_found' }, 'unsupported'],
    [404, '<html>Not Found</html>', 'unsupported'],
    [405, {}, 'unsupported'],
    [503, { ok: false, kind: 'ledger_unavailable' }, 'unavailable'],
    // Any other 503 (platform, edge, deploy) is an outage, never "store not provisioned".
    [503, '<html>Service Unavailable</html>', 'host_unreachable'],
    [503, { ok: false, kind: 'internal' }, 'host_unreachable'],
    [502, {}, 'host_unreachable'],
    [403, { ok: false, kind: 'insufficient_scope', friendly: 'no' }, 'insufficient_scope'],
    // The ledger route's own gate: a real scope refusal.
    [403, { ok: false, kind: 'insufficient_scope', friendly: 'no', required_scopes: ['run_ledger:read'] }, 'insufficient_scope'],
    // An older service gating the unknown path on its full read set: no ledger route there.
    [403, { ok: false, kind: 'insufficient_scope', friendly: 'no', required_scopes: ['ads:read', 'retail:read'] }, 'unsupported'],
    [500, { ok: false, kind: 'internal' }, 'unknown'],
  ])('HTTP %s maps to %s', async (status, body, kind) => {
    const { fetchImpl } = stub(status, body);
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r).toMatchObject({ ok: false, kind });
  });

  it('PUT: a stale revision is a conflict carrying the service head', async () => {
    const { fetchImpl, calls } = stub(409, {
      ok: false,
      kind: 'revision_conflict',
      friendly: 'changed',
      server: { revision: 7, updated_at: '2026-10-29T00:00:00Z', updated_by_actor: 'other@example.com' },
    });
    const body = { brand_slug: 'acme-goods', skill_id: 'mx-max-report', base_revision: 6, files: [{ path: 'a.json', content: '{}' }] };
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).put(body);
    expect(r).toMatchObject({ ok: false, kind: 'revision_conflict', server: { revision: 7, updated_by_actor: 'other@example.com' } });
    expect(calls[0]!.init!.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(body);
  });

  it('PUT: success', async () => {
    const { fetchImpl } = stub(200, { ok: true, status: 'updated', revision: 8, changed: 1 });
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).put({
      brand_slug: 'acme-goods',
      skill_id: 'mx-max-report',
      base_revision: 7,
      files: [{ path: 'a.json', content: '{}' }],
    });
    expect(r).toEqual({ ok: true, status: 'updated', revision: 8, tenant: '42' });
  });

  it('a network failure is host_unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r).toMatchObject({ ok: false, kind: 'host_unreachable' });
  });

  it('no sign-in at all is not_signed_in', async () => {
    await rm(join(testDir, 'auth'), { recursive: true, force: true });
    const { fetchImpl, calls } = stub(200, {});
    const r = await createRunLedgerClient({ dataDirOverride: testDir, fetchImpl }).get('acme-goods', 'mx-max-report');
    expect(r).toMatchObject({ ok: false, kind: 'not_signed_in' });
    expect(calls).toHaveLength(0);
  });
});

describe('tenantFromBearer', () => {
  it('reads sub from a JWT and nothing from anything else', () => {
    expect(tenantFromBearer(jwt('205'))).toBe('205');
    expect(tenantFromBearer('opaque-token')).toBeNull();
    expect(tenantFromBearer('a.!!!.c')).toBeNull();
  });
});
