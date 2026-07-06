/**
 * Command-level tests for the `mixshift brand key add|remove|clear` →
 * org-assignment mirror (PUT /api/context/assignments, role 'key').
 *
 * The context-sync client factory is mocked to capture putAssignment
 * calls; the key-brands lib (profile.yaml + index.yaml) runs for real
 * against a temp data dir, pinning the P2 contract:
 *
 *   - every successful local mutation fires one PUT per slug with
 *     role 'key' and the matching op;
 *   - an offline/failed mirror NEVER fails the command or reverts the
 *     local list (best-effort by design; reads stay ungated).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { registerBrandCommands } from './brand.js';
import {
  createContextSyncClient,
  type AssignmentInput,
  type ContextSyncClient,
} from '../lib/context-sync/client.js';

vi.mock('../lib/context-sync/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/client.js')>();
  return {
    ...actual,
    createContextSyncClient: vi.fn(),
  };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return {
    ...actual, // keep EventName real
    track: vi.fn(async () => {}),
  };
});

function assignmentClient(ok: boolean): {
  client: ContextSyncClient;
  assignments: AssignmentInput[];
} {
  const assignments: AssignmentInput[] = [];
  const client: ContextSyncClient = {
    fetchManifest: async () => ({ ok: true, brands: [] }),
    fetchDoc: async () => ({ ok: false, kind: 'not_found', message: 'nf', friendly: 'nf' }),
    putDoc: async () => ({ ok: true, status: 'created', revision: 1 }),
    putAssignment: async (input) => {
      assignments.push(input);
      return ok
        ? { ok: true }
        : {
            ok: false,
            kind: 'host_unreachable',
            message: 'fetch failed',
            friendly: 'The MixShift auth service is unreachable.',
          };
    },
  };
  return { client, assignments };
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerBrandCommands(program);
  return program;
}

async function runBrand(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', 'brand', ...args]);
}

let tmpDataDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];
let exitCodeBefore: typeof process.exitCode;

function account(sellerId: number): Record<string, unknown> {
  return {
    seller_id: sellerId,
    seller_name: `Seller ${sellerId}`,
    merchant_alias: null,
    account_type: 'SC',
    marketplace: 'Amazon.com',
    region: 'NA',
    is_active: true,
    is_mws_user: true,
    ads_active: true,
    retail_active: true,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  stdoutChunks = [];
  stderrChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });

  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-brand-key-'));
  const clientsDir = join(tmpDataDir, 'clients');
  await mkdir(clientsDir, { recursive: true });
  await writeFile(
    join(clientsDir, 'index.yaml'),
    stringifyYaml({
      schema_version: 1,
      discovered_at: new Date().toISOString(), // fresh — no TTL re-discovery
      brands: [
        {
          slug: 'acme',
          display_name: 'Acme Corp',
          ads_active: true,
          retail_active: true,
          is_dormant: false,
          cold_started: false,
          cold_started_at: null,
          accounts: [account(574)],
        },
        {
          slug: 'zenco',
          display_name: 'Zen Co',
          ads_active: true,
          retail_active: true,
          is_dormant: false,
          cold_started: false,
          cold_started_at: null,
          accounts: [account(900)],
        },
      ],
    }),
    'utf8',
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDataDir, { recursive: true, force: true });
});

async function keyListInProfile(): Promise<string[]> {
  const raw = await readFile(join(tmpDataDir, 'profile.yaml'), 'utf8');
  const parsed = parseYaml(raw) as { brands?: { key?: string[] } };
  return parsed.brands?.key ?? [];
}

describe('brand key add → assignment mirror', () => {
  it('fires one PUT per added brand with op add and role key', async () => {
    const { client, assignments } = assignmentClient(true);
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('key', 'add', 'acme', 'zenco', '--data-dir', tmpDataDir);

    expect(assignments).toEqual([
      { op: 'add', brand_slug: 'acme', role: 'key' },
      { op: 'add', brand_slug: 'zenco', role: 'key' },
    ]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('does not mirror an already-key no-op', async () => {
    const { client, assignments } = assignmentClient(true);
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('key', 'add', 'acme', '--data-dir', tmpDataDir);
    assignments.length = 0;
    await runBrand('key', 'add', 'acme', '--data-dir', tmpDataDir);
    expect(assignments).toEqual([]);
  });

  it('offline mirror: local add still succeeds, exit 0, one-line note printed', async () => {
    const { client, assignments } = assignmentClient(false);
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('key', 'add', 'acme', '--data-dir', tmpDataDir);

    expect(assignments).toHaveLength(1);
    expect(process.exitCode ?? 0).toBe(0);
    expect(await keyListInProfile()).toEqual(['acme']);
    expect(stderrChunks.join('')).toContain('not mirrored to the org store');
  });
});

describe('brand key remove → assignment mirror', () => {
  it('fires op remove for a removed brand; local list updated even when offline', async () => {
    const okMirror = assignmentClient(true);
    vi.mocked(createContextSyncClient).mockReturnValue(okMirror.client);
    await runBrand('key', 'add', 'acme', 'zenco', '--data-dir', tmpDataDir);

    const failMirror = assignmentClient(false);
    vi.mocked(createContextSyncClient).mockReturnValue(failMirror.client);
    await runBrand('key', 'remove', 'acme', '--data-dir', tmpDataDir);

    expect(failMirror.assignments).toEqual([
      { op: 'remove', brand_slug: 'acme', role: 'key' },
    ]);
    expect(await keyListInProfile()).toEqual(['zenco']);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('does not mirror a not-key no-op', async () => {
    const { client, assignments } = assignmentClient(true);
    vi.mocked(createContextSyncClient).mockReturnValue(client);
    await runBrand('key', 'remove', 'acme', '--data-dir', tmpDataDir);
    expect(assignments).toEqual([]);
  });
});

describe('brand key clear → assignment mirror', () => {
  it('fires op remove for every cleared slug', async () => {
    const { client, assignments } = assignmentClient(true);
    vi.mocked(createContextSyncClient).mockReturnValue(client);
    await runBrand('key', 'add', 'acme', 'zenco', '--data-dir', tmpDataDir);
    assignments.length = 0;

    await runBrand('key', 'clear', '--data-dir', tmpDataDir);
    expect(assignments).toEqual([
      { op: 'remove', brand_slug: 'acme', role: 'key' },
      { op: 'remove', brand_slug: 'zenco', role: 'key' },
    ]);
    expect(await keyListInProfile()).toEqual([]);
    expect(stdoutChunks.join('')).toContain('Cleared 2 key brand(s)');
  });
});
