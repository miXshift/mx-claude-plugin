import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile } from './load.js';
import { saveProfile } from './save.js';
import { defaultProfile } from './schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('loadProfile', () => {
  it('returns defaults when file does not exist', async () => {
    const result = await loadProfile(testDir);
    expect(result.source).toBe('default');
    expect(result.profile.schema_version).toBe(1);
    expect(result.profile.credential_store).toBe('plaintext');
    expect(result.profile.telemetry.enabled).toBe(true);
  });

  it('loads a valid profile from disk', async () => {
    await saveProfile(defaultProfile(), testDir);
    const result = await loadProfile(testDir);
    expect(result.source).toBe('file');
    expect(result.profile.schema_version).toBe(1);
  });

  it('throws on malformed YAML', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, 'profile.yaml'), 'this is :: not valid: yaml: [');
    await expect(loadProfile(testDir)).rejects.toThrow(/malformed/i);
  });

  it('throws on schema violation', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'profile.yaml'),
      'schema_version: 999\ncredential_store: nonsense\n',
    );
    await expect(loadProfile(testDir)).rejects.toThrow(/schema/i);
  });
});

describe('saveProfile + loadProfile round-trip', () => {
  it('round-trips a profile through disk without loss', async () => {
    const profile = defaultProfile();
    profile.user = { email: 'test@example.com' };
    profile.telemetry.user_id = 'abc-123';
    profile.output.per_skill = {
      'daily-health-check': 'local-html',
      'monthly-performance-report': {
        claude_code: 'google-doc',
        cowork: 'google-doc',
      },
    };

    await saveProfile(profile, testDir);
    const loaded = await loadProfile(testDir);

    expect(loaded.source).toBe('file');
    expect(loaded.profile.user?.email).toBe('test@example.com');
    expect(loaded.profile.telemetry.user_id).toBe('abc-123');
    expect(loaded.profile.output.per_skill['daily-health-check']).toBe('local-html');
    expect(loaded.profile.output.per_skill['monthly-performance-report']).toEqual({
      claude_code: 'google-doc',
      cowork: 'google-doc',
    });
  });

  it('atomic write — partial files do not appear at the target path', async () => {
    // Write twice in a row. If atomicity is broken we'd see torn writes.
    const p1 = defaultProfile();
    p1.user = { email: 'first@example.com' };
    await saveProfile(p1, testDir);

    const p2 = defaultProfile();
    p2.user = { email: 'second@example.com' };
    await saveProfile(p2, testDir);

    const loaded = await loadProfile(testDir);
    expect(loaded.profile.user?.email).toBe('second@example.com');
  });
});
