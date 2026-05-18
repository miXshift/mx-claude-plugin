import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginDefaults } from './load.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-defaults-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('loadPluginDefaults', () => {
  it('returns schema defaults when no file exists at override path', async () => {
    const result = await loadPluginDefaults(
      join(testDir, 'does-not-exist.yaml'),
    );
    expect(result.schema_version).toBe(1);
    expect(result.auth.public_ip_lookup_url).toBe(
      'https://api.ipify.org?format=json',
    );
  });

  it('loads from an explicit override path', async () => {
    const path = join(testDir, 'custom-defaults.yaml');
    await writeFile(
      path,
      [
        'schema_version: 1',
        'auth:',
        '  public_ip_lookup_url: https://api.ipify.org?format=other',
        '',
      ].join('\n'),
    );

    const result = await loadPluginDefaults(path);
    expect(result.auth.public_ip_lookup_url).toBe(
      'https://api.ipify.org?format=other',
    );
  });

  it('throws on schema violation', async () => {
    const path = join(testDir, 'bad-defaults.yaml');
    await writeFile(
      path,
      'schema_version: 999\nauth:\n  public_ip_lookup_url: not-a-url\n',
    );

    await expect(loadPluginDefaults(path)).rejects.toThrow(/invalid/i);
  });
});
