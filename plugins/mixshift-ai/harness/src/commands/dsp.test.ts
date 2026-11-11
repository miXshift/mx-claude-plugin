import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerDspCommands, EXIT_NOT_READY, shellQuote, commitCommand } from './dsp.js';
import { adsCall } from '../lib/amazon/ads-call.js';
import { track } from '../lib/telemetry/index.js';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { saveCredentials, serviceTokenCachePath } from '../lib/auth/credentials.js';
import { loadCreativeMap, recordCreativeMappings } from '../lib/ads/dsp-creative-map.js';
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

const ADV = '1000000000000000001';
const CAMP = '2000000000000000005';
const AG = '3000000000000000006';

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
    'dsp.list_conversion_tracking_products': { nextToken: null, productTrackingList: [{ productId: 'B000TEST01' }] },
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
let dataDir: string;
let dataDirBefore: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  // Every command here reads the creative map from the data dir: never the real one.
  dataDirBefore = process.env.MIXSHIFT_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), 'dsp-cmd-'));
  process.env.MIXSHIFT_DATA_DIR = dataDir;
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

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitBefore;
  if (dataDirBefore === undefined) delete process.env.MIXSHIFT_DATA_DIR;
  else process.env.MIXSHIFT_DATA_DIR = dataDirBefore;
  await rm(dataDir, { recursive: true, force: true });
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
    // The printed commit carries --data-dir only when one is set; this case has none.
    delete process.env.MIXSHIFT_DATA_DIR;
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
      // A preview only, asked for explicitly: the command never commits.
      expect(del?.dryRun).toBe(true);
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

  it('supply-preset stops loudly when the service does not answer the preview as a dry run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsp-supply-'));
    try {
      vi.mocked(adsCall).mockImplementation(async (input) =>
        input.operation === 'dsp.query_targets'
          ? {
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
            }
          : { ok: true, operation: input.operation, profileId: 'p', legacySellerId: 574, marketplaceId: null, dryRun: false, auditId: 'a1' },
      );
      await runDsp('dsp', 'supply-preset', AG, '--advertiser-id', ADV, '--out-dir', dir);
      expect(process.exitCode).toBe(1);
      expect(err.join('')).toContain('did not answer the preview as a dry run');
      expect(out.join('')).not.toContain('DRY RUN');
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

describe('the printed commit command', () => {
  it('quotes paths so they paste into bash and PowerShell alike', () => {
    expect(shellQuote('C:\\Users\\a b\\x.json')).toBe("'C:\\Users\\a b\\x.json'");
    expect(shellQuote('/tmp/$HOME/x.json')).toBe("'/tmp/$HOME/x.json'");
    expect(shellQuote('\\\\server\\share\\x.json')).toBe("'\\\\server\\share\\x.json'");
    expect(shellQuote("it's.json")).toBe("'it'\\''s.json'");
    expect(shellQuote('plain-id_1.json')).toBe('plain-id_1.json');
  });

  it('carries the selector, --data-dir and the preview audit id', () => {
    const cmd = commitCommand({ legacySellerId: '574' }, ADV, '/x/body 1.json', 'audit-1', '/data dir');
    expect(cmd).toMatch(/^mixshift --data-dir '.*data dir' ads call dsp\.delete_targets --legacy-seller-id 574 /);
    expect(cmd).toContain(`--path advertiserId=${ADV} --body-file '/x/body 1.json' --commit --proposal-id audit-1`);
  });

  it('drops an audit id that is not a plain token', () => {
    expect(commitCommand({}, ADV, '/x.json', 'a b;rm -rf')).not.toContain('--proposal-id');
  });
});

// ---------------------------------------------------------------------------
// Responsive creative identity from the CLI (synthetic ids and identities)
// ---------------------------------------------------------------------------

const REC = '4000000000000000011';
const OTHER_ORDER = '2000000000000000099';

function jwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'HS256' })}.${seg(claims)}.sig`;
}

async function signIn(): Promise<void> {
  await saveCredentials(
    {
      schema_version: 2,
      created_at: new Date().toISOString(),
      datahub: {
        api_base: 'https://mcp.mixshift.io',
        access_token: jwt({ sub: 'tenant-1', actor: 'person@example.test' }),
        refresh_token: 'r'.repeat(24),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        user_id: 'tenant-1',
        email: 'login@example.test',
        person_label: 'person@example.test',
        device_label: 'test-host',
        client_id: 'mx-claude-plugin',
      },
    },
    dataDir,
  );
}

const recEntry = (order: string, over: Record<string, unknown> = {}) => ({
  tenant: 'user:tenant-1',
  advertiser_id: ADV,
  order_id: order,
  creative_id: REC,
  source: 'user_confirmed' as const,
  recorded_at: '2026-11-01T00:00:00.000Z',
  ...over,
});

/** Amazon answers for an order whose line item carries REC, a responsive creative. */
function wireRec(opts: { recFound?: boolean; responsive?: boolean } = {}): void {
  const p: Record<string, unknown> = {
    ...payloads(['DISPLAY']),
    'dsp.list_creative_associations': {
      associations: [{ adGroupId: AG, adCreativeId: REC, state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' }],
    },
    'dsp.list_association_moderations': {
      associationStatuses: [
        { adGroupId: AG, adCreativeId: REC, adExperiences: [{ adExperience: 'RESPONSIVE_ECOMMERCE', associationModerationStatus: 'APPROVED' }] },
      ],
    },
    'dsp.query_ads': {
      ads:
        opts.recFound === false
          ? []
          : [
              {
                adId: REC,
                name: 'Responsive ad',
                adType: opts.responsive === false ? 'DISPLAY' : 'COMPONENT',
                creative:
                  opts.responsive === false
                    ? { displayCreative: {} }
                    : { componentCreative: { responsiveEcommerceSettings: { products: [{ productId: 'B000TEST01' }] } } },
              },
            ],
    },
  };
  vi.mocked(adsCall).mockImplementation(async (input) => ({
    ok: true,
    operation: input.operation,
    profileId: 'p',
    legacySellerId: 574,
    marketplaceId: null,
    payload: p[input.operation],
  }));
}

describe('mixshift dsp readiness: responsive creative identity', () => {
  it("checks line items against the signed-in tenant's creative map, and records no ids in telemetry", async () => {
    await signIn();
    await recordCreativeMappings([recEntry(CAMP)], dataDir);
    wireRec();
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    expect(process.exitCode).toBe(0);
    expect(out.join('')).toContain(`[PASS] Responsive creative on line item ${AG}`);
    const ev = vi.mocked(track).mock.calls[0]?.[0];
    expect(ev?.payload).toMatchObject({ creative_map: 'ok', rec_identity: { pass: 1, reasons: ['expected_attached'] } });
    expect(JSON.stringify(ev)).not.toContain(REC);
    expect(JSON.stringify(ev)).not.toContain(CAMP);
  });

  it(`exits ${EXIT_NOT_READY} on another order's creative and prints the ids and the fix`, async () => {
    await signIn();
    await recordCreativeMappings([recEntry(OTHER_ORDER)], dataDir);
    wireRec();
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    expect(process.exitCode).toBe(EXIT_NOT_READY);
    const text = out.join('');
    expect(text).toContain(`[FAIL] Responsive creative on line item ${AG}`);
    expect(text).toContain(`recorded for order ${OTHER_ORDER}`);
    expect(text).toContain(`Remove ${REC} from line item ${AG} in the DSP console`);
    // Read-only: no write operation and no commit was asked for.
    const sent = vi.mocked(adsCall).mock.calls.map((c) => c[0]);
    expect(sent.every((i) => !/\.(create|update|delete)_/.test(i.operation) && i.dryRun === undefined)).toBe(true);
  });

  it('keeps a console-built creative CONFIRM until the user confirms it', async () => {
    await signIn();
    wireRec();
    await runDsp('--json', 'dsp', 'readiness', CAMP, '--advertiser-id', ADV, '--legacy-seller-id', '574');
    const parsed = JSON.parse(out.join(''));
    const id = parsed.responsiveCreativeIdentity[0];
    expect(id).toMatchObject({ verdict: 'confirm', reason: 'unverified_origin', orderId: CAMP, adGroupId: AG, attachedCreativeIds: [REC] });
    expect(parsed.ready).toBe(true);
  });
});

describe('mixshift dsp creative-map', () => {
  it('confirm is a dry run by default: it reads the order and the creative and records nothing', async () => {
    await signIn();
    wireRec();
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--legacy-seller-id', '574');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out.join('')).toContain(`DRY RUN: would record order ${CAMP} "Check" -> responsive creative ${REC} "Responsive ad"`);
    expect(await loadCreativeMap(dataDir)).toEqual({ ok: true, entries: [] });
    const ops = vi.mocked(adsCall).mock.calls.map((c) => c[0].operation);
    expect(ops).toEqual(['dsp.query_campaigns', 'dsp.query_ads']);
    expect(vi.mocked(adsCall).mock.calls.every((c) => c[0].dryRun === undefined)).toBe(true);
  });

  it('confirm --commit records what the user confirmed, and list shows it; readiness then passes', async () => {
    await signIn();
    wireRec();
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode ?? 0).toBe(0);
    const loaded = await loadCreativeMap(dataDir);
    expect(loaded).toMatchObject({
      ok: true,
      entries: [{ tenant: 'user:tenant-1', order_id: CAMP, creative_id: REC, source: 'user_confirmed', recorded_by: 'person@example.test' }],
    });
    out.length = 0;
    await runDsp('dsp', 'creative-map', 'list', '--advertiser-id', ADV);
    expect(out.join('')).toContain(`order ${CAMP} -> creative ${REC} (confirmed by user`);
    out.length = 0;
    await runDsp('dsp', 'readiness', CAMP, '--advertiser-id', ADV);
    expect(out.join('')).toContain(`[PASS] Responsive creative on line item ${AG}`);
  });

  it('refuses a creative Amazon does not have, or one that is not responsive, and records nothing', async () => {
    await signIn();
    wireRec({ recFound: false });
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toContain('was not found');
    process.exitCode = undefined;
    wireRec({ responsive: false });
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toContain('not a responsive ecommerce creative');
    expect(await loadCreativeMap(dataDir)).toEqual({ ok: true, entries: [] });
  });

  it('stops when a read fails, and records nothing', async () => {
    await signIn();
    vi.mocked(adsCall).mockResolvedValue({ ok: false, kind: 'not_authenticated', friendly: 'Sign in first', message: 'x' } as never);
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode).toBe(2);
    expect(await loadCreativeMap(dataDir)).toEqual({ ok: true, entries: [] });
  });

  it('refuses a creative already recorded for another order unless the user says it is shared on purpose', async () => {
    await signIn();
    await recordCreativeMappings([recEntry(OTHER_ORDER)], dataDir);
    wireRec();
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toContain(`already recorded for order ${OTHER_ORDER}`);
    expect(adsCall).not.toHaveBeenCalled();
    process.exitCode = undefined;
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--reuse', '--commit');
    expect(process.exitCode ?? 0).toBe(0);
    const loaded = await loadCreativeMap(dataDir);
    expect(loaded.ok && loaded.entries.find((e) => e.order_id === CAMP)?.reuse).toBe(true);
  });

  it('refuses to confirm under a service credential (nobody there to confirm)', async () => {
    await saveCredentials(
      {
        schema_version: 2,
        created_at: new Date().toISOString(),
        service: { api_base: 'https://mcp.mixshift.io', client_id: 'svc_abcdefgh1234', client_secret: 's'.repeat(24), label: 'nightly' },
      },
      dataDir,
    );
    const cache = serviceTokenCachePath(dataDir);
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(
      cache,
      JSON.stringify({ access_token: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString(), client_id: 'svc_abcdefgh1234', attribution: { owner_user_id: 'tenant-1' } }),
      'utf8',
    );
    await runDsp('dsp', 'creative-map', 'confirm', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(process.exitCode).toBe(1);
    expect(err.join('')).toContain('cannot be written under a service credential');
    expect(adsCall).not.toHaveBeenCalled();
  });

  it('remove is a dry run until --commit', async () => {
    await signIn();
    await recordCreativeMappings([recEntry(CAMP)], dataDir);
    await runDsp('dsp', 'creative-map', 'remove', CAMP, '--advertiser-id', ADV, '--creative-id', REC);
    expect(out.join('')).toContain('DRY RUN: would remove');
    expect((await loadCreativeMap(dataDir)).ok && (await loadCreativeMap(dataDir))).toMatchObject({ entries: [{ order_id: CAMP }] });
    await runDsp('dsp', 'creative-map', 'remove', CAMP, '--advertiser-id', ADV, '--creative-id', REC, '--commit');
    expect(await loadCreativeMap(dataDir)).toEqual({ ok: true, entries: [] });
  });

  it('list shows only the signed-in tenant', async () => {
    await signIn();
    await recordCreativeMappings([recEntry(CAMP, { tenant: 'user:tenant-2' })], dataDir);
    await runDsp('--json', 'dsp', 'creative-map', 'list');
    expect(JSON.parse(out.join(''))).toMatchObject({ status: 'ok', count: 0 });
  });
});
