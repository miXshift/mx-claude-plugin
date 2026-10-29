/**
 * `mixshift report ledger pull|push|status`: the flag contract, the JSON envelope the
 * skill reads (`state`), and the exit codes (0 = the skill may proceed, 1 = refused,
 * 2 = bad arguments). The service is an in-memory fake behind the client seam; the
 * sync logic itself is covered in lib/run-ledger/sync.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerReportCommands } from './report.js';
import { checkLedgerArgs, setRunLedgerClientFactoryForTests } from './report-ledger.js';
import type { RunLedgerClient } from '../lib/run-ledger/client.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false);
  program.option('--data-dir <path>', 'data dir');
  registerReportCommands(program);
  return program;
}

let dir: string;
let out: string[];
let exitCodeBefore: typeof process.exitCode;

async function run(...args: string[]): Promise<Record<string, any>> {
  out = [];
  await buildProgram().parseAsync(['node', 'mixshift', '--json', '--data-dir', dir, 'report', 'ledger', ...args]);
  return JSON.parse(out.join('\n')) as Record<string, any>;
}

function fakeClient(over: Partial<RunLedgerClient> = {}): RunLedgerClient {
  return {
    tenant: async () => '42',
    get: async () => ({ ok: true, ledger: null, tenant: '42' }),
    put: async () => ({ ok: true, status: 'created', revision: 1, tenant: '42' }),
    ...over,
  };
}

beforeEach(async () => {
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), 'mx-report-ledger-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  setRunLedgerClientFactoryForTests(null);
  process.exitCode = exitCodeBefore;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('report ledger', () => {
  it('pull with nothing anywhere: state absent, exit 0', async () => {
    setRunLedgerClientFactoryForTests(() => fakeClient());
    const r = await run('pull', '--brand', 'acme-goods');
    expect(r).toMatchObject({ ok: true, state: 'absent', brand: 'acme-goods', skill: 'mx-max-report' });
    expect(process.exitCode).toBe(0);
  });

  it('pull against an older service: gateway_unavailable, exit 0 (the skill falls back, fail-closed)', async () => {
    setRunLedgerClientFactoryForTests(() =>
      fakeClient({ get: async () => ({ ok: false, kind: 'unsupported', friendly: 'old', http_status: 404 }) }),
    );
    const r = await run('pull', '--brand', 'acme-goods');
    expect(r.state).toBe('gateway_unavailable');
    expect(r.failure).toMatchObject({ kind: 'unsupported', http_status: 404 });
    expect(process.exitCode).toBe(0);
  });

  it('pull with only a local ledger uploads nothing: state local_only, exit 0', async () => {
    const ledger = join(dir, 'clients', 'acme-goods', 'runs', 'mx-monthly-report-max');
    await mkdir(ledger, { recursive: true });
    await writeFile(join(ledger, 'publish-registry.json'), '{"client_hub_url":"https://example.test/h"}');
    const put = vi.fn(async () => ({ ok: true as const, status: 'created' as const, revision: 1, tenant: '42' }));
    setRunLedgerClientFactoryForTests(() => fakeClient({ put }));
    const r = await run('pull', '--brand', 'acme-goods');
    expect(r).toMatchObject({ ok: true, state: 'local_only', local_files: 1 });
    expect(put).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('push without a prior pull, the service holding a ledger: pull_first, ok false, exit 1', async () => {
    const ledger = join(dir, 'clients', 'acme-goods', 'runs', 'mx-monthly-report-max');
    await mkdir(ledger, { recursive: true });
    await writeFile(join(ledger, 'publish-registry.json'), '{}');
    setRunLedgerClientFactoryForTests(() =>
      fakeClient({
        get: async () => ({
          ok: true,
          tenant: '42',
          ledger: {
            brand_slug: 'acme-goods',
            skill_id: 'mx-max-report',
            revision: 2,
            file_count: 0,
            total_bytes: 0,
            created_at: 'x',
            updated_at: 'x',
            updated_by_actor: 'x',
            files: [],
          },
        }),
      }),
    );
    const r = await run('push', '--brand', 'acme-goods');
    expect(r).toMatchObject({ ok: false, state: 'pull_first' });
    expect(process.exitCode).toBe(1);
  });

  it('push without a prior pull and no service ledger creates it: pushed, exit 0', async () => {
    const ledger = join(dir, 'clients', 'acme-goods', 'runs', 'mx-monthly-report-max');
    await mkdir(ledger, { recursive: true });
    await writeFile(join(ledger, 'publish-registry.json'), '{}');
    setRunLedgerClientFactoryForTests(() => fakeClient());
    const r = await run('push', '--brand', 'acme-goods');
    expect(r).toMatchObject({ ok: true, state: 'pushed', revision: 1 });
    expect(process.exitCode).toBe(0);
  });

  it('status reports both sides', async () => {
    setRunLedgerClientFactoryForTests(() => fakeClient());
    const r = await run('status', '--brand', 'acme-goods');
    expect(r).toMatchObject({ ok: true, local_files: 0, synced_revision: null, service: { available: true, revision: null } });
  });

  it.each([
    ['an unsafe slug', ['pull', '--brand', '../evil']],
    ['an uppercase slug', ['pull', '--brand', 'Acme']],
    ['an unknown skill', ['pull', '--brand', 'acme-goods', '--skill', 'mx-monthly-report']],
  ])('refuses %s with exit 2 and no service call', async (_label, args) => {
    const get = vi.fn();
    setRunLedgerClientFactoryForTests(() => fakeClient({ get }));
    const r = await run(...args);
    expect(r).toMatchObject({ ok: false, error_class: 'bad_params' });
    expect(process.exitCode).toBe(2);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('checkLedgerArgs', () => {
  it('accepts a service-shaped slug and the default skill', () => {
    expect(checkLedgerArgs({ brand: 'acme-goods' })).toBeNull();
    expect(checkLedgerArgs({ brand: 'acme-goods', skill: 'mx-max-report' })).toBeNull();
  });
});
