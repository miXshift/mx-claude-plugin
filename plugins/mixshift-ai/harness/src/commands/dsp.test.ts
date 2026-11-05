import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerDspCommands, EXIT_NOT_READY } from './dsp.js';
import { adsCall } from '../lib/amazon/ads-call.js';
import { track } from '../lib/telemetry/index.js';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../lib/amazon/ads-call.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/amazon/ads-call.js')>();
  return { ...actual, adsCall: vi.fn() };
});

vi.mock('../lib/telemetry/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telemetry/index.js')>();
  return { ...actual, track: vi.fn(async () => {}) };
});

const ADV = '583522466791149589';
const CAMP = '579709840191279772';
const AG = '579169548266394480';

function payloads(mediaTypes: string[] | undefined): Record<string, unknown> {
  return {
    'dsp.query_campaigns': {
      campaigns: [
        {
          campaignId: CAMP,
          name: 'Check',
          state: 'PAUSED',
          optimizations: { goalSettings: { kpi: 'REACH' }, ...(mediaTypes ? { primaryInventoryTypes: mediaTypes } : {}) },
        },
      ],
    },
    'dsp.query_ad_groups': { adGroups: [{ adGroupId: AG, inventoryType: 'DISPLAY' }] },
    'dsp.list_conversion_tracking_products': { nextToken: null, productTrackingList: [] },
    'dsp.query_targets': { targets: [{ adGroupId: AG, targetType: 'AUDIENCE', negative: false }] },
    'dsp.list_creative_associations': {
      associations: [{ adGroupId: AG, adCreativeId: 'c1', state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' }],
    },
    'dsp.list_association_moderations': { associationStatuses: [] },
  };
}

function wire(mediaTypes: string[] | undefined): void {
  const p = payloads(mediaTypes);
  vi.mocked(adsCall).mockImplementation(async (input) => ({
    ok: true,
    operation: input.operation,
    profileId: 'p',
    legacySellerId: 574,
    marketplaceId: null,
    payload: p[input.operation],
  }));
}

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'json', false).option('--data-dir <path>', 'dir');
  registerDspCommands(program);
  return program;
}

const runDsp = (...args: string[]): Promise<Command> =>
  buildProgram().parseAsync(['node', 'mixshift', ...args]);

let out: string[];
let err: string[];
let exitBefore: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  exitBefore = process.exitCode;
  process.exitCode = undefined;
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown): boolean => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown): boolean => {
    err.push(String(c));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitBefore;
});

describe('mixshift dsp readiness', () => {
  it('exits 0 and prints the checklist when the order is ready', async () => {
    wire(['DISPLAY']);
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    expect(process.exitCode).toBe(0);
    expect(out.join('')).toContain('Ready to switch on');
    const sent = vi.mocked(adsCall).mock.calls.map((c) => c[0]);
    expect(sent.every((i) => String(i.legacySellerId) === '574' && i.pathParams?.advertiserId === ADV)).toBe(true);
    // Reads only: nothing on this path may ask for a commit.
    expect(sent.every((i) => i.dryRun === undefined)).toBe(true);
    expect(sent.every((i) => !/\.(create|update|delete)_/.test(i.operation))).toBe(true);
  });

  it(`exits ${EXIT_NOT_READY} when a check fails, and records only counts and check ids`, async () => {
    wire(undefined);
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    expect(process.exitCode).toBe(EXIT_NOT_READY);
    expect(out.join('')).toContain('[FAIL] Media type set');
    const ev = vi.mocked(track).mock.calls[0]?.[0];
    expect(ev?.event_name).toBe('dsp.readiness_checked');
    expect(ev?.payload).toMatchObject({ ready: false, fail: 1, failed_checks: ['media_type'] });
    expect(JSON.stringify(ev)).not.toContain(ADV);
    expect(JSON.stringify(ev)).not.toContain(CAMP);
  });

  it('prints the report as JSON with --json', async () => {
    wire(['DISPLAY']);
    await runDsp('--json', 'dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    const parsed = JSON.parse(out.join(''));
    expect(parsed.status).toBe('ok');
    expect(parsed.ready).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('refuses without an advertiser id, before any call', async () => {
    await runDsp('dsp', 'readiness', CAMP, '--legacy-seller-id', '574');
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toContain('--advertiser-id is required');
    expect(adsCall).not.toHaveBeenCalled();
  });

  it('refuses a non-numeric order id, before any call', async () => {
    await runDsp('dsp', 'readiness', 'my-order', '--advertiser-id', ADV);
    expect(process.exitCode).toBe(1);
    expect(adsCall).not.toHaveBeenCalled();
  });

  it('supply-preset writes the delete body, previews it as a dry run and prints the commit command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsp-supply-'));
    try {
      vi.mocked(adsCall).mockImplementation(async (input) => {
        if (input.operation === 'dsp.query_targets') {
          return {
            ok: true,
            operation: input.operation,
            profileId: 'p',
            legacySellerId: 574,
            marketplaceId: null,
            payload: {
              targets: [
                { adGroupId: AG, targetId: 'keep', targetType: 'INVENTORY_SOURCE', targetDetails: { inventorySourceTarget: { inventorySourceType: 'AMAZON' } } },
                { adGroupId: AG, targetId: 'x1', targetType: 'INVENTORY_SOURCE', targetDetails: { inventorySourceTarget: { inventorySourceType: 'THIRD_PARTY_EXCHANGE' } } },
              ],
            },
          };
        }
        return {
          ok: true,
          operation: input.operation,
          profileId: 'p',
          legacySellerId: 574,
          marketplaceId: null,
          dryRun: true,
          itemsCount: 1,
          auditId: 'audit-123',
          preview: {},
        };
      });
      await runDsp('dsp', 'supply-preset', AG, '--advertiser-id', ADV, '--legacy-seller-id', '574', '--out-dir', dir);
      expect(process.exitCode).toBeUndefined();
      const del = vi.mocked(adsCall).mock.calls.map((c) => c[0]).find((i) => i.operation === 'dsp.delete_targets');
      expect(del?.body).toEqual({ targetIds: ['x1'] });
      // A preview only: the command never asks for a commit itself.
      expect(del?.dryRun).toBeUndefined();
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(JSON.parse(await readFile(join(dir, files[0] as string), 'utf8'))).toEqual({ targetIds: ['x1'] });
      const text = out.join('');
      expect(text).toContain('DRY RUN dsp.delete_targets: 1 target(s) validated, nothing removed.');
      expect(text).toContain(
        `mixshift ads call dsp.delete_targets --legacy-seller-id 574 --path advertiserId=${ADV} --body-file `,
      );
      expect(text).toContain('--commit --proposal-id audit-123');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unknown supply preset before any call', async () => {
    await runDsp('dsp', 'supply-preset', AG, '--advertiser-id', ADV, '--preset', 'open-exchange');
    expect(process.exitCode).toBe(1);
    expect(adsCall).not.toHaveBeenCalled();
  });

  it('exits with the failure kind when the order cannot be read', async () => {
    vi.mocked(adsCall).mockResolvedValue({
      ok: false,
      kind: 'not_authenticated',
      friendly: 'Sign in first',
      message: 'no token',
    } as never);
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV);
    expect(process.exitCode).toBe(2);
    expect(err.join('')).toContain('Sign in first');
  });
});
