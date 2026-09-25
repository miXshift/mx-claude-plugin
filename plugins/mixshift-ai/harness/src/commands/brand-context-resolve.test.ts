/**
 * `mixshift brand context resolve <slug>` and brand retire (slice 1): Step 0
 * of most skills. A retired brand still resolves (explicit actions proceed),
 * stdout stays BYTE-IDENTICAL to an active brand's, and exactly one stderr
 * line says who retired it, when, and how to undo. Fails open.
 *
 * The autosync module is mocked (no network): maybeAutoSync is a no-op and
 * getCachedOrgManifest serves the contract-shaped wire fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerBrandContextCommands } from './brand-context.js';
import { getCachedOrgManifest, maybeAutoSync } from '../lib/context-sync/autosync.js';
import { __resetRetiredNotices } from '../lib/context-sync/lifecycle.js';
import type { WireManifestBrand } from '../lib/context-sync/types.js';

vi.mock('../lib/context-sync/autosync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/autosync.js')>();
  return {
    ...actual,
    maybeAutoSync: vi.fn(async () => ({ ran: false, reason: 'disabled' })),
    getCachedOrgManifest: vi.fn(async () => ({ ok: false })),
  };
});

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'testdata', 'context-sync', 'brand-lifecycle-wire.json',
    ),
    'utf8',
  ),
) as Record<string, { body: { brands: WireManifestBrand[] } }>;
const RETIRED_MANIFEST = FIXTURE.manifest_all!.body.brands;
const ACTIVE_MANIFEST = RETIRED_MANIFEST.map((b) =>
  b.brand_slug === 'acme-snacks'
    ? {
        ...b,
        lifecycle: {
          state: 'active' as const,
          changed_at: null,
          changed_by: null,
          surface: null,
          reason_code: null,
        },
      }
    : b,
);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'emit machine-readable JSON to stdout', false)
    .option('--data-dir <path>', 'override MIXSHIFT_DATA_DIR');
  registerBrandContextCommands(program.command('brand'));
  return program;
}

let tmpDataDir: string;
let stdoutChunks: string[];
let stderrChunks: string[];

async function resolve(...extra: string[]): Promise<{ stdout: string; stderr: string }> {
  stdoutChunks = [];
  stderrChunks = [];
  await buildProgram().parseAsync([
    'node', 'mixshift', 'brand', 'context', 'resolve', 'acme-snacks', ...extra,
    '--data-dir', tmpDataDir,
  ]);
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRetiredNotices();
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  });
  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-resolve-lifecycle-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDataDir, { recursive: true, force: true });
});

describe('brand context resolve on a retired brand', () => {
  it.each([['--json'], []])(
    'stdout is byte-identical to an active brand (%s); one stderr notice says who, when, undo',
    async (...extra) => {
      const args = extra.filter((a): a is string => typeof a === 'string');
      vi.mocked(getCachedOrgManifest).mockResolvedValue({
        ok: true,
        brands: ACTIVE_MANIFEST,
        fromCache: true,
      });
      const active = await resolve(...args);
      expect(active.stderr).toBe('');

      vi.mocked(getCachedOrgManifest).mockResolvedValue({
        ok: true,
        brands: RETIRED_MANIFEST,
        fromCache: true,
      });
      const retired = await resolve(...args);

      expect(retired.stdout).toBe(active.stdout);
      expect(retired.stdout.length).toBeGreaterThan(0);
      expect(retired.stderr).toBe(
        'acme-snacks was retired for your team by pat@example.com on Sep 24, 2026 via plugin. ' +
          'Continuing, because you asked for it by name. To bring it back for everyone: ' +
          '`mixshift brand restore acme-snacks`.\n',
      );
    },
  );

  it('passes the explicit flag through to autosync, so a missing retired brand is still fetched', async () => {
    await resolve('--json');
    expect(vi.mocked(maybeAutoSync)).toHaveBeenCalledTimes(1);
    const [slug, opts] = vi.mocked(maybeAutoSync).mock.calls[0]!;
    expect(slug).toBe('acme-snacks');
    expect(opts).toMatchObject({ seedRetired: true });
  });

  it('fails open: no manifest, no notice, same stdout', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({ ok: true, brands: ACTIVE_MANIFEST, fromCache: true });
    const active = await resolve('--json');
    vi.mocked(getCachedOrgManifest).mockResolvedValue({ ok: false });
    const unknown = await resolve('--json');
    expect(unknown.stdout).toBe(active.stdout);
    expect(unknown.stderr).toBe('');
  });

  it('an older service (no lifecycle field) prints nothing extra', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({
      ok: true,
      brands: FIXTURE.manifest_old_gateway!.body.brands,
      fromCache: true,
    });
    const r = await resolve('--json');
    expect(r.stderr).toBe('');
  });
});
