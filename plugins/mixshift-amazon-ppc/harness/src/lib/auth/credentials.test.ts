import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentials,
  saveCredentials,
  loadOrInit,
} from './credentials.js';
import { newCredentials } from './schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-creds-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('loadCredentials', () => {
  it('returns null when no file exists', async () => {
    const result = await loadCredentials(testDir);
    expect(result.credentials).toBeNull();
    expect(result.path).toContain('credentials');
  });

  it('throws on malformed JSON', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(join(testDir, 'auth', 'credentials'), '{not valid json');
    await expect(loadCredentials(testDir)).rejects.toThrow(/malformed/i);
  });

  it('throws on schema violation', async () => {
    await mkdir(join(testDir, 'auth'), { recursive: true });
    await writeFile(
      join(testDir, 'auth', 'credentials'),
      JSON.stringify({ schema_version: 999, created_at: 'not-a-date' }),
    );
    await expect(loadCredentials(testDir)).rejects.toThrow(/invalid/i);
  });
});

describe('saveCredentials + round-trip', () => {
  it('round-trips a credentials object through disk', async () => {
    const creds = newCredentials();
    creds.mysql = {
      host: 'localhost',
      port: 3306,
      user: 'tester',
      password: 'sekret',
      database: 'testdb',
    };

    await saveCredentials(creds, testDir);
    const { credentials, path } = await loadCredentials(testDir);

    expect(credentials).not.toBeNull();
    expect(credentials!.mysql?.host).toBe('localhost');
    expect(credentials!.mysql?.password).toBe('sekret');
    expect(path).toContain('credentials');
  });

  it.runIf(platform() !== 'win32')(
    'writes the credentials file with mode 0600',
    async () => {
      const creds = newCredentials();
      creds.mysql = {
        host: 'h',
        port: 3306,
        user: 'u',
        password: 'p',
        database: 'd',
      };
      const { path } = await saveCredentials(creds, testDir);
      const st = await stat(path);
      // Mask to the permission bits we care about.
      expect(st.mode & 0o777).toBe(0o600);
    },
  );
});

describe('loadOrInit', () => {
  it('returns fresh skeleton when no file exists', async () => {
    const creds = await loadOrInit(testDir);
    expect(creds.schema_version).toBe(1);
    expect(creds.mysql).toBeUndefined();
  });

  it('returns existing credentials when file exists', async () => {
    const original = newCredentials();
    original.mysql = {
      host: 'h',
      port: 3306,
      user: 'u',
      password: 'p',
      database: 'd',
    };
    await saveCredentials(original, testDir);

    const loaded = await loadOrInit(testDir);
    expect(loaded.mysql?.host).toBe('h');
  });
});
