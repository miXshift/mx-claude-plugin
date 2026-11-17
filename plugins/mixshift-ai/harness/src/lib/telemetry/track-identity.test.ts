import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { track } from './index.js';
import { readQueue, clearQueue } from './queue.js';
import { saveCredentials } from '../auth/credentials.js';
import type { DatahubCreds } from '../auth/schema.js';

/** JWT-shaped access token carrying the given claims (signature not checked by the plugin). */
function makeJwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(claims)}.sig`;
}

function datahub(accessToken: string, overrides?: Partial<DatahubCreds>): DatahubCreds {
  return {
    api_base: 'https://mcp.mixshift.io',
    access_token: accessToken,
    refresh_token: 'r'.repeat(24),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    user_id: 'user-123',
    email: 'ops@acmeco.com',
    person_label: 'typed.hint@acmeco.com',
    device_label: 'test-host',
    client_id: 'mx-claude-plugin',
    ...overrides,
  };
}

const MEMBER_TOKEN = makeJwt({
  sub: 'user-777',
  email: 'ops@acmeco.com',
  actor: 'jordan.lee@acmeco.com',
  idv: 'member',
  org: 'org_42',
});

describe('track() identity stamping', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mxs-track-identity-'));
    delete process.env.MIXSHIFT_TELEMETRY;
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.MIXSHIFT_TELEMETRY;
  });

  async function onlyEvent(input: Parameters<typeof track>[0]) {
    await track({ event_name: 'warmup' }, dataDir); // absorbs the synthetic plugin.installed
    await clearQueue(dataDir);
    await track(input, dataDir);
    const queue = await readQueue(dataDir);
    expect(queue).toHaveLength(1);
    return queue[0]!;
  }

  it('member sign-in: the person is the verified token actor, the org login stays in email', async () => {
    await saveCredentials(
      { schema_version: 2, created_at: new Date().toISOString(), datahub: datahub(MEMBER_TOKEN) },
      dataDir,
    );
    const ev = await onlyEvent({ event_name: 'skill.completed' });
    expect(ev.person_label).toBe('jordan.lee@acmeco.com');
    expect(ev.email).toBe('ops@acmeco.com');
    expect(ev.payload?.actor).toEqual({
      kind: 'human',
      user_id: 'user-777',
      identity: 'member_sign_in',
      verified: true,
      org_id: 'org_42',
    });
  });

  it('a caller-supplied person_label that differs is flagged and never verified', async () => {
    await saveCredentials(
      { schema_version: 2, created_at: new Date().toISOString(), datahub: datahub(MEMBER_TOKEN) },
      dataDir,
    );
    const ev = await onlyEvent({ event_name: 'user.identified', person_label: 'someone.else@acmeco.com' });
    expect(ev.person_label).toBe('someone.else@acmeco.com');
    expect(ev.payload?.actor).toMatchObject({
      identity: 'member_sign_in',
      verified: false,
      overridden: ['person_label'],
    });
  });

  it('a caller-supplied value equal to the token one (any case) is not an override', async () => {
    await saveCredentials(
      { schema_version: 2, created_at: new Date().toISOString(), datahub: datahub(MEMBER_TOKEN) },
      dataDir,
    );
    const ev = await onlyEvent({
      event_name: 'auth.login_completed',
      person_label: 'Jordan.Lee@acmeco.com',
      email: 'OPS@acmeco.com',
    });
    expect(ev.payload?.actor).toMatchObject({ identity: 'member_sign_in', verified: true });
    expect(ev.payload?.actor).not.toHaveProperty('overridden');
  });

  it('an email override is recorded but does not unverify the person', async () => {
    await saveCredentials(
      { schema_version: 2, created_at: new Date().toISOString(), datahub: datahub(MEMBER_TOKEN) },
      dataDir,
    );
    const ev = await onlyEvent({ event_name: 'skill.invoked', email: 'other-login@acmeco.com' });
    expect(ev.email).toBe('other-login@acmeco.com');
    expect(ev.payload?.actor).toMatchObject({ verified: true, overridden: ['email'] });
  });

  it('shared login: the typed address is self-attested', async () => {
    const token = makeJwt({ sub: 'user-777', email: 'ops@acmeco.com', actor: 'pat.kim@acmeco.com' });
    await saveCredentials(
      { schema_version: 2, created_at: new Date().toISOString(), datahub: datahub(token) },
      dataDir,
    );
    const ev = await onlyEvent({ event_name: 'skill.completed' });
    expect(ev.person_label).toBe('pat.kim@acmeco.com');
    expect(ev.payload?.actor).toEqual({
      kind: 'human',
      user_id: 'user-777',
      identity: 'shared_login',
      verified: false,
    });
  });

  it('an empty caller email is treated as not supplied', async () => {
    const ev = await onlyEvent({ event_name: 'feedback.submitted', email: '' });
    expect(ev.email).toBeUndefined();
    expect(ev.payload?.actor).toEqual({ kind: 'anonymous' });
  });

  it('anonymous with a caller email (legacy setup path) records the override', async () => {
    const ev = await onlyEvent({ event_name: 'auth.completed', email: 'someone@acmeco.com' });
    expect(ev.payload?.actor).toEqual({ kind: 'anonymous', overridden: ['email'] });
  });
});
