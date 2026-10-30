/**
 * `mixshift context dsp-advertiser show|assign` (mx-ops#205).
 *
 * The gateway client is mocked (no network, no credentials); commander, the
 * command handlers, the YAML edit, and the real engine/local/state modules run
 * for real against a temp data dir. All ids and brands are fake.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerContextCommands } from './context.js';
import { createContextSyncClient, dspLookupResultFrom } from '../lib/context-sync/client.js';
import type { ContextSyncClient } from '../lib/context-sync/client.js';
import { planDspAssignment } from '../lib/context-sync/dsp-advertiser.js';
import { track } from '../lib/telemetry/index.js';
import type { DspAdvertiserLookupResult, WireManifestBrand } from '../lib/context-sync/types.js';

vi.mock('../lib/context-sync/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/context-sync/client.js')>();
  return { ...actual, createContextSyncClient: vi.fn() };
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
}

let tmpDataDir: string;
let stdout: string[];
let stderr: string[];
let exitCodeBefore: typeof process.exitCode;
let h: Harness;

function installClient(opts: { putStatus?: 'ok' | 'conflict' } = {}): void {
  const manifest: WireManifestBrand[] = [{ brand_slug: 'acme-goods', docs: [] }];
  h.putDoc = vi.fn(async () =>
    opts.putStatus === 'conflict'
      ? {
          ok: false as const,
          kind: 'revision_conflict' as const,
          message: 'conflict',
          friendly: 'The shared copy moved.',
        }
      : { ok: true as const, status: 'created' as const, revision: 1 },
  );
  const client: ContextSyncClient = {
    fetchManifest: async () => ({ ok: true, brands: manifest }),
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

async function seed(accountsYaml: string): Promise<string> {
  const text = contextYaml(accountsYaml);
  await mkdir(join(tmpDataDir, 'clients', 'acme-goods'), { recursive: true });
  await writeFile(contextFile(), text, 'utf8');
  return text;
}

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
  tmpDataDir = await mkdtemp(join(tmpdir(), 'mx-dsp-adv-'));
  h = { lookups: [found()], lookupCalls: [], putDoc: vi.fn() };
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

  it('refuses several accounts without --account and lists them', async () => {
    const before = await seed(`${ACCOUNT_A}\n${ACCOUNT_B}`);
    await assign(ID, '--brand', 'acme-goods', '--commit');
    const out = lastJson();
    expect(out).toMatchObject({ status: 'refused', reason: 'account_required' });
    expect(out.accounts).toHaveLength(2);
    expect(out.message).toContain('seller_id 222');
    expect(await readCtx()).toBe(before);
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
  it('maps the documented shape and treats a missing entry as no brand', () => {
    expect(
      dspLookupResultFrom({ ok: true, advertisers: [{ advertiser_id: ID, brands: ['b', 'a'] }] }, 200, ID),
    ).toEqual({ ok: true, advertiser_id: ID, brands: ['a', 'b'] });
    expect(dspLookupResultFrom({ ok: true, advertisers: [] }, 200, ID)).toMatchObject({ ok: true, brands: [] });
  });

  it('never reads an unrecognized 200 as "no brand"', () => {
    expect(dspLookupResultFrom({ ok: true }, 200, ID)).toMatchObject({ ok: false });
    expect(dspLookupResultFrom({ ok: true, advertisers: [{ advertiser_id: ID, brands: 'x' }] }, 200, ID)).toMatchObject({
      ok: false,
    });
  });
});
