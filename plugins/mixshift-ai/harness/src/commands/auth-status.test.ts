/**
 * `mixshift auth status`: a read-only report of the local sign-in state.
 *
 * Pinned: signed-out names the two-phase agent sign-in (never bare blocking
 * `auth login`), human and service credentials are told apart, an expired
 * access token that can still renew reads as signed in, a dead refresh token
 * reads as needing sign-in, --json carries a stable shape, and the command
 * touches no network and rewrites no credentials.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerAuthCommands, buildAuthStatusReport } from './auth.js';
import { saveDatahub, saveService, saveCredentials, loadCredentials } from '../lib/auth/credentials.js';
import { newCredentials } from '../lib/auth/schema.js';

let dataDir: string;
let out: string;
let err: string;
let fetchSpy: ReturnType<typeof vi.fn>;
let priorExitCode: typeof process.exitCode;

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function datahub(over: { expires?: number; refreshExpires?: number } = {}) {
  return {
    api_base: 'https://auth.example.test',
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    expires_at: iso(over.expires ?? 12 * HOUR),
    refresh_expires_at: iso(over.refreshExpires ?? 24 * 30 * HOUR),
    user_id: '1',
    email: 'tenant@example.test',
    person_label: 'person@example.test',
    device_label: 'test-device',
    client_id: 'mx-claude-plugin',
  };
}

async function status(...extra: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'emit JSON', false);
  program.option('--data-dir <dir>', 'data dir override');
  registerAuthCommands(program);
  await program.parseAsync(['auth', 'status', '--data-dir', dataDir, ...extra], { from: 'user' });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-authstatus-'));
  out = '';
  err = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((err += String(c)), true));
  fetchSpy = vi.fn().mockRejectedValue(new Error('auth status must not use the network'));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(async () => {
  process.exitCode = priorExitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('auth status', () => {
  it('signed out: says so, points at the two-phase flow, exits 0', async () => {
    await status();
    expect(out).toMatch(/^Not signed in\./);
    expect(out).toContain('sign in to MixShift');
    expect(out).toContain('mixshift auth device-init');
    expect(out).toContain('mixshift auth device-poll');
    expect(out).not.toMatch(/run `mixshift auth login`/);
    expect(process.exitCode).toBeUndefined();
  });

  it('signed out --json', async () => {
    await status('--json');
    const r = JSON.parse(out);
    expect(r).toMatchObject({ signed_in: false, credential: 'none', needs_sign_in: true });
    expect(r.next_step).toContain('device-init');
    expect(process.exitCode).toBeUndefined();
  });

  it('human sign-in: actor, tenant login, expiry; never prints a token', async () => {
    await saveDatahub(datahub(), dataDir);
    await status();
    expect(out).toContain('Signed in (human sign-in) as person@example.test');
    expect(out).toContain('tenant login: tenant@example.test');
    expect(out).toContain('https://auth.example.test');
    expect(out).toMatch(/access token valid until /);
    expect(out).not.toContain('synthetic-access-token');
    expect(out).not.toContain('synthetic-refresh-token');
  });

  it('human sign-in --json shape', async () => {
    const d = datahub();
    await saveDatahub(d, dataDir);
    await status('--json');
    expect(JSON.parse(out)).toEqual({
      signed_in: true,
      credential: 'human',
      actor: 'person@example.test',
      tenant_login: 'tenant@example.test',
      service: 'https://auth.example.test',
      access_expires_at: d.expires_at,
      access_expired: false,
      needs_sign_in: false,
    });
  });

  it('expired access token that can still renew is still signed in', async () => {
    await saveDatahub(datahub({ expires: -HOUR }), dataDir);
    await status('--json');
    const r = JSON.parse(out);
    expect(r).toMatchObject({ signed_in: true, access_expired: true, needs_sign_in: false });
    await status();
    expect(out).toContain('renews itself on the next call');
  });

  it('refresh token past its expiry: needs a new sign-in, via the agent flow', async () => {
    await saveDatahub(datahub({ expires: -2 * HOUR, refreshExpires: -HOUR }), dataDir);
    await status('--json');
    const r = JSON.parse(out);
    expect(r).toMatchObject({ signed_in: false, credential: 'human', needs_sign_in: true });
    expect(r.next_step).toContain('device-init');
  });

  it('service credential: reported as service, no expiry to track', async () => {
    await saveService(
      { api_base: 'https://auth.example.test', client_id: 'svc_synthetic01', client_secret: 'x'.repeat(24), label: 'svc:nightly' },
      dataDir,
    );
    await status('--json');
    expect(JSON.parse(out)).toEqual({
      signed_in: true,
      credential: 'service',
      actor: 'svc:nightly',
      service: 'https://auth.example.test',
      client_id: 'svc_synthetic01',
      label: 'svc:nightly',
      needs_sign_in: false,
    });
    expect(out).not.toContain('xxxxxxxx');
    await status();
    expect(out).toContain('Signed in (service credential) svc:nightly');
  });

  it('legacy raw-MySQL credential is reported, with the token sign-in as the way forward', async () => {
    await saveCredentials(
      { ...newCredentials(), mysql: { host: 'db.example.test', port: 3306, user: 'u', password: 'p', database: 'd' } },
      dataDir,
    );
    await status('--json');
    expect(JSON.parse(out)).toMatchObject({ signed_in: true, credential: 'legacy_mysql' });
  });

  it('a malformed credentials file reads as signed out and does not throw', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { credentialsPath } = await import('../lib/paths/resolve.js');
    await mkdir(join(credentialsPath(dataDir), '..'), { recursive: true });
    await writeFile(credentialsPath(dataDir), '{not json', 'utf-8');
    await status('--json');
    expect(JSON.parse(out)).toMatchObject({ signed_in: false });
  });

  it('is read-only: no network call, credentials file byte-identical', async () => {
    await saveDatahub(datahub({ expires: -HOUR }), dataDir);
    const { path } = await loadCredentials(dataDir);
    const before = await readFile(path, 'utf-8');
    await status();
    await status('--json');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf-8')).toBe(before);
    expect(err).toBe('');
  });
});

describe('buildAuthStatusReport', () => {
  it('signed out carries no actor or expiry fields', () => {
    expect(buildAuthStatusReport({ signedIn: false, kind: 'none' })).toMatchObject({
      signed_in: false,
      credential: 'none',
      needs_sign_in: true,
    });
  });
});
