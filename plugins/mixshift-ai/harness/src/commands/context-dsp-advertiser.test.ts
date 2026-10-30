/**
 * `mixshift context dsp-advertiser show|assign` (mx-ops#205).
 *
 * The gateway client is mocked (no network, no credentials); commander, the
 * command handlers, the YAML edit, and the real engine/local/state modules run
 * for real against a temp data dir. All ids and brands are fake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerContextCommands } from './context.js';
import { createContextSyncClient, dspLookupResultFrom } from '../lib/context-sync/client.js';
import type { ContextSyncClient } from '../lib/context-sync/client.js';
import {
  gatewayParseDspAdvertiserIds,
  planDspAssignment,
  planDspUnassignment,
} from '../lib/context-sync/dsp-advertiser.js';
import { track } from '../lib/telemetry/index.js';
import type { DspAdvertiserLookupResult, WireManifestDoc } from '../lib/context-sync/types.js';
import { hashContent } from '../lib/context-sync/local.js';
import { emptyState, saveState } from '../lib/context-sync/state.js';
import { loadCredentials } from '../lib/auth/credentials.js';

vi.mock('../lib/context-sync/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/client.js')>();
  return { ...actual, createContextSyncClient: vi.fn() };
});
vi.mock('../lib/auth/credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/auth/credentials.js')>();
  return { ...actual, loadCredentials: vi.fn(actual.loadCredentials) };
});
vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

const ID = '123456789012345678';
const ID2 = '223456789012345678';

function contextYaml(accountsYaml: string): string {
  return [
    'schema_version: 1',
    'brand_slug: acme-goods',
    'brand_name: Acme Goods',
    'last_updated: "2026-10-01"',
    '# accounts below',
    'accounts:',
    accountsYaml,
    'sources:',
    '  ad_metrics: campaignmetric',
    '  ops_revenue: ops',
    '  ops_revenue_field: rev',
    '  ops_units_field: units',
    '  ops_date_field: d',
    'management:',
    '  primary_metric: ACOS',
    '  acos_target_pct: 30',
    '  attribution_window_days: 14',
    '',
  ].join('\n');
}

const ACCOUNT_A = [
  '  - seller_id: 111 # main account',
  '    seller_name: Acme Goods US',
  '    account_type: SC',
  '    status: active',
  '    role: primary',
].join('\n');
const ACCOUNT_C = [
  '  - seller_id: 333',
  '    seller_name: Acme Goods MX',
  '    account_type: SC',
  '    status: active',
  '    role: secondary',
].join('\n');
const ACCOUNT_B = [
  '  - seller_id: 222',
  '    seller_name: Acme Goods CA',
  '    account_type: SC',
  '    status: active',
  '    role: secondary',
].join('\n');

interface Harness {
  lookups: Array<DspAdvertiserLookupResult>;
  lookupCalls: string[];
  putDoc: ReturnType<typeof vi.fn>;
  /** The shared copy of context.yaml (undefined = never published). */
  serverContent: string | undefined;
  extraDocs: WireManifestDoc[];
}

let tmpDataDir: string;
let stdout: string[];
let stderr: string[];
let exitCodeBefore: typeof process.exitCode;
let h: Harness;

function installClient(opts: { putStatus?: 'ok' | 'conflict' } = {}): void {
  h.putDoc = vi.fn(async (input: { doc_type: string; content: string }) => {
    if (opts.putStatus === 'conflict') {
      return {
        ok: false as const,
        kind: 'revision_conflict' as const,
        message: 'conflict',
        friendly: 'The shared copy moved.',
      };
    }
    if (input.doc_type === 'context') h.serverContent = input.content;
    return { ok: true as const, status: 'updated' as const, revision: 2 };
  });
  const client: ContextSyncClient = {
    fetchManifest: async () => ({
      ok: true,
      brands: [
        {
          brand_slug: 'acme-goods',
          docs: [
            ...(h.serverContent !== undefined
              ? [
                  {
                    doc_type: 'context' as const,
                    revision: 1,
                    content_hash: hashContent(h.serverContent),
                    sensitivity: 'internal',
                    updated_at: '2026-10-01T00:00:00Z',
                    updated_by_actor: 'someone',
                  },
                ]
              : []),
            ...h.extraDocs,
          ],
        },
      ],
    }),
    fetchDoc: async () => ({ ok: false, kind: 'not_found', message: 'nf', friendly: 'nf' }),
    putDoc: h.putDoc as unknown as ContextSyncClient['putDoc'],
    putAssignment: async () => ({ ok: true }),
    lookupDspAdvertiser: async (id: string) => {
      h.lookupCalls.push(id);
      const next = h.lookups.length > 1 ? h.lookups.shift() : h.lookups[0];
      return next as DspAdvertiserLookupResult;
    },
  };
  vi.mocked(createContextSyncClient).mockReturnValue(client);
}

const found = (...brands: string[]): DspAdvertiserLookupResult => ({
  ok: true,
  advertiser_id: ID,
  brands,
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program
    .option('--json', 'json', false)
    .option('--data-dir <path>', 'data dir');
  registerContextCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'mixshift', '--data-dir', tmpDataDir, ...args]);
}
const assign = (...a: string[]) => run('--json', 'context', 'dsp-advertiser', 'assign', ...a);

const lastJson = (): Record<string, any> => {
  const lines = stdout.join('').trim().split('\n');
  return JSON.parse(lines[lines.length - 1] as string);
};
const contextFile = () => join(tmpDataDir, 'clients', 'acme-goods', 'context.yaml');
const readCtx = () => readFile(contextFile(), 'utf8');

/** Write the local context.yaml; by default the shared copy is identical (in sync). */
async function seed(accountsYaml: string, published = true): Promise<string> {
  const text = contextYaml(accountsYaml);
  await mkdir(join(tmpDataDir, 'clients', 'acme-goods'), { recursive: true });
  await writeFile(contextFile(), text, 'utf8');
  if (published) h.serverContent = text;
  return text;
}
const unassign = (...a: string[]) => run('--json', 'context', 'dsp-advertiser', 'unassign', ...a);

beforeEach(async () => {
  vi.clearAllMocks();
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown): boolean => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown): boolean => {
    stderr.push(String(c));
    return true;
  });
  vi.mocked(loadCredentials).mockReset();
  vi.mocked(loadCredentials).mockImplementation(
    (await vi.importActual<typeof import('../lib/auth/credentials.js')>('../lib/auth/credentials.js')).loadCredentials,
  );
  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-dsp-adv-'));
  h = { lookups: [found()], lookupCalls: [], putDoc: vi.fn(), serverContent: undefined, extraDocs: [] };
  installClient();
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(tmpDataDir, { recursive: true, force: true });
});

describe('show', () => {
  it('reports unassigned with exit 0', async () => {
    h.lookups = [found()];
    await run('--json', 'context', 'dsp-advertiser', 'show', ID);
    expect(lastJson()).toEqual({ status: 'ok', advertiser_id: ID, state: 'unassigned', brand: null, brands: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports the one brand', async () => {
    h.lookups = [found('acme-goods')];
    await run('--json', 'context', 'dsp-advertiser', 'show', ID);
    expect(lastJson()).toMatchObject({ state: 'assigned', brand: 'acme-goods', brands: ['acme-goods'] });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a conflict naming every brand, exit 0', async () => {
    h.lookups = [found('acme-goods', 'other-brand')];
    await run('context', 'dsp-advertiser', 'show', ID);
    const out = stdout.join('');
    expect(out).toContain('conflict');
    expect(out).toContain('acme-goods');
    expect(out).toContain('other-brand');
    expect(process.exitCode).toBeUndefined();
  });

  it('turns a 404 into a clear unsupported error with a non-zero exit', async () => {
    h.lookups = [dspLookupResultFrom({}, 404, ID)];
    await run('context', 'dsp-advertiser', 'show', ID);
    expect(stderr.join('')).toContain('does not support the DSP advertiser lookup yet');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a bad id before any lookup', async () => {
    await run('context', 'dsp-advertiser', 'show', '12ab');
    expect(h.lookupCalls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('never puts the advertiser id or a brand in the telemetry payload', async () => {
    h.lookups = [found('acme-goods')];
    await run('context', 'dsp-advertiser', 'show', ID);
    const calls = vi.mocked(track).mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c).not.toContain(ID);
      expect(c).not.toContain('acme-goods');
    }
  });
});

describe('assign', () => {
  it('dry run prints the exact line and writes nothing', async () => {
    const before = await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'ok', result: 'dry_run', brand: 'acme-goods', edit: 'added' });
    expect(out.added_lines).toEqual([`    dsp_advertiser_id: "${ID}"`]);
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('commit writes a double-quoted id, pushes, and reads back', async () => {
    await seed(ACCOUNT_A);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text).toContain(`dsp_advertiser_id: "${ID}"`);
    expect(h.putDoc).toHaveBeenCalledTimes(1);
    expect(h.lookupCalls).toHaveLength(2);
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed', pushed: true, verified: true });
    expect(process.exitCode).toBeUndefined();
  });

  it('commit reports an unverified read-back when it still does not resolve here', async () => {
    await seed(ACCOUNT_A);
    h.lookups = [found(), found()];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ result: 'committed', verified: false });
    expect(process.exitCode).toBe(1);
  });

  it('says so and does not claim success when the push conflicts', async () => {
    installClient({ putStatus: 'conflict' });
    await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'error', kind: 'push_failed' });
    expect(process.exitCode).toBe(1);
    expect(h.lookupCalls).toHaveLength(1); // no read-back claimed
  });

  it('refuses when a different brand declares the advertiser', async () => {
    const before = await seed(ACCOUNT_A);
    h.lookups = [found('other-brand')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'refused', reason: 'declared_by_other_brand' });
    expect(out.message).toContain('other-brand');
    expect(out.message).toContain('user must decide');
    expect(process.exitCode).toBe(1);
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('refuses when the target and another brand both declare it', async () => {
    await seed(ACCOUNT_A);
    h.lookups = [found('acme-goods', 'other-brand')];
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ reason: 'declared_by_other_brand' });
    expect(process.exitCode).toBe(1);
  });

  it('is a no-op with exit 0 when only the target brand declares it', async () => {
    const before = await seed(ACCOUNT_A);
    h.lookups = [found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'already_assigned' });
    expect(process.exitCode).toBeUndefined();
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it.each([
    ['a 404', dspLookupResultFrom({}, 404, ID)],
    ['a 5xx', dspLookupResultFrom({ message: 'boom' }, 503, ID)],
    [
      'a network failure',
      { ok: false, kind: 'host_unreachable', message: 'x', friendly: 'unreachable' } as DspAdvertiserLookupResult,
    ],
  ])('refuses when the lookup is unavailable (%s)', async (_n, result) => {
    const before = await seed(ACCOUNT_A);
    h.lookups = [result];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'lookup_unavailable' });
    expect(process.exitCode).toBe(1);
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('uses the first account when none is the single primary (no second question)', async () => {
    await seed(`${ACCOUNT_B}\n${ACCOUNT_C}`);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'ok', result: 'committed' });
    expect(out.account.seller_id).toBe(222);
    const text = await readCtx();
    expect(text.slice(text.indexOf('seller_id: 222'), text.indexOf('seller_id: 333'))).toContain(`dsp_advertiser_id: "${ID}"`);
  });

  it('defaults to the single primary account without a question', async () => {
    await seed(`${ACCOUNT_B}\n${ACCOUNT_A}`);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text.slice(0, text.indexOf('seller_id: 111'))).not.toContain('dsp_advertiser_id');
    expect(text.slice(text.indexOf('seller_id: 111'))).toContain(`dsp_advertiser_id: "${ID}"`);
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed' });
  });

  it('uses the account named by --account', async () => {
    await seed(`${ACCOUNT_A}\n${ACCOUNT_B}`);
    await assign(ID, '--brand', 'acme-goods', '--account', '222', '--commit');
    const text = await readCtx();
    const second = text.slice(text.indexOf('seller_id: 222'));
    expect(second).toContain(`dsp_advertiser_id: "${ID}"`);
    expect(text.slice(0, text.indexOf('seller_id: 222'))).not.toContain('dsp_advertiser_id');
  });

  it('refuses an unknown --account', async () => {
    await seed(`${ACCOUNT_A}\n${ACCOUNT_B}`);
    await assign(ID, '--brand', 'acme-goods', '--account', '999');
    expect(lastJson()).toMatchObject({ reason: 'account_not_found' });
    expect(process.exitCode).toBe(1);
  });

  it('refuses a brand that has no accounts', async () => {
    await seed('  []');
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ reason: 'no_accounts' });
    expect(process.exitCode).toBe(1);
  });

  it('refuses a bad id and a brand that does not exist', async () => {
    await assign('12x', '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ reason: 'invalid_id' });
    expect(h.lookupCalls).toEqual([]);
    stdout = [];
    process.exitCode = undefined;
    await assign(ID, '--brand', 'no-such-brand');
    expect(process.exitCode).toBe(1);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('converts an existing different single id into a quoted list holding both', async () => {
    await seed(`${ACCOUNT_A}\n    dsp_advertiser_id: "${ID2}"`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text).toContain(`dsp_advertiser_ids: ["${ID2}", "${ID}"]`);
    expect(text).not.toMatch(/dsp_advertiser_id:/);
  });

  it('appends to an existing list (block form kept)', async () => {
    await seed(`${ACCOUNT_A}\n    dsp_advertiser_ids:\n      - "${ID2}"`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text).toContain(`- "${ID2}"`);
    expect(text).toContain(`- "${ID}"`);
  });

  it('preserves comments and other formatting', async () => {
    await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text).toContain('# accounts below');
    expect(text).toContain('seller_id: 111 # main account');
    expect(text).toContain('  ad_metrics: campaignmetric');
  });

  it('publishes only context.yaml: a conflict on an unrelated doc does not fail assign', async () => {
    await seed(ACCOUNT_A);
    await writeFile(join(tmpDataDir, 'clients', 'acme-goods', 'narrative.md'), 'local prose', 'utf8');
    h.extraDocs = [
      {
        doc_type: 'narrative',
        revision: 4,
        content_hash: hashContent('different server prose'),
        sensitivity: 'internal',
        updated_at: '2026-10-01T00:00:00Z',
        updated_by_actor: 'someone',
      },
    ];
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed', verified: true });
    expect(process.exitCode).toBeUndefined();
    const docTypes = h.putDoc.mock.calls.map((c) => (c[0] as { doc_type: string }).doc_type);
    expect(docTypes).toEqual(['context']);
  });

  it('refuses when context.yaml already has unpublished local changes', async () => {
    const published = await seed(ACCOUNT_A);
    const edited = `${published}# my own unpublished note\n`;
    await writeFile(contextFile(), edited, 'utf8');
    const state = emptyState(null);
    state.docs.context = {
      server_revision: 1,
      last_synced_hash: hashContent(published),
      last_synced_at: '2026-10-01T00:00:00Z',
    };
    await saveState('acme-goods', state, tmpDataDir);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'refused', reason: 'context_has_unpublished_changes' });
    expect(out.message).toContain('review');
    expect(await readCtx()).toBe(edited);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('refuses a context.yaml that was never published', async () => {
    await seed(ACCOUNT_A, false);
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ reason: 'context_has_unpublished_changes' });
  });

  it('dry run says it pulled server updates and wrote nothing else', async () => {
    await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson().message).toContain('wrote nothing else');
  });

  it('refuses flow-style accounts up front', async () => {
    const flowItem = '  - {seller_id: 111, seller_name: Acme, account_type: SC, status: active, role: primary}';
    const before = await seed(flowItem);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'flow_style_account' });
    expect(await readCtx()).toBe(before);
    stdout = [];
    process.exitCode = undefined;
    await seed('  [{seller_id: 111, seller_name: Acme, account_type: SC, status: active, role: primary}]');
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ reason: 'flow_style_account' });
  });

  it('does not silently switch on ids from a multi-line flow list', async () => {
    const before = await seed(`${ACCOUNT_A}\n    dsp_advertiser_ids: [\n      "${ID2}",\n    ]`);
    // The service ignores that multi-line list, so it declares nothing today.
    expect(gatewayParseDspAdvertiserIds(before)).toEqual([]);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'result_not_recognized' });
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('refuses a single value under dsp_advertiser_ids instead of dropping it', async () => {
    const before = await seed(`${ACCOUNT_A}\n    dsp_advertiser_ids: "${ID2}"`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'existing_value_invalid' });
    expect(await readCtx()).toBe(before);
  });

  it.each([
    ['null', '    dsp_advertiser_id: null', 'dsp_advertiser_id'],
    ['tilde', '    dsp_advertiser_id: ~', 'dsp_advertiser_id'],
    ['empty value', '    dsp_advertiser_id:', 'dsp_advertiser_id'],
    ['empty list key', '    dsp_advertiser_ids:', 'dsp_advertiser_id'],
    ['empty flow list', '    dsp_advertiser_ids: []', 'dsp_advertiser_id'],
  ])('treats %s as not declared and replaces it', async (_n, line, _k) => {
    await seed(`${ACCOUNT_A}\n${line}`);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed' });
    const text = await readCtx();
    expect(gatewayParseDspAdvertiserIds(text)).toEqual([ID]);
    expect(text).not.toMatch(/dsp_advertiser_ids?:\s*(null|~)?\s*$/m);
  });

  it('puts the original file back when the push fails, and says to re-run', async () => {
    installClient({ putStatus: 'conflict' });
    const before = await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'error', kind: 'push_failed', rolled_back: true });
    expect(out.message).toContain('Run the command again');
    expect(out.message).not.toContain('not shared yet');
    expect(await readCtx()).toBe(before);
  });

  it('says plainly when our push created a conflict (another brand claimed it)', async () => {
    await seed(ACCOUNT_A);
    h.lookups = [found(), found('acme-goods', 'other-brand')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'error', verified: false });
    expect(out.message).toContain('no brand');
    expect(out.message).toContain('unassign');
    expect(process.exitCode).toBe(1);
  });

  const SERVICE = { service: { client_id: 'svc', api_base: 'https://api.example.test' } };
  const HUMAN = { datahub: { user_id: 'u1', email: 'a@example.test', api_base: 'https://api.example.test' } };

  it('refuses --commit with a service-only credential, but a dry run still runs', async () => {
    const before = await seed(ACCOUNT_A);
    vi.mocked(loadCredentials).mockResolvedValue({ credentials: SERVICE, path: 'x' } as never);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'unattended_credential' });
    expect(h.lookupCalls).toEqual([]);
    expect(await readCtx()).toBe(before);
    stdout = [];
    process.exitCode = undefined;
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ reason: 'unattended_credential' });
    stdout = [];
    process.exitCode = undefined;
    await assign(ID, '--brand', 'acme-goods');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'dry_run' });
    expect(await readCtx()).toBe(before);
  });

  it('lets a session that holds a human sign-in and a service credential commit', async () => {
    await seed(ACCOUNT_A);
    vi.mocked(loadCredentials).mockResolvedValue({ credentials: { ...HUMAN, ...SERVICE }, path: 'x' } as never);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed', verified: true });
  });

  it('echoes the lines and a plan hash on dry run and commit, and honors --expect', async () => {
    await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods');
    const dry = lastJson();
    expect(dry.plan_hash).toMatch(/^[0-9a-f]{12}$/);
    stdout = [];
    await assign(ID, '--brand', 'acme-goods', '--commit', '--expect', '000000000000');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'plan_changed' });
    expect(h.putDoc).not.toHaveBeenCalled();
    stdout = [];
    process.exitCode = undefined;
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit', '--expect', dry.plan_hash);
    const done = lastJson();
    expect(done).toMatchObject({ status: 'ok', result: 'committed', plan_hash: dry.plan_hash });
    expect(done.added_lines).toEqual(dry.added_lines);
  });

  it('refuses when an existing advertiser value is unquoted (declares nothing)', async () => {
    const before = await seed(`${ACCOUNT_A}\n    dsp_advertiser_id: 5`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ reason: 'existing_value_invalid' });
    expect(await readCtx()).toBe(before);
  });
});

describe('planDspAssignment', () => {
  it('writes the id as a string that survives a re-parse', () => {
    const plan = planDspAssignment(contextYaml(ACCOUNT_A), ID);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.content).toContain(`dsp_advertiser_id: "${ID}"`);
  });

  it('reports already_in_file without changing the text', () => {
    const text = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_id: "${ID}"`);
    const plan = planDspAssignment(text, ID);
    expect(plan).toMatchObject({ ok: true, changed: false, edit: 'already_in_file' });
  });

  it('refuses text that is not valid YAML', () => {
    expect(planDspAssignment('a: [', ID)).toMatchObject({ ok: false, reason: 'unreadable_yaml' });
  });
});

describe('dspLookupResultFrom', () => {
  it('maps the documented shape; an empty brands list is no brand, a missing entry is unknown', () => {
    expect(
      dspLookupResultFrom({ ok: true, advertisers: [{ advertiser_id: ID, brands: ['b', 'a'] }] }, 200, ID),
    ).toEqual({ ok: true, advertiser_id: ID, brands: ['a', 'b'] });
    expect(dspLookupResultFrom({ ok: true, advertisers: [{ advertiser_id: ID, brands: [] }] }, 200, ID)).toMatchObject({ ok: true, brands: [] });
    // An answer with no entry for the id is off-contract: unknown, never "no brand".
    expect(dspLookupResultFrom({ ok: true, advertisers: [] }, 200, ID)).toMatchObject({ ok: false });
  });

  it('never reads an unrecognized 200 as "no brand"', () => {
    expect(dspLookupResultFrom({ ok: true }, 200, ID)).toMatchObject({ ok: false });
    expect(dspLookupResultFrom({ ok: true, advertisers: [{ advertiser_id: ID, brands: 'x' }] }, 200, ID)).toMatchObject({
      ok: false,
    });
  });
});


describe('unassign', () => {
  const SINGLE = () => `${ACCOUNT_A}\n    dsp_advertiser_id: "${ID}"`;

  it('dry run shows the removed line and writes nothing', async () => {
    const before = await seed(SINGLE());
    h.lookups = [found('acme-goods')];
    await unassign(ID, '--brand', 'acme-goods');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'ok', result: 'dry_run', op: 'unassign', edit: 'removed' });
    expect(out.removed_lines).toEqual([`    dsp_advertiser_id: "${ID}"`]);
    expect(await readCtx()).toBe(before);
    expect(h.putDoc).not.toHaveBeenCalled();
  });

  it('commit removes a scalar declaration, publishes only context, and reads back', async () => {
    await seed(SINGLE());
    h.lookups = [found('acme-goods'), found()];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed', verified: true });
    expect(gatewayParseDspAdvertiserIds(await readCtx())).toEqual([]);
    expect(h.putDoc.mock.calls.map((c) => (c[0] as { doc_type: string }).doc_type)).toEqual(['context']);
  });

  it('keeps the other id when it comes out of a list', async () => {
    await seed(`${ACCOUNT_A}\n    dsp_advertiser_ids: ["${ID}", "${ID2}"]`);
    h.lookups = [found('acme-goods'), found()];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(gatewayParseDspAdvertiserIds(await readCtx())).toEqual([ID2]);
  });

  it('removes the key when the block list becomes empty', async () => {
    await seed(`${ACCOUNT_A}\n    dsp_advertiser_ids:\n      - "${ID}"`);
    h.lookups = [found('acme-goods'), found()];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    const text = await readCtx();
    expect(text).not.toContain('dsp_advertiser_ids');
    expect(gatewayParseDspAdvertiserIds(text)).toEqual([]);
  });

  it('is a no-op with exit 0 when the brand does not declare it', async () => {
    const before = await seed(ACCOUNT_A);
    h.lookups = [found('other-brand')];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'not_declared' });
    expect(process.exitCode).toBeUndefined();
    expect(await readCtx()).toBe(before);
  });

  it('refuses when the lookup is unavailable', async () => {
    await seed(SINGLE());
    h.lookups = [dspLookupResultFrom({}, 404, ID)];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ reason: 'lookup_unavailable' });
    expect(process.exitCode).toBe(1);
  });

  it('refuses when context.yaml has unpublished changes', async () => {
    const published = await seed(SINGLE());
    await writeFile(contextFile(), `${published}# note\n`, 'utf8');
    const state = emptyState(null);
    state.docs.context = {
      server_revision: 1,
      last_synced_hash: hashContent(published),
      last_synced_at: '2026-10-01T00:00:00Z',
    };
    await saveState('acme-goods', state, tmpDataDir);
    h.lookups = [found('acme-goods')];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ reason: 'context_has_unpublished_changes' });
  });

  it('rolls the file back when the push fails', async () => {
    installClient({ putStatus: 'conflict' });
    const before = await seed(SINGLE());
    h.lookups = [found('acme-goods')];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ kind: 'push_failed', rolled_back: true });
    expect(await readCtx()).toBe(before);
  });

  it('proves the result against the service reading: a declaration outside accounts is refused', () => {
    const text = contextYaml(ACCOUNT_A) + `dsp_advertiser_id: "${ID}"\n`;
    expect(planDspUnassignment(text, ID)).toMatchObject({ ok: false, reason: 'result_not_recognized' });
  });
});

// Parity with the service's reader. Ported from mx-gateway extractDspAdvertiserIds
// (src/context/store.ts) at origin/main e42b4a853266d4269d770f17b9740b48ac544a82.
describe('gatewayParseDspAdvertiserIds parity', () => {
  const cases: Array<[string, string, string[]]> = [
    ['quoted scalar', `dsp_advertiser_id: "${ID}"`, [ID]],
    ['single-quoted scalar', `dsp_advertiser_id: '${ID}'`, [ID]],
    ['scalar on a list item', `- dsp_advertiser_id: "${ID}"`, [ID]],
    ['scalar with a trailing comment', `  dsp_advertiser_id: "${ID}"  # note`, [ID]],
    ['unquoted scalar declares nothing', `dsp_advertiser_id: ${ID}`, []],
    ['null scalar', 'dsp_advertiser_id: null', []],
    ['one-line flow list', `dsp_advertiser_ids: ["${ID}", "${ID2}"]`, [ID, ID2]],
    ['unquoted item in a flow list is skipped', `dsp_advertiser_ids: ["${ID}", 5]`, [ID]],
    ['multi-line flow list declares nothing', `dsp_advertiser_ids: [\n  "${ID}",\n]`, []],
    ['block list with blank and comment lines', `dsp_advertiser_ids:\n\n  # c\n  - "${ID}"\n\n  - "${ID2}"`, [ID, ID2]],
    ['block list stops at a bad item', `dsp_advertiser_ids:\n  - "${ID}"\n  - 5\n  - "${ID2}"`, [ID]],
    ['scalar under dsp_advertiser_ids declares nothing', `dsp_advertiser_ids: "${ID}"`, []],
    ['CRLF line endings', `dsp_advertiser_id: "${ID}"\r\n`, [ID]],
    ['prose mentioning the key mid-line', `note: see dsp_advertiser_id: "${ID}"`, []],
  ];
  it.each(cases)('%s', (_name, text, expected) => {
    expect(gatewayParseDspAdvertiserIds(text)).toEqual(expected);
  });
});


describe('surgical edit: only the DSP lines change', () => {
  const insertedLine = `    dsp_advertiser_id: "${ID}"`;

  it('keeps an unquoted long id on another account byte for byte', () => {
    const text = contextYaml(`${ACCOUNT_A}\n${ACCOUNT_B}\n    legacy_ref: 583038429395722041`);
    const plan = planDspAssignment(text, ID, '111');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain('legacy_ref: 583038429395722041');
    expect(plan.content.replace(`${insertedLine}\n`, '')).toBe(text);
  });

  it('keeps zip: 01234, 0x1F and 1e3 as written', () => {
    const text = contextYaml(ACCOUNT_A) + 'zip: 01234\nhex: 0x1F\nexp: 1e3\n';
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content.replace(`${insertedLine}\n`, '')).toBe(text);
  });

  it('keeps CRLF line endings on every line, including the new one', () => {
    const text = contextYaml(ACCOUNT_A).replace(/\n/g, '\r\n');
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain(`${insertedLine}\r\n`);
    expect(plan.content).not.toMatch(/(?<!\r)\n/);
    expect(plan.content.replace(`${insertedLine}\r\n`, '')).toBe(text);
  });

  it('keeps non-indented sequences and appends in the same style', () => {
    const accounts = `${ACCOUNT_A}\n    tags:\n    - a\n    - b\n    dsp_advertiser_ids:\n    - "${ID2}"`;
    const text = contextYaml(accounts);
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain(`    - "${ID2}"\n    - "${ID}"\n`);
    expect(plan.content).toContain('    tags:\n    - a\n    - b\n');
    expect(plan.removed_lines).toEqual([]);
    expect(gatewayParseDspAdvertiserIds(plan.content)).toEqual([ID2, ID]);
  });

  it('converts a scalar to a one-line list, appends to a flow list, and removes, touching only DSP lines', () => {
    const scalar = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_id: "${ID2}"  # keep me`);
    const conv = planDspAssignment(scalar, ID);
    expect(conv.ok && conv.content).toContain(`    dsp_advertiser_ids: ["${ID2}", "${ID}"]  # keep me`);
    const flow = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_ids: ["${ID2}"]`);
    const app = planDspAssignment(flow, ID);
    expect(app.ok && app.content).toContain(`dsp_advertiser_ids: ["${ID2}", "${ID}"]`);
    const rem = planDspUnassignment(app.ok ? app.content : '', ID2);
    expect(rem.ok && rem.content).toContain(`dsp_advertiser_ids: ["${ID}"]`);
    const gone = planDspUnassignment(scalar, ID2);
    expect(gone.ok && gone.content).toBe(contextYaml(ACCOUNT_A));
    for (const r of [conv, app, rem, gone]) {
      if (!r.ok) throw new Error('plan failed');
      for (const l of [...r.removed_lines, ...r.added_lines]) expect(l).toMatch(/dsp_advertiser_ids?:/);
    }
  });

  it('still plans when the file has no final newline', () => {
    const text = contextYaml(ACCOUNT_A).replace(/\n$/, '');
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
  });
});


describe('structure-proof edits (review round 3)', () => {
  const FIRST = (dspLine: string) =>
    [
      `  - ${dspLine}`,
      '    seller_id: 111',
      '    seller_name: Acme Goods US',
      '    account_type: SC',
      '    status: active',
      '    role: primary',
    ].join('\n');
  const parsedAccounts = (text: string): any[] => (parseYaml(text) as { accounts: any[] }).accounts;

  it('inserts after a nested map whose last value is empty with a comment, next account indented', () => {
    const accounts = `${ACCOUNT_A}\n    meta:\n      a: # x\n${ACCOUNT_B}`;
    const text = contextYaml(accounts);
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain(`      a: # x\n    dsp_advertiser_id: "${ID}"\n  - seller_id: 222`);
    expect(parsedAccounts(plan.content)[0].meta).toEqual({ a: null });
    expect(parsedAccounts(plan.content)[1].dsp_advertiser_id).toBeUndefined();
  });

  it('inserts before a comment line that follows an empty last value', () => {
    const accounts = `${ACCOUNT_A}\n    meta:\n      a:\n      # y\n${ACCOUNT_B}`;
    const plan = planDspAssignment(contextYaml(accounts), ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const acc = parsedAccounts(plan.content);
    expect(acc[0].dsp_advertiser_id).toBe(ID);
    expect(acc[0].meta).toEqual({ a: null });
    expect(acc[1].dsp_advertiser_id).toBeUndefined();
  });

  it('inserts after the last item of a block sequence of maps', () => {
    const accounts = `${ACCOUNT_A}\n    history:\n      - from: 2020\n        to: 2021\n${ACCOUNT_B}`;
    const plan = planDspAssignment(contextYaml(accounts), ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain(`        to: 2021\n    dsp_advertiser_id: "${ID}"\n  - seller_id: 222`);
    expect(parsedAccounts(plan.content)[0].history).toEqual([{ from: 2020, to: 2021 }]);
  });

  it('keeps the dash when a first-key DSP line is converted', () => {
    const text = contextYaml(FIRST(`dsp_advertiser_id: "${ID2}"`));
    const plan = planDspAssignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain(`  - dsp_advertiser_ids: ["${ID2}", "${ID}"]\n    seller_id: 111`);
    expect(parsedAccounts(plan.content)).toHaveLength(1);
  });

  it('keeps the dash when a first-key flow list is appended to', () => {
    const plan = planDspAssignment(contextYaml(FIRST(`dsp_advertiser_ids: ["${ID2}"]`)), ID);
    expect(plan.ok && plan.content).toContain(`  - dsp_advertiser_ids: ["${ID2}", "${ID}"]\n    seller_id: 111`);
  });

  it('keeps the dash when an empty first-key value is filled', () => {
    for (const empty of ['dsp_advertiser_id: null', 'dsp_advertiser_id: ~', 'dsp_advertiser_id:']) {
      const plan = planDspAssignment(contextYaml(FIRST(empty)), ID);
      expect(plan.ok && plan.content).toContain(`  - dsp_advertiser_id: "${ID}"\n    seller_id: 111`);
    }
  });

  it('unassign of a first-key DSP line leaves a valid item', () => {
    const text = contextYaml(FIRST(`dsp_advertiser_id: "${ID}"`));
    const plan = planDspUnassignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain('  - seller_id: 111\n    seller_name: Acme Goods US');
    expect(plan.content).not.toContain('dsp_advertiser');
    expect(parsedAccounts(plan.content)).toHaveLength(1);
  });

  it('unassign of a first-key list keeps the other id and the dash', () => {
    const text = contextYaml(FIRST(`dsp_advertiser_ids: ["${ID}", "${ID2}"]`));
    const plan = planDspUnassignment(text, ID);
    expect(plan.ok && plan.content).toContain(`  - dsp_advertiser_ids: ["${ID2}"]\n    seller_id: 111`);
  });

  it('refuses a context.yaml that already fails the schema, naming the field', () => {
    const bad = contextYaml(`${ACCOUNT_A}\n  - seller_id: 222`);
    const a = planDspAssignment(bad, ID);
    expect(a).toMatchObject({ ok: false, reason: 'existing_context_invalid' });
    if (!a.ok) expect(a.message).toContain('accounts');
    expect(planDspUnassignment(bad, ID)).toMatchObject({ ok: false, reason: 'existing_context_invalid' });
  });

  it('unassign accepts single-quoted block items', () => {
    const text = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_ids:\n      - '${ID}'\n      - "${ID2}"`);
    // The service reads single quotes too.
    expect(gatewayParseDspAdvertiserIds(text)).toEqual([ID, ID2]);
    const plan = planDspUnassignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).not.toContain(`'${ID}'`);
    expect(gatewayParseDspAdvertiserIds(plan.content)).toEqual([ID2]);
  });

  it('unassign of a whole block list may drop the blank and comment lines between key and items', () => {
    const text = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_ids:\n\n      # keep nothing\n      - "${ID}"`);
    const plan = planDspUnassignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).not.toContain('dsp_advertiser_ids');
    expect(gatewayParseDspAdvertiserIds(plan.content)).toEqual([]);
    expect(parsedAccounts(plan.content)).toHaveLength(1);
  });

  it('unassign leaves another account\'s junk list alone', () => {
    const accounts = `${ACCOUNT_A}\n    dsp_advertiser_id: "${ID}"\n${ACCOUNT_B}\n    dsp_advertiser_ids: [~, {a: 1}]`;
    const text = contextYaml(accounts);
    const plan = planDspUnassignment(text, ID);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.content).toContain('dsp_advertiser_ids: [~, {a: 1}]');
    expect(plan.content).not.toContain(`"${ID}"`);
  });

  it('unassign refuses a list that holds the id next to a value that is not an id', () => {
    const text = contextYaml(`${ACCOUNT_A}\n    dsp_advertiser_ids: ["${ID}", ~]`);
    expect(planDspUnassignment(text, ID)).toMatchObject({ ok: false, reason: 'existing_value_invalid' });
  });
});

describe('command: expect, telemetry, invalid original (review round 3)', () => {
  it('refuses --expect without --commit', async () => {
    await seed(ACCOUNT_A);
    await assign(ID, '--brand', 'acme-goods', '--expect', 'abc123abc123');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'expect_without_commit' });
    expect(process.exitCode).toBe(1);
  });

  it('refuses when the original context.yaml already fails the schema', async () => {
    const before = await seed(`${ACCOUNT_A}\n  - seller_id: 222`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'existing_context_invalid' });
    expect(await readCtx()).toBe(before);
  });

  it('unassign honors --expect: a wrong hash refuses, the dry-run hash commits', async () => {
    await seed(`${ACCOUNT_A}\n    dsp_advertiser_id: "${ID}"`);
    h.lookups = [found('acme-goods')];
    await unassign(ID, '--brand', 'acme-goods');
    const dry = lastJson();
    expect(dry.plan_hash).toMatch(/^[0-9a-f]{12}$/);
    stdout = [];
    await unassign(ID, '--brand', 'acme-goods', '--commit', '--expect', '000000000000');
    expect(lastJson()).toMatchObject({ status: 'refused', reason: 'plan_changed' });
    expect(h.putDoc).not.toHaveBeenCalled();
    stdout = [];
    process.exitCode = undefined;
    h.lookups = [found('acme-goods'), found()];
    await unassign(ID, '--brand', 'acme-goods', '--commit', '--expect', dry.plan_hash);
    expect(lastJson()).toMatchObject({ status: 'ok', result: 'committed', verified: true });
  });

  it('never puts the advertiser id or a brand in the telemetry payload of assign or unassign', async () => {
    await seed(ACCOUNT_A);
    h.lookups = [found(), found('acme-goods')];
    await assign(ID, '--brand', 'acme-goods', '--commit');
    h.lookups = [found('acme-goods'), found()];
    stdout = [];
    await unassign(ID, '--brand', 'acme-goods', '--commit');
    const calls = vi.mocked(track).mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c).not.toContain(ID);
      expect(c).not.toContain('acme-goods');
    }
  });
});
