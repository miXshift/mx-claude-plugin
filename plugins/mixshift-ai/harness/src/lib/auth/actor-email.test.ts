import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActorEmail } from './actor-email.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-actor-email-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeProfile(yaml: string): Promise<void> {
  await writeFile(join(testDir, 'profile.yaml'), yaml, 'utf-8');
}

async function writeDatahubCreds(personLabel: string): Promise<void> {
  await mkdir(join(testDir, 'auth'), { recursive: true });
  const creds = {
    schema_version: 2,
    created_at: '2026-01-01T00:00:00.000Z',
    datahub: {
      api_base: 'https://mcp.mixshift.io',
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: '2026-01-01T00:00:00.000Z',
      refresh_expires_at: '2026-02-01T00:00:00.000Z',
      user_id: 'u1',
      email: 'tenant@example.com',
      person_label: personLabel,
      device_label: 'dev',
      client_id: 'mx-claude-plugin',
    },
  };
  await writeFile(join(testDir, 'auth', 'credentials'), JSON.stringify(creds), 'utf-8');
}

describe('resolveActorEmail', () => {
  it('returns undefined when nothing is on disk (anonymous, no throw)', async () => {
    await expect(resolveActorEmail(testDir)).resolves.toBeUndefined();
  });

  it('prefers profile.user.email when present', async () => {
    await writeProfile('schema_version: 1\nuser:\n  email: sam@example.com\n');
    await writeDatahubCreds('actor@example.com');
    await expect(resolveActorEmail(testDir)).resolves.toBe('sam@example.com');
  });

  it('falls back to credentials person_label when the profile has no email', async () => {
    await writeProfile('schema_version: 1\nuser: {}\n');
    await writeDatahubCreds('actor@example.com');
    await expect(resolveActorEmail(testDir)).resolves.toBe('actor@example.com');
  });

  it('does not throw on a malformed profile; degrades to the credential identity', async () => {
    await writeProfile('schema_version: 1\nuser: : : broken\n');
    await writeDatahubCreds('actor@example.com');
    await expect(resolveActorEmail(testDir)).resolves.toBe('actor@example.com');
  });

  it('returns undefined (no throw) when both profile and credentials are absent or unusable', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(join(testDir, 'auth', 'credentials'), '{not valid json', 'utf-8');
    await expect(resolveActorEmail(testDir)).resolves.toBeUndefined();
  });
});
