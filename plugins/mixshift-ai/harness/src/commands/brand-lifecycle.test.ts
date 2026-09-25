/**
 * Command-level tests for `mixshift brand retire|archive|restore` and the
 * retired-brand handling in `mixshift brand list` (brand retire, slice 1).
 *
 * The context-sync client factory is mocked; its answers are the REAL
 * response parser (lifecycleResultFrom) run over the contract-shaped wire
 * fixture (testdata/context-sync/brand-lifecycle-wire.json), so a reconcile
 * stage that swaps in the gateway's real bodies exercises the same path.
 * Commander parsing, the action handlers, local file checks and the copy run
 * for real against a temp data dir. track() is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';

import { registerBrandCommands } from './brand.js';
import {
  createContextSyncClient,
  lifecycleResultFrom,
  type ContextSyncClient,
  type WireEnvelope,
} from '../lib/context-sync/client.js';
import { getCachedOrgManifest } from '../lib/context-sync/autosync.js';
import { track, EventName } from '../lib/telemetry/index.js';
import type {
  FetchManifestResult,
  SetBrandLifecycleInput,
  WireManifestBrand,
} from '../lib/context-sync/types.js';

vi.mock('../lib/context-sync/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/client.js')>();
  return { ...actual, createContextSyncClient: vi.fn() };
});

vi.mock('../lib/context-sync/autosync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/autosync.js')>();
  return { ...actual, getCachedOrgManifest: vi.fn(async () => ({ ok: false })) };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

const FIXTURE = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'testdata', 'context-sync', 'brand-lifecycle-wire.json',
    ),
    'utf8',
  ),
) as Record<string, { status: number; body: WireEnvelope & { brands?: WireManifestBrand[] } }>;

const MANIFEST_BRANDS = FIXTURE.manifest_all!.body.brands!;

function withLifecycle(
  brands: WireManifestBrand[],
  slug: string,
  lifecycle: WireManifestBrand['lifecycle'],
): WireManifestBrand[] {
  return brands.map((b) => (b.brand_slug === slug ? { ...b, lifecycle } : b));
}

interface FakeOptions {
  /** Fixture key answering the POST. */
  post: string;
  /** Manifest the post-change read-back sees (default: the fixture's). */
  manifest?: FetchManifestResult;
}

function fakeClient(opts: FakeOptions): { client: ContextSyncClient; posts: SetBrandLifecycleInput[] } {
  const posts: SetBrandLifecycleInput[] = [];
  const client: ContextSyncClient = {
    fetchManifest: async () =>
      opts.manifest ?? { ok: true, brands: MANIFEST_BRANDS, retired_count: 1 },
    fetchDoc: async () => ({ ok: false, kind: 'not_found', message: 'nf', friendly: 'nf' }),
    putDoc: async () => ({ ok: true, status: 'created', revision: 1 }),
    putAssignment: async () => ({ ok: true }),
    setBrandLifecycle: async (input) => {
      posts.push(input);
      const f = FIXTURE[opts.post]!;
      return lifecycleResultFrom(f.body, f.status, input.brand_slug);
    },
  };
  return { client, posts };
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
const stdoutText = (): string => stdoutChunks.join('');
const stderrText = (): string => stderrChunks.join('');

async function writeInteractiveCredentials(personLabel: string): Promise<void> {
  await mkdir(join(tmpDataDir, 'auth'), { recursive: true });
  await writeFile(
    join(tmpDataDir, 'auth', 'credentials'),
    JSON.stringify({
      schema_version: 2,
      created_at: '2026-07-01T00:00:00.000Z',
      datahub: {
        api_base: 'https://mcp.example.test',
        access_token: 'test-token',
        refresh_token: 'refresh-token',
        expires_at: '2099-01-01T00:00:00.000Z',
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        user_id: 'u1',
        email: 'ops@example.com',
        person_label: personLabel,
        device_label: 'test-device',
        client_id: 'mx-claude-plugin',
      },
    }),
    'utf8',
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
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
  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-brand-lifecycle-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// retire
// ---------------------------------------------------------------------------

describe('brand retire', () => {
  it('records the change and answers what changed, what did not, who, local copy, undo', async () => {
    const { client, posts } = fakeClient({ post: 'lifecycle_retire_changed' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);
    await mkdir(join(tmpDataDir, 'clients', 'acme-snacks'), { recursive: true });

    await runBrand(
      'retire', 'acme-snacks',
      '--reason', 'client_left',
      '--note', 'moved in-house',
      '--data-dir', tmpDataDir,
    );

    expect(process.exitCode ?? 0).toBe(0);
    expect(posts).toEqual([
      { brand_slug: 'acme-snacks', action: 'retire', reason_code: 'client_left', note: 'moved in-house' },
    ]);
    const out = stdoutText();
    expect(out).toContain('Retired acme-snacks for your team.');
    expect(out).toContain('Recorded as: pat@example.com. Your teammates will see this name.');
    expect(out).toContain('Reason: client left. Note: "moved in-house"');
    // What changed
    expect(out).toContain("no longer shows as an active brand in your team's shared brand context");
    expect(out).toContain('Bulk syncs');
    // What did not change
    expect(out).toContain('docs and their revision history are all kept');
    expect(out).toContain('timeline history is kept');
    expect(out).toContain('Amazon accounts, billing, reports and totals are not affected');
    expect(out).toContain('Run files (sidecars) stay on this computer only. They were never sent to MixShift.');
    // Local copy
    expect(out).toContain(`safe to delete ${join(tmpDataDir, 'clients', 'acme-snacks')}`);
    expect(out).toContain('Syncs will not bring a retired brand back');
    expect(out).toContain('MixShift never deletes it for you');
    // Undo
    expect(out).toContain('To undo: mixshift brand restore acme-snacks');
    // House copy rules.
    expect(out).not.toContain('—');
    expect(out).not.toMatch(/cold start/i);
    expect(stderrText()).toBe('');

    expect(track).toHaveBeenCalledTimes(1);
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.event_name).toBe(EventName.BrandLifecycleChanged);
    expect(input.event_name).toBe('brand.lifecycle_changed');
    expect(input.outcome).toBe('ok');
    expect(input.payload).toEqual({
      brand_slug: 'acme-snacks',
      action: 'retire',
      reason_code: 'client_left',
      outcome: 'changed',
      changed: true,
    });
  });

  it('`brand archive` is an alias of retire (it was advertised and users typed it)', async () => {
    const { client, posts } = fakeClient({ post: 'lifecycle_retire_changed' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('archive', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    expect(posts).toEqual([{ brand_slug: 'acme-snacks', action: 'retire' }]);
    expect(stdoutText()).toContain('Retired acme-snacks for your team.');
    expect(stdoutText()).toContain('This computer has no local copy of this brand.');
  });

  it('--json returns one document with state, changed, who, local copy and undo', async () => {
    const { client } = fakeClient({ post: 'lifecycle_retire_changed' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--json', '--data-dir', tmpDataDir);

    const doc = JSON.parse(stdoutText()) as Record<string, unknown>;
    expect(doc).toEqual({
      status: 'ok',
      brand_slug: 'acme-snacks',
      action: 'retire',
      state: 'retired',
      changed: true,
      at: '2026-09-24T15:30:00.000Z',
      event_id: 'evt_000000000001',
      reason_code: null,
      recorded_as: { label: 'pat@example.com', source: 'service', service_credential: false },
      lifecycle: MANIFEST_BRANDS.find((b) => b.brand_slug === 'acme-snacks')!.lifecycle,
      local_copy: {
        path: join(tmpDataDir, 'clients', 'acme-snacks'),
        exists: false,
        safe_to_delete: true,
      },
      undo: 'mixshift brand restore acme-snacks',
    });
  });

  it('a repeat says it was already retired, by whom, and changes nothing', async () => {
    const { client } = fakeClient({ post: 'lifecycle_retire_unchanged' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const out = stdoutText();
    expect(out).toContain(
      'acme-snacks was already retired for your team (retired by pat@example.com on Sep 24, 2026). Nothing changed.',
    );
    expect(out).toContain('To undo: mixshift brand restore acme-snacks');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toMatchObject({ outcome: 'unchanged', changed: false });
  });

  it('a service credential is named as one, so nobody is surprised', async () => {
    const { client } = fakeClient({
      post: 'lifecycle_retire_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(MANIFEST_BRANDS, 'acme-snacks', {
          state: 'retired',
          changed_at: '2026-09-24T15:30:00.000Z',
          changed_by: 'svc:nightly-report',
          surface: 'api',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(stdoutText()).toContain(
      'Recorded as: svc:nightly-report. That is a service credential, not a person; your teammates will see this name.',
    );
  });

  it('falls back to the sign-in this computer used when the read-back fails', async () => {
    await writeInteractiveCredentials('lee@example.com');
    const { client } = fakeClient({
      post: 'lifecycle_retire_changed',
      manifest: { ok: false, kind: 'host_unreachable', message: 'x', friendly: 'x' },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    expect(stdoutText()).toContain(
      'Recorded as: lee@example.com (the sign-in this computer used). Your teammates will see this name.',
    );
  });

  it('unknown brand: plain error, exit 1', async () => {
    const { client } = fakeClient({ post: 'lifecycle_unknown_brand' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'no-such-brand', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('Your team has no shared brand context for "no-such-brand"');
    expect(stdoutText()).toBe('');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.outcome).toBe('failed');
    expect(input.payload).toMatchObject({ outcome: 'unknown_brand' });
  });

  it.each([
    ['retire', 'lifecycle_old_gateway_404', 'Retiring a brand is not available on this MixShift service yet. Nothing was changed.'],
    ['retire', 'lifecycle_old_gateway_405', 'Retiring a brand is not available on this MixShift service yet. Nothing was changed.'],
    ['restore', 'lifecycle_old_gateway_404', 'Restoring a brand is not available on this MixShift service yet. Nothing was changed.'],
  ])('older service: %s over %s says it is not available yet', async (verb, key, message) => {
    const { client } = fakeClient({ post: key });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand(verb, 'acme-snacks', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain(message);
    expect(stderrText()).not.toMatch(/no shared brand context/);
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toMatchObject({ outcome: 'unsupported' });
  });

  it('--json failure is a single error document', async () => {
    const { client } = fakeClient({ post: 'lifecycle_old_gateway_404' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--json', '--data-dir', tmpDataDir);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdoutText())).toEqual({
      status: 'error',
      kind: 'unsupported',
      message:
        'Retiring a brand is not available on this MixShift service yet. Nothing was changed. ' +
        'Try again after the service is updated.',
    });
  });

  it('rejects a bad --reason, an over-long --note and an unsafe slug before any network call', async () => {
    const { client, posts } = fakeClient({ post: 'lifecycle_retire_changed' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--reason', 'bored', '--data-dir', tmpDataDir);
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--reason must be one of: client_left, duplicate, superseded, other');

    process.exitCode = undefined;
    await runBrand('retire', 'acme-snacks', '--note', 'x'.repeat(281), '--data-dir', tmpDataDir);
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('the limit is 280');

    process.exitCode = undefined;
    await runBrand('retire', '../etc', '--data-dir', tmpDataDir);
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('is not a brand slug');

    expect(posts).toEqual([]);
    expect(createContextSyncClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('brand restore', () => {
  it('brings the brand back for the team and names the undo', async () => {
    const { client, posts } = fakeClient({
      post: 'lifecycle_restore_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(MANIFEST_BRANDS, 'acme-snacks', {
          state: 'active',
          changed_at: '2026-09-25T09:00:00.000Z',
          changed_by: 'lee@example.com',
          surface: 'plugin',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('restore', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    expect(posts).toEqual([{ brand_slug: 'acme-snacks', action: 'restore' }]);
    const out = stdoutText();
    expect(out).toContain('Restored acme-snacks for your team.');
    expect(out).toContain('Recorded as: lee@example.com.');
    expect(out).toContain('bulk syncs include it again');
    expect(out).toContain('To get a local copy on this computer: mixshift context pull --brand acme-snacks');
    expect(out).toContain('To undo: mixshift brand retire acme-snacks');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toEqual({
      brand_slug: 'acme-snacks',
      action: 'restore',
      reason_code: null,
      outcome: 'changed',
      changed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// brand list
// ---------------------------------------------------------------------------

describe('brand list with retired brands', () => {
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
    const clientsDir = join(tmpDataDir, 'clients');
    await mkdir(clientsDir, { recursive: true });
    await writeFile(
      join(clientsDir, 'index.yaml'),
      stringifyYaml({
        schema_version: 1,
        discovered_at: new Date().toISOString(),
        brands: [
          {
            slug: 'acme-snacks',
            display_name: 'Acme Snacks',
            ads_active: true,
            retail_active: true,
            is_dormant: false,
            cold_started: true,
            cold_started_at: null,
            accounts: [account(101)],
          },
          {
            slug: 'summit-trail',
            display_name: 'Summit Trail',
            ads_active: true,
            retail_active: true,
            is_dormant: false,
            cold_started: false,
            cold_started_at: null,
            accounts: [account(102)],
          },
        ],
      }),
      'utf8',
    );
  });

  it('default view hides a retired brand and says who retired it', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({
      ok: true,
      brands: MANIFEST_BRANDS,
      fromCache: true,
    });

    await runBrand('list', '--format', 'chat', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain('Summit Trail');
    expect(out).not.toContain('Acme Snacks');
    expect(out).toContain(
      '1 retired brand hidden: acme-snacks (retired by pat@example.com on Sep 24, 2026). ' +
        'Use --all to see them; `mixshift brand restore <slug>` brings one back.',
    );
  });

  it('--all shows it with a [retired] tag', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({
      ok: true,
      brands: MANIFEST_BRANDS,
      fromCache: true,
    });

    await runBrand('list', '--all', '--format', 'chat', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain('Acme Snacks [retired]');
    expect(out).toContain('Summit Trail');
    expect(out).not.toContain('Summit Trail [retired]');
    expect(out).toContain('[retired] = a teammate retired this brand for your team.');
  });

  it('--json never hides a retired brand (reports and totals are never filtered), it tags it', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({
      ok: true,
      brands: MANIFEST_BRANDS,
      fromCache: true,
    });

    await runBrand('list', '--json', '--data-dir', tmpDataDir);

    const doc = JSON.parse(stdoutText()) as {
      retired_count: number;
      brands: Array<{ slug: string; retired?: boolean; lifecycle?: { changed_by: string } }>;
    };
    expect(doc.retired_count).toBe(1);
    expect(doc.brands.map((b) => b.slug)).toEqual(['acme-snacks', 'summit-trail']);
    expect(doc.brands[0]).toMatchObject({ retired: true, lifecycle: { changed_by: 'pat@example.com' } });
    expect(doc.brands[1]!.retired).toBeUndefined();
  });

  it('fails open: with no manifest available every brand shows exactly as before', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({ ok: false });

    await runBrand('list', '--format', 'chat', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain('Acme Snacks');
    expect(out).toContain('Summit Trail');
    expect(out).not.toContain('[retired]');
    expect(out).not.toContain('retired brand');
  });
});
