import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAttribution } from './attribution.js';
import { saveCredentials, serviceTokenCachePath } from '../auth/credentials.js';
import type { Credentials, DatahubCreds, ServiceCreds } from '../auth/schema.js';

async function makeTempDataDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'mxs-attribution-test-'));
}

function datahub(overrides?: Partial<DatahubCreds>): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: 'a'.repeat(24),
    refresh_token: 'r'.repeat(24),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    user_id: 'user-123',
    email: 'ops@acmeco.com',
    person_label: 'taylor.rivera@example.com',
    device_label: 'test-host',
    client_id: 'mx-claude-plugin',
    ...overrides,
  };
}

function service(overrides?: Partial<ServiceCreds>): ServiceCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    client_id: 'svc_abcdefgh1234',
    client_secret: 's'.repeat(24),
    label: 'ppc_placement_mod_key',
    ...overrides,
  };
}

async function writeCreds(dataDir: string, blocks: Partial<Credentials>): Promise<void> {
  await saveCredentials(
    { schema_version: 2, created_at: new Date().toISOString(), ...blocks },
    dataDir,
  );
}

async function writeTokenCache(
  dataDir: string,
  cache: Record<string, unknown>,
): Promise<void> {
  const path = serviceTokenCachePath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache), 'utf-8');
}

describe('resolveAttribution', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is anonymous when there is no credentials file', async () => {
    const a = await resolveAttribution(dataDir);
    expect(a).toEqual({
      personLabel: undefined,
      automation: false,
      actor: { kind: 'anonymous' },
    });
  });

  it('resolves a human actor from a datahub block', async () => {
    await writeCreds(dataDir, { datahub: datahub() });
    const a = await resolveAttribution(dataDir);
    expect(a.automation).toBe(false);
    expect(a.personLabel).toBe('taylor.rivera@example.com');
    expect(a.actor).toEqual({ kind: 'human', user_id: 'user-123' });
  });

  it('resolves a service actor with label + client_id and automation=true', async () => {
    await writeCreds(dataDir, { service: service() });
    const a = await resolveAttribution(dataDir);
    expect(a.automation).toBe(true);
    expect(a.personLabel).toBe('ppc_placement_mod_key');
    expect(a.actor.kind).toBe('service');
    expect(a.actor.svc_label).toBe('ppc_placement_mod_key');
    expect(a.actor.svc_client_id).toBe('svc_abcdefgh1234');
    // No mint attribution cached yet (P1): owner/minted_by/purpose absent.
    expect(a.actor.owner_user_id).toBeUndefined();
    expect(a.actor.minted_by).toBeUndefined();
  });

  it('falls back to client_id as the label when a service label is omitted', async () => {
    await writeCreds(dataDir, { service: service({ label: undefined }) });
    const a = await resolveAttribution(dataDir);
    expect(a.personLabel).toBe('svc_abcdefgh1234');
    expect(a.actor.svc_label).toBeUndefined();
    expect(a.actor.svc_client_id).toBe('svc_abcdefgh1234');
  });

  it('a human session wins over a co-present service block', async () => {
    await writeCreds(dataDir, { datahub: datahub(), service: service() });
    const a = await resolveAttribution(dataDir);
    expect(a.actor.kind).toBe('human');
    expect(a.automation).toBe(false);
    expect(a.personLabel).toBe('taylor.rivera@example.com');
  });

  it('enriches a service actor from the mint attribution cache (P2 path)', async () => {
    await writeCreds(dataDir, { service: service() });
    await writeTokenCache(dataDir, {
      access_token: 'x',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      client_id: 'svc_abcdefgh1234',
      attribution: {
        owner_user_id: 'user-999',
        minted_by: 'Mitch (via setup code)',
        purpose: 'ppc_placement_mod_key',
        scopes: ['ads:read', 'warehouse:read'],
      },
    });
    const a = await resolveAttribution(dataDir);
    expect(a.actor).toMatchObject({
      kind: 'service',
      svc_client_id: 'svc_abcdefgh1234',
      owner_user_id: 'user-999',
      minted_by: 'Mitch (via setup code)',
      purpose: 'ppc_placement_mod_key',
      scopes: ['ads:read', 'warehouse:read'],
    });
  });

  it('ignores cached attribution that belongs to a different client_id', async () => {
    await writeCreds(dataDir, { service: service() });
    await writeTokenCache(dataDir, {
      access_token: 'x',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      client_id: 'svc_someOtherCred99',
      attribution: { owner_user_id: 'user-000', minted_by: 'someone else' },
    });
    const a = await resolveAttribution(dataDir);
    expect(a.actor.owner_user_id).toBeUndefined();
    expect(a.actor.minted_by).toBeUndefined();
  });
});
