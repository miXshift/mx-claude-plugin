/**
 * Command-level tests for `mixshift brand retire|archive|restore` and the
 * retired-brand handling in `mixshift brand list` (brand retire, slice 1).
 *
 * The context-sync client factory is mocked; its answers are the REAL
 * response parser (lifecycleResultFrom) run over the gateway's real response
 * bodies (testdata/context-sync/brand-lifecycle-wire.json, derived from
 * mx-legacy-auth's own fixture test; see its _provenance).
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
import { loadOrgManifestCache } from '../lib/context-sync/state.js';
import { addKeyBrand } from '../lib/clients/key-brands.js';
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
const MANIFEST_RETIRED_COUNT = FIXTURE.manifest_all!.body.retired_count as number;

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
      opts.manifest ?? { ok: true, brands: MANIFEST_BRANDS, retired_count: MANIFEST_RETIRED_COUNT },
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
    expect(out).toContain('Recorded as: am@example.com. Your teammates will see this name.');
    expect(out).toContain('Reason: client left. Note: "moved in-house"');
    // What changed
    expect(out).toContain("no longer shows as an active brand in your team's shared brand context");
    expect(out).toContain('Bulk syncs');
    expect(out).toContain('skip it for teammates on the current MixShift plugin');
    expect(out).toContain('Teammates on an older version keep syncing it as usual until they update.');
    expect(out).not.toContain('for everyone on your team');
    // What did not change
    expect(out).toContain('docs and their revision history are all kept');
    expect(out).toContain('timeline history is kept');
    expect(out).toContain('Amazon accounts, billing, reports and totals are not affected');
    // The churn rule: retire never filters a report, a scheduled task or a total.
    expect(out).toContain('Reports and scheduled tasks still include its data.');
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
      at: FIXTURE.lifecycle_retire_changed!.body.at,
      event_id: FIXTURE.lifecycle_retire_changed!.body.event_id,
      reason_code: null,
      recorded_as: { label: 'am@example.com', source: 'service', service_credential: false },
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
      'acme-snacks was already retired for your team (retired by am@example.com on Sep 25, 2026). Nothing changed.',
    );
    expect(out).toContain('To undo: mixshift brand restore acme-snacks');
    // A repeat recorded nothing for this caller, so it names nobody as
    // "Recorded as" (the earlier retirer is named only as the one who retired it).
    expect(out).not.toContain('Recorded as');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toMatchObject({ outcome: 'unchanged', changed: false });
  });

  it('a repeat in --json has recorded_as null, never the earlier retirer', async () => {
    await writeInteractiveCredentials('lee@example.com');
    const { client } = fakeClient({ post: 'lifecycle_retire_unchanged' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--json', '--data-dir', tmpDataDir);

    const doc = JSON.parse(stdoutText()) as Record<string, unknown>;
    expect(doc).toMatchObject({ state: 'retired', changed: false, recorded_as: null });
    // The team's record (who retired it earlier) is still reported as such.
    expect(doc.lifecycle).toMatchObject({ changed_by: 'am@example.com' });
  });

  it('a teammate change read back instead of this one is never shown as "Recorded as"', async () => {
    // The POST recorded this caller's retire at `at`; by the time the read-back
    // runs, the record shows a different moment and person (a near-simultaneous
    // teammate retire, or any record that is not this change).
    await writeInteractiveCredentials('lee@example.com');
    const { client } = fakeClient({
      post: 'lifecycle_retire_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(MANIFEST_BRANDS, 'acme-snacks', {
          state: 'retired',
          changed_at: '2026-09-25T14:55:19.001000+00:00',
          changed_by: 'kim@example.com',
          surface: 'mcp',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain(
      'Recorded as: lee@example.com (the sign-in this computer used). Your teammates will see this name.',
    );
    expect(out).not.toContain('Recorded as: kim@example.com');
  });

  it('a read-back whose state does not match the change is never shown as "Recorded as"', async () => {
    await writeInteractiveCredentials('lee@example.com');
    const at = FIXTURE.lifecycle_retire_changed!.body.at as string;
    const { client } = fakeClient({
      post: 'lifecycle_retire_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(MANIFEST_BRANDS, 'acme-snacks', {
          state: 'active',
          changed_at: at,
          changed_by: 'kim@example.com',
          surface: 'mcp',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--json', '--data-dir', tmpDataDir);

    const doc = JSON.parse(stdoutText()) as { recorded_as: unknown };
    expect(doc.recorded_as).toEqual({
      label: 'lee@example.com',
      source: 'this_sign_in',
      service_credential: false,
    });
  });

  it('refreshes the local org-manifest cache, so `brand list` shows the change right away', async () => {
    const { client } = fakeClient({ post: 'lifecycle_retire_changed' });
    vi.mocked(createContextSyncClient).mockReturnValue(client);
    expect(await loadOrgManifestCache(tmpDataDir)).toBeNull();

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    const cache = await loadOrgManifestCache(tmpDataDir);
    expect(cache).not.toBeNull();
    expect(cache!.brands).toEqual(MANIFEST_BRANDS);
    expect(Number.isFinite(Date.parse(cache!.fetched_at))).toBe(true);
  });

  it('a 2xx answer without `changed` is a failure, never a claimed success', async () => {
    const posts: SetBrandLifecycleInput[] = [];
    const client: ContextSyncClient = {
      ...fakeClient({ post: 'lifecycle_retire_changed' }).client,
      setBrandLifecycle: async (input) => {
        posts.push(input);
        const { changed: _changed, ...rest } = FIXTURE.lifecycle_retire_changed!.body;
        return lifecycleResultFrom(rest, 200, input.brand_slug);
      },
    };
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'acme-snacks', '--data-dir', tmpDataDir);

    expect(posts).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(stdoutText()).not.toContain('Retired acme-snacks');
    expect(stderrText()).toContain('answered in a shape this plugin does not recognize');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toMatchObject({ outcome: 'failed' });
  });

  it('a service credential is named as one, so nobody is surprised', async () => {
    // The gateway's real pair: a service credential retires bravo-bottles,
    // and the manifest read back records it as the credential's svc: label.
    const after = FIXTURE.manifest_after_svc_retire!.body;
    const { client } = fakeClient({
      post: 'lifecycle_retire_by_service_credential',
      manifest: { ok: true, brands: after.brands!, retired_count: after.retired_count as number },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('retire', 'bravo-bottles', '--reason', 'superseded', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    const out = stdoutText();
    expect(out).toContain('Retired bravo-bottles for your team.');
    expect(out).toContain(
      'Recorded as: svc:nightly-sync. That is a service credential, not a person; your teammates will see this name.',
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
    expect(stderrText()).toContain('`mixshift brand list --all` lists every brand you can access');
    expect(stderrText()).toContain('`mixshift context status` lists the brands set up on this computer');
    expect(stderrText()).not.toContain('lists the brands your team has');
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
    // The gateway's real restore answer is for bravo-bottles (retired by a
    // service credential, restored from a plugin session). The read-back
    // manifest is the real post-svc-retire one with bravo-bottles' lifecycle
    // set the way the gateway projects a restore event (lifecycleFromEvent:
    // state active, changed_at = the event ts, changed_by = the actor,
    // surface from the payload, reason_code null).
    const restored = FIXTURE.lifecycle_restore_changed!.body;
    const { client, posts } = fakeClient({
      post: 'lifecycle_restore_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(FIXTURE.manifest_after_svc_retire!.body.brands!, 'bravo-bottles', {
          state: 'active',
          changed_at: restored.at as string,
          changed_by: 'am@example.com',
          surface: 'plugin',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);

    await runBrand('restore', 'bravo-bottles', '--data-dir', tmpDataDir);

    expect(process.exitCode ?? 0).toBe(0);
    expect(posts).toEqual([{ brand_slug: 'bravo-bottles', action: 'restore' }]);
    const out = stdoutText();
    expect(out).toContain('Restored bravo-bottles for your team.');
    expect(out).toContain('Recorded as: am@example.com.');
    expect(out).toContain('To get a local copy on this computer: mixshift context pull --brand bravo-bottles');
    expect(out).toContain('To undo: mixshift brand retire bravo-bottles');
    expect(out).toContain('bulk syncs on the current MixShift plugin include it again');
    const [input] = vi.mocked(track).mock.calls[0]!;
    expect(input.payload).toEqual({
      brand_slug: 'bravo-bottles',
      action: 'restore',
      reason_code: null,
      outcome: 'changed',
      changed: true,
    });
  });

  it('--json never says the local copy is safe to delete after a restore', async () => {
    const restored = FIXTURE.lifecycle_restore_changed!.body;
    const { client } = fakeClient({
      post: 'lifecycle_restore_changed',
      manifest: {
        ok: true,
        brands: withLifecycle(FIXTURE.manifest_after_svc_retire!.body.brands!, 'bravo-bottles', {
          state: 'active',
          changed_at: restored.at as string,
          changed_by: 'am@example.com',
          surface: 'plugin',
          reason_code: null,
        }),
      },
    });
    vi.mocked(createContextSyncClient).mockReturnValue(client);
    await mkdir(join(tmpDataDir, 'clients', 'bravo-bottles'), { recursive: true });

    await runBrand('restore', 'bravo-bottles', '--json', '--data-dir', tmpDataDir);

    const doc = JSON.parse(stdoutText()) as {
      state: string;
      recorded_as: unknown;
      local_copy: Record<string, unknown>;
      undo: string;
    };
    expect(doc.state).toBe('active');
    expect(doc.local_copy).toEqual({ path: join(tmpDataDir, 'clients', 'bravo-bottles'), exists: true });
    expect(doc.local_copy).not.toHaveProperty('safe_to_delete');
    expect(doc.recorded_as).toEqual({ label: 'am@example.com', source: 'service', service_credential: false });
    expect(doc.undo).toBe('mixshift brand retire bravo-bottles');
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
            slug: 'bravo-bottles',
            display_name: 'Bravo Bottles',
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
    expect(out).toContain('Bravo Bottles');
    expect(out).not.toContain('Acme Snacks');
    expect(out).toContain(
      '1 retired brand hidden: acme-snacks (retired by am@example.com on Sep 25, 2026). ' +
        'Use --all to see them; `mixshift brand restore <slug>` brings one back.',
    );
    // The counts line never passes a hidden retired brand off as just one of
    // your active brands.
    expect(out).toContain(
      'Total: 2 (2 active, 0 dormant, 1 set up, 0 key; 1 of these retired by your team, hidden here).',
    );
  });

  it('--key shows a retired key brand with a [retired] tag and never hides it', async () => {
    expect((await addKeyBrand('acme-snacks', tmpDataDir)).status).toBe('added');
    vi.mocked(getCachedOrgManifest).mockResolvedValue({
      ok: true,
      brands: MANIFEST_BRANDS,
      fromCache: true,
    });

    await runBrand('list', '--key', '--format', 'chat', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain('Acme Snacks [retired]');
    expect(out).not.toContain('retired brand hidden');
    expect(out).toContain('[retired] = a teammate retired this brand for your team.');
    expect(out).toContain('; 1 of these retired by your team).');
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
    expect(out).toContain('Bravo Bottles');
    expect(out).not.toContain('Bravo Bottles [retired]');
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
    expect(doc.brands.map((b) => b.slug)).toEqual(['acme-snacks', 'bravo-bottles']);
    expect(doc.brands[0]).toMatchObject({ retired: true, lifecycle: { changed_by: 'am@example.com' } });
    expect(doc.brands[1]!.retired).toBeUndefined();
  });

  it('fails open: with no manifest available every brand shows exactly as before', async () => {
    vi.mocked(getCachedOrgManifest).mockResolvedValue({ ok: false });

    await runBrand('list', '--format', 'chat', '--data-dir', tmpDataDir);

    const out = stdoutText();
    expect(out).toContain('Acme Snacks');
    expect(out).toContain('Bravo Bottles');
    expect(out).not.toContain('[retired]');
    expect(out).not.toContain('retired brand');
  });
});
