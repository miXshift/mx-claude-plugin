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
    ip_whitelist_webhook: 'https://example.com/webhook',
    public_ip_lookup_url: 'https://api.ipify.org?format=json',
  },
});

function makeDeps(overrides: Partial<SetupDeps>): SetupDeps {
  return {
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    fetchPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
    postWebhook: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
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
    expect(deps.postWebhook).not.toHaveBeenCalled();

    // Files were written
    const profileRaw = await readFile(join(testDir, 'profile.yaml'), 'utf-8');
    expect(profileRaw).toContain('sam@example.com');
    expect(profileRaw).toContain('user_id'); // populated UUID

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

  it('sends a whitelist request when IP not allowed and auto_request_whitelist=true', async () => {
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
    expect(deps.postWebhook).toHaveBeenCalledOnce();

    // The webhook URL passed to the dep is the one from defaults
    expect(deps.postWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        user_email: 'sam@example.com',
        public_ip: '1.2.3.4',
      }),
    );
  });

  it('records a whitelist failure when the webhook POST fails', async () => {
    const deps = makeDeps({
      testConnection: vi.fn().mockResolvedValue({
        ok: false,
        kind: 'ip_not_allowed',
        message: 'blocked',
      }),
      postWebhook: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'network down' }),
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
    expect(result.whitelist_request_error).toBe('network down');
  });

  it('falls back gracefully when public IP cannot be determined', async () => {
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
    expect(deps.postWebhook).not.toHaveBeenCalled();
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
