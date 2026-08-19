/**
 * Command-level tests for `mixshift brand add` — focused on the push
 * outcome surfaced in JSON + human output (BootstrapResult.push), and on
 * NOT duplicating pushAfterWrite's own deduped stderr failure notice (see
 * push-after-write.ts's emitNotice, called from inside bootstrapBrand).
 * Mirrors commands/brand-promote.test.ts's rationale: a lib-level test
 * (bootstrap.test.ts) can pass while the CLI's own output wiring still
 * duplicates or drops the signal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../lib/discovery/seller-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/discovery/seller-query.js')>();
  return { ...actual, discoverSellers: vi.fn() };
});

vi.mock('../lib/context-sync/push-after-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/push-after-write.js')>();
  return { ...actual, pushAfterWrite: vi.fn() };
});

import { registerBrandCommands } from './brand.js';
import { discoverSellers } from '../lib/discovery/seller-query.js';
import { pushAfterWrite } from '../lib/context-sync/push-after-write.js';
import type { SellerRow } from '../lib/discovery/seller-query.js';

const mockedDiscoverSellers = vi.mocked(discoverSellers);
const mockedPushAfterWrite = vi.mocked(pushAfterWrite);

const SELLER_ROW: SellerRow = {
  seller_id: 1,
  seller_name: 'Acme Widgets',
  amazon_seller_id: 'A1EXAMPLE23456',
  merchant_alias: null,
  account_type: 'SC',
  marketplace: 'United States',
  region: 'NA',
  agency_name: null,
  acos_target: 22,
  ads_active: true,
  retail_active: true,
  is_active: true,
  has_mws: true,
  created_at: null,
  updated_at: null,
};

let dataDir: string;
let stdout: string;
let stderr: string;
let priorExitCode: typeof process.exitCode;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'emit JSON', false);
  program.option('--data-dir <dir>', 'data dir override');
  registerBrandCommands(program);
  return program;
}

async function runAdd(slug: string, extraArgs: string[] = []): Promise<void> {
  const program = newProgram();
  try {
    await program.parseAsync(['brand', 'add', slug, ...extraArgs, '--data-dir', dataDir], {
      from: 'user',
    });
  } catch {
    // exitOverride throws on non-zero exit; assertions read exitCode/stdout/stderr instead
  }
}

function emittedJson(): Record<string, unknown> {
  const start = stdout.indexOf('{');
  expect(start, `no JSON in stdout: ${stdout}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-brandadd-'));
  stdout = '';
  stderr = '';
  priorExitCode = process.exitCode;
  process.exitCode = undefined;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  mockedDiscoverSellers.mockReset();
  mockedDiscoverSellers.mockResolvedValue([SELLER_ROW]);
  mockedPushAfterWrite.mockReset();
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  process.exitCode = priorExitCode;
  await rm(dataDir, { recursive: true, force: true });
});

describe('brand add — push outcome in JSON output', () => {
  it('includes push:{attempted:true,published:true} on a successful auto-publish', async () => {
    mockedPushAfterWrite.mockResolvedValue({
      published: true,
      pushed: 0,
      created: 2,
      conflicts: 0,
      errors: 0,
      reports: [],
    });
    await runAdd('acme-widgets', ['--json']);
    const out = emittedJson();
    expect(out.status).toBe('ok');
    expect(out.push).toEqual({ attempted: true, published: true });
  });

  it('includes push:{attempted:true,published:false,reason,detail} on a failed auto-publish', async () => {
    mockedPushAfterWrite.mockResolvedValue({
      published: false,
      reason: 'failed',
      detail: 'the auth service is unreachable',
    });
    await runAdd('acme-widgets', ['--json']);
    const out = emittedJson();
    expect(out.status).toBe('ok');
    expect(out.push).toEqual({
      attempted: true,
      published: false,
      reason: 'failed',
      detail: 'the auth service is unreachable',
    });
  });
});

describe('brand add — human output: one success line, no duplicate failure', () => {
  it('prints exactly one "reached your team" confirmation line on success', async () => {
    mockedPushAfterWrite.mockImplementation(async () => {
      // Mirror the REAL seam's own side effect (push-after-write.ts's
      // emitNotice): it prints its own confirmation to stderr.
      process.stderr.write(`✓ Shared acme-widgets to your team's brand context (2 doc(s)).\n`);
      return { published: true, pushed: 0, created: 2, conflicts: 0, errors: 0, reports: [] };
    });
    await runAdd('acme-widgets');
    expect(stderr).toContain(`✓ Shared acme-widgets to your team's brand context (2 doc(s)).`);
    expect(stderr).toContain(`this brand's context reached your team`);
    // Two DIFFERENT lines (the seam's own + brand add's own) — never the
    // exact same line printed twice.
    const occurrences = (line: string): number =>
      stderr.split(line).length - 1;
    expect(occurrences(`✓ Shared acme-widgets to your team's brand context (2 doc(s)).`)).toBe(1);
    expect(occurrences(`this brand's context reached your team`)).toBe(1);
  });

  it('does not repeat the failure notice: the seam prints it once, brand add adds nothing more', async () => {
    mockedPushAfterWrite.mockImplementation(async () => {
      process.stderr.write(
        'Could not sync acme-widgets to your team just now; your work is saved locally. ' +
          'Retry with `mixshift context push --brand acme-widgets`.\n',
      );
      return { published: false, reason: 'failed', detail: 'the auth service is unreachable' };
    });
    await runAdd('acme-widgets');
    const occurrences = stderr.split('Could not sync acme-widgets').length - 1;
    expect(occurrences).toBe(1);
    expect(stderr).not.toContain('reached your team');
  });

  it('prints no shared/reached line at all when the push was never attempted (deferred)', async () => {
    // brand add never defers, but a push:undefined result (no attempt) must
    // not fabricate a success line either — belt-and-suspenders on the
    // `result.push?.published` guard.
    mockedPushAfterWrite.mockResolvedValue({ published: false, reason: 'disabled' });
    await runAdd('acme-widgets');
    expect(stderr).not.toContain('reached your team');
  });
});

describe('brand add — unknown slug', () => {
  it('errors without attempting a push', async () => {
    await runAdd('does-not-exist', ['--json']);
    const out = emittedJson();
    expect(out.status).toBe('error');
    expect(mockedPushAfterWrite).not.toHaveBeenCalled();
  });
});
