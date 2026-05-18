import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAuthSetup, type SetupDeps } from './setup-flow.js';
import { defaultsSchema } from '../defaults/schema.js';
import type { MysqlCreds } from './schema.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-setup-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const sampleMysql: MysqlCreds = {
  host: 'example.host',
  port: 3306,
  user: 'tester',
  password: 'sekret',
  database: 'testdb',
};

const sampleDefaults = defaultsSchema.parse({
  schema_version: 1,
  auth: {
    public_ip_lookup_url: 'https://api.ipify.org?format=json',
  },
});

function makeDeps(overrides: Partial<SetupDeps>): SetupDeps {
  return {
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    fetchPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
    ...overrides,
  };
}

describe('runAuthSetup', () => {
  it('saves creds + profile, returns ok on successful connection', async () => {
    const deps = makeDeps({});
    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: false,
        skip_connection_test: false,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('ok');
    expect(deps.testConnection).toHaveBeenCalledOnce();
    expect(deps.fetchPublicIp).not.toHaveBeenCalled();

    // Files were written
    const profileRaw = await readFile(join(testDir, 'profile.yaml'), 'utf-8');
    expect(profileRaw).toContain('sam@example.com');
    expect(profileRaw).toContain('install_id'); // populated UUID

    const credsRaw = await readFile(join(testDir, 'auth', 'credentials'), 'utf-8');
    expect(credsRaw).toContain('example.host');
    expect(credsRaw).toContain('sekret');
  });

  it('skips the connection test when requested', async () => {
    const deps = makeDeps({});
    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: false,
        skip_connection_test: true,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.connection_tested).toBe(false);
    expect(deps.testConnection).not.toHaveBeenCalled();
  });

  it('returns failed when IP not whitelisted and auto_request_whitelist=false', async () => {
    const deps = makeDeps({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'ip_not_allowed',
        message: 'Host not allowed',
      }),
    });

    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: false,
        skip_connection_test: false,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure_kind).toBe('ip_not_allowed');
    expect(deps.fetchPublicIp).not.toHaveBeenCalled();
  });

  it('captures public IP for an outgoing whitelist request when IP not allowed', async () => {
    // After v0.4.0 Discord routing is server-side (Supabase fan-out).
    // setup-flow's job is to detect ip_not_allowed + capture the public
    // IP so the telemetry event emitted by commands/auth.ts has enough
    // context for the Discord embed. There is no direct webhook call.
    const deps = makeDeps({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'ip_not_allowed',
        message: 'Host not allowed',
      }),
    });

    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: true,
        skip_connection_test: false,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('pending_whitelist');
    if (result.status !== 'pending_whitelist') throw new Error('unreachable');
    expect(result.whitelist_request_sent).toBe(true);
    expect(result.public_ip).toBe('1.2.3.4');
    expect(result.whitelist_request_error).toBeUndefined();
    expect(deps.fetchPublicIp).toHaveBeenCalledOnce();
  });

  it('marks the whitelist request as not-sent when public IP cannot be determined', async () => {
    // Without a public IP the Discord embed would be useless to the
    // operator, so we report "not sent" and surface a fallback message
    // pointing the user to the manual email path.
    const deps = makeDeps({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'ip_not_allowed',
        message: 'blocked',
      }),
      fetchPublicIp: vi.fn().mockResolvedValue(null),
    });

    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: true,
        skip_connection_test: false,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('pending_whitelist');
    if (result.status !== 'pending_whitelist') throw new Error('unreachable');
    expect(result.whitelist_request_sent).toBe(false);
    expect(result.public_ip).toBeUndefined();
    expect(result.whitelist_request_error).toMatch(/public IP/i);
  });

  it('reports access_denied with friendly message', async () => {
    const deps = makeDeps({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'access_denied',
        message: 'Access denied for user',
      }),
    });

    const result = await runAuthSetup(
      {
        email: 'sam@example.com',
        mysql: sampleMysql,
        auto_request_whitelist: true,
        skip_connection_test: false,
      },
      {
        defaults: sampleDefaults,
        plugin_version: 'test-0.0',
        data_dir_override: testDir,
      },
      deps,
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.failure_kind).toBe('access_denied');
    expect(result.message).toMatch(/username or password/i);
  });
});
