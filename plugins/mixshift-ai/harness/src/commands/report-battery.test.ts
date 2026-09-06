/**
 * `mixshift report battery`: the thin call in front of the service-side
 * figure batteries. Since 2.1.0 the command calls the BRAND battery
 * (MPRX-FIGURES-BRAND-01): one or many seller ids, or a brand slug resolved
 * from brand context, each routed server-side to its channel battery
 * (Seller Central or Vendor Central) and rolled up within one marketplace
 * currency. The dispatcher is mocked: what is pinned here is the flag
 * contract (repeatable --seller-id, --brand, the VC knobs), the params that
 * reach the service, the unwrap + document-shape assertion, the error
 * envelope (incl. the client-budget timeout and unknown kinds), and the
 * per-account summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runDispatched = vi.fn();
vi.mock('../lib/data/dispatch.js', () => ({ runDispatched: (...args: unknown[]) => runDispatched(...args) }));

import {
  registerReportCommands,
  batteryParams,
  batterySummary,
  batteryFailure,
  assertBatteryDocument,
  resolveBatteryOut,
  resolveBatterySellerIds,
  collectIds,
  BATTERY_QUERY_ID,
  BATTERY_HTTP_TIMEOUT_MS,
  BATTERY_MAX_ACCOUNTS,
} from './report.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false);
  program.option('--data-dir <path>', 'data dir');
  registerReportCommands(program);
  return program;
}

async function runCli(opts: { json?: boolean; dataDir?: string }, ...args: string[]): Promise<void> {
  const globalArgs = [...(opts.json ? ['--json'] : []), ...(opts.dataDir ? ['--data-dir', opts.dataDir] : [])];
  await buildProgram().parseAsync(['node', 'mixshift', ...globalArgs, 'report', 'battery', ...args]);
}

const scDoc = {
  seller_id: 7,
  channel: 'SC',
  windows: { current: ['2026-09-01', '2026-09-08'], day_count: 8 },
  account_retail: { A_current: { ops: 1000 } },
  dark_days: { current: { zero_spend_days: ['2026-09-02'], normalization_factor: 2 }, prior_month: { zero_spend_days: [], normalization_factor: 1 } },
  sections_failed: { oos_days: 'timeout: Query execution was interrupted, maximum statement execution time exceeded' },
  reconciliation: { account_ops: 1234.5, sku_sum: 1230, gap_pct: -0.36, note: 'x' },
};
const vcDoc = {
  seller_id: 9,
  channel: 'VC',
  windows: { current: ['2026-09-01', '2026-09-08'], day_count: 8 },
  account_retail: { A_current: { ops: 500 } },
  dark_days: { current: { zero_spend_days: [] } },
  sections_failed: {},
  reconciliation: { account_ops: '500.00', sku_sum: '500', gap_pct: '0' },
};

const document = {
  as_of: '2026-09-10',
  seller_ids: [7, 9],
  alignment: { as_of_requested: '2026-09-10', aligned_end: '2026-09-08', per_account_end: { '7': '2026-09-08', '9': '2026-09-08' }, aligned: true },
  thresholds_applied: { brands: [] },
  accounts: [
    { seller_id: 7, name: 'Acme 3P', channel: 'SC', marketplace_id: 1, currency: 'USD', document: scDoc, failure: null },
    { seller_id: 9, name: 'Acme 1P', channel: 'VC', marketplace_id: 1, currency: 'USD', document: vcDoc, failure: null },
  ],
  rollup: { mixed_currency: false, mixed_channel: true, by_marketplace: [{ marketplace_id: 1 }], brand: { marketplace_id: 1 } },
  sections_failed: {},
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function okDispatch() {
  return { ok: true, id: BATTERY_QUERY_ID, rows: [document], rowCount: 1, durationMs: 5, usedDispatch: 'named', displaySql: '--', boundParams: {}, revision: 'abcd1234' };
}

function failDispatch(kind: string, extra: Record<string, unknown> = {}) {
  return {
    ok: false,
    id: BATTERY_QUERY_ID,
    usedDispatch: 'named',
    failure: { ok: false, kind, message: 'm', friendly: `friendly ${kind}`, durationMs: 1, ...extra },
  };
}

const base = { sellerId: ['7'], buyboxFloor: '92', buyboxDrop: '5', revenueBasis: 'ordered', out: 'figures.json', timeout: '60' };

let dir: string;
let out: string[];
let exitCodeBefore: typeof process.exitCode;

beforeEach(async () => {
  exitCodeBefore = process.exitCode;
  process.exitCode = undefined;
  out = [];
  runDispatched.mockReset();
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  dir = await mkdtemp(join(tmpdir(), 'mx-report-battery-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCodeBefore;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('report battery: flags -> battery params', () => {
  it('translates every flag, splits and trims brands, defaults as_of to the local day, omits absent optionals', () => {
    expect(
      batteryParams({
        ...base, sellerId: ['7', '9'], asOf: '2026-09-03', brands: ' Acme , Zed,, ', minItemSales: '250', buyboxFloor: '95', buyboxDrop: '3', revenueBasis: 'shipped', attribution: 'sc_default',
      }),
    ).toEqual({
      seller_ids: [7, 9], as_of: '2026-09-03', brands: ['Acme', 'Zed'], min_item_sales: 250, buybox_floor: 95, buybox_drop: 3, revenue_basis: 'shipped', attribution: 'sc_default',
    });
    const defaults = batteryParams(base);
    expect(defaults).toEqual({ seller_ids: [7], as_of: expect.stringMatching(DATE), brands: [], buybox_floor: 92, buybox_drop: 5, revenue_basis: 'ordered' });
    expect(defaults).not.toHaveProperty('attribution');
    // The script defaulted --as-of on the operator's clock; a month-end run must not roll over because the service is in UTC.
    const t = new Date();
    expect(defaults.as_of).toBe(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  });

  it('collects repeated and comma-listed --seller-id values into one list', () => {
    expect(collectIds('113, 114', [])).toEqual(['113', '114']);
    expect(collectIds('655', ['113', '114'])).toEqual(['113', '114', '655']);
    expect(collectIds(' , ', ['7'])).toEqual(['7']);
  });

  it('rejects malformed flags locally with a stable error class', () => {
    for (const bad of [
      { ...base, sellerId: [] },
      { ...base, sellerId: ['0'] },
      { ...base, sellerId: ['7.5'] },
      { ...base, sellerId: ['seven'] },
      { ...base, sellerId: ['99999999999999999999'] },
      { ...base, sellerId: ['7', '7'] },
      { ...base, sellerId: Array.from({ length: BATTERY_MAX_ACCOUNTS + 1 }, (_, i) => String(i + 1)) },
      { ...base, asOf: '2026-9-3' },
      { ...base, asOf: '2026-13-45' },
      { ...base, asOf: '2026-02-30' },
      { ...base, minItemSales: '-1' },
      { ...base, buyboxFloor: '101' },
      { ...base, buyboxFloor: '0x10' },
      { ...base, buyboxFloor: '1e1' },
      { ...base, buyboxDrop: 'x' },
      { ...base, revenueBasis: 'invoiced' },
      { ...base, attribution: 'all_7' },
    ]) {
      expect(() => batteryParams(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_flag' }));
    }
  });

  it('"-" means stdout, anything else is a path, and the default is figures.json', () => {
    expect(resolveBatteryOut('-')).toBeUndefined();
    expect(resolveBatteryOut('out/figures.json')).toBe('out/figures.json');
    const battery = buildProgram().commands.find((c) => c.name() === 'report')!.commands.find((c) => c.name() === 'battery')!;
    expect(battery.options.find((o) => o.long === '--out')!.defaultValue).toBe('figures.json');
    expect(battery.options.find((o) => o.long === '--seller-id')!.mandatory).toBe(false);
  });
});

describe('report battery: --brand resolves the accounts from brand context', () => {
  async function writeContext(slug: string, accounts: Array<Record<string, unknown>>): Promise<string> {
    const dataDir = join(dir, 'data');
    const brandDir = join(dataDir, 'clients', slug);
    await mkdir(brandDir, { recursive: true });
    const yaml = [
      'schema_version: 1',
      `brand_slug: ${slug}`,
      `brand_name: ${slug}`,
      'last_updated: 2026-09-01',
      'accounts:',
      ...accounts.flatMap((a) => [
        `  - seller_id: ${a.seller_id}`,
        `    seller_name: "${a.seller_name}"`,
        `    account_type: ${a.account_type}`,
        `    status: ${a.status}`,
        `    role: ${a.role}`,
      ]),
      'sources:',
      '  ad_metrics: campaignmetric',
      '  ops_revenue: vendor_sales_manufacturing_asin',
      '  ops_revenue_field: OrderedRevenueAmount',
      '  ops_units_field: OrderedUnits',
      '  ops_date_field: DateTime',
      'management:',
      '  primary_metric: ACOS',
      '  acos_target_pct: 20',
      '  attribution_window_days: 14',
      '',
    ].join('\n');
    await writeFile(join(brandDir, 'context.yaml'), yaml, 'utf8');
    return dataDir;
  }

  it('takes every account that is not inactive, in context order, and refuses --seller-id alongside', async () => {
    const dataDir = await writeContext('acme', [
      { seller_id: 113, seller_name: 'Acme US', account_type: 'VC', status: 'active', role: 'primary' },
      { seller_id: 114, seller_name: 'Acme Polar', account_type: 'VC', status: 'wind_down', role: 'secondary' },
      { seller_id: 300, seller_name: 'Acme old', account_type: 'SC', status: 'inactive', role: 'legacy' },
    ]);
    await expect(resolveBatterySellerIds({ sellerId: [], brand: 'acme' }, dataDir)).resolves.toEqual({ ids: [113, 114], brand: 'acme' });
    await expect(resolveBatterySellerIds({ sellerId: ['7'], brand: 'acme' }, dataDir)).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_flag' }));
    await expect(resolveBatterySellerIds({ sellerId: [] }, dataDir)).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_flag' }));
    await expect(resolveBatterySellerIds({ sellerId: ['7', '9'] }, dataDir)).resolves.toEqual({ ids: [7, 9] });
  });

  it('an unknown brand or a brand with no live account is a clean bad_brand error', async () => {
    const dataDir = await writeContext('ghost', [
      { seller_id: 1, seller_name: 'Gone', account_type: 'SC', status: 'inactive', role: 'legacy' },
    ]);
    await expect(resolveBatterySellerIds({ sellerId: [], brand: 'nope' }, dataDir)).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_brand' }));
    await expect(resolveBatterySellerIds({ sellerId: [], brand: 'ghost' }, dataDir)).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_brand' }));
  });

  it('the command runs the brand battery on the resolved ids and reports the brand in --json', async () => {
    const dataDir = await writeContext('acme', [
      { seller_id: 7, seller_name: 'Acme 3P', account_type: 'SC', status: 'active', role: 'primary' },
      { seller_id: 9, seller_name: 'Acme 1P', account_type: 'VC', status: 'active', role: 'secondary' },
    ]);
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({ json: true, dataDir }, '--brand', 'acme', '--out', join(dir, 'f.json'));
    expect(runDispatched).toHaveBeenCalledWith(BATTERY_QUERY_ID, expect.objectContaining({ params: expect.objectContaining({ seller_ids: [7, 9] }), sellerIds: [7, 9] }));
    expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true, brand: 'acme', accounts: [{ seller_id: 7, channel: 'SC' }, { seller_id: 9, channel: 'VC' }] });
  });
});

describe('report battery: command', () => {
  it('calls the brand battery id with the params, the seller scope and the battery HTTP budget, writes --out, prints the summary', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    const outPath = join(dir, 'nested', 'figures.json');
    await runCli({}, '--seller-id', '7', '--seller-id', '9', '--as-of', '2026-09-03', '--brands', 'Acme,Zed', '--min-item-sales', '250', '--buybox-floor', '95', '--buybox-drop', '3', '--revenue-basis', 'shipped', '--out', outPath, '--timeout', '90');

    expect(runDispatched).toHaveBeenCalledTimes(1);
    expect(runDispatched).toHaveBeenCalledWith(BATTERY_QUERY_ID, {
      params: { seller_ids: [7, 9], as_of: '2026-09-03', brands: ['Acme', 'Zed'], min_item_sales: 250, buybox_floor: 95, buybox_drop: 3, revenue_basis: 'shipped' },
      sellerIds: [7, 9],
      queryTimeoutMs: 90_000,
      httpTimeoutMs: BATTERY_HTTP_TIMEOUT_MS,
    });
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(document);
    expect(out).toEqual([
      `wrote ${outPath}`,
      'accounts: 7 (SC), 9 (VC); aligned to 2026-09-08 (8 days)',
      'account 7: reconciliation account $1,235 vs SKU sum $1,230 (-0.36%)',
      'SECTION FAILED (brief runs without it, label the gap): 7/oos_days: timeout: Query execution was interrupted, maximum statement execution time exceeded',
      'dark ad days in 7/current: 2026-09-02 (normalize by 2)',
      'account 9: reconciliation account $500 vs SKU sum $500 (0%)',
      'rollup: Seller Central + Vendor Central in one marketplace; revenue, units and ad figures are summed, traffic and conversion stay per channel',
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('a comma list in one --seller-id flag is the same call as repeating the flag', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({}, '--seller-id', '7,9', '--out', '-');
    expect(runDispatched).toHaveBeenCalledWith(BATTERY_QUERY_ID, expect.objectContaining({ params: expect.objectContaining({ seller_ids: [7, 9] }) }));
  });

  it('--out - prints the raw document to stdout and writes nothing', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({}, '--seller-id', '7', '--out', '-');
    expect(JSON.parse(out.join('\n'))).toEqual(document);
  });

  it('--json carries the revision, alignment, per-account failures and sections, the rollup flags, and the figures only when nothing was written', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({ json: true }, '--seller-id', '7', '--out', '-');
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed).toMatchObject({
      ok: true,
      out: null,
      revision: 'abcd1234',
      brand: null,
      alignment: document.alignment,
      accounts: [
        { seller_id: 7, channel: 'SC', failure: null, sections_failed: scDoc.sections_failed, reconciliation: scDoc.reconciliation },
        { seller_id: 9, channel: 'VC', failure: null, sections_failed: {} },
      ],
      rollup: { mixed_currency: false, mixed_channel: true },
      sections_failed: {},
    });
    expect(parsed.figures).toEqual(document);

    out = [];
    const outPath = join(dir, 'figures.json');
    await runCli({ json: true }, '--seller-id', '7', '--out', outPath);
    const withOut = JSON.parse(out.join('\n'));
    expect(withOut.out).toBe(outPath);
    expect(withOut).not.toHaveProperty('figures');
  });

  it('surfaces a service failure as the envelope friendly text with the kind as error class', async () => {
    runDispatched.mockResolvedValue(
      failDispatch('bad_params', { message: 'No seller row for SellerID 7.', friendly: 'No seller row for SellerID 7 in this account\'s warehouse.' }),
    );
    await runCli({ json: true }, '--seller-id', '7', '--out', join(dir, 'f.json'));
    expect(JSON.parse(out.join('\n'))).toEqual({
      status: 'error',
      error_class: 'report_battery_bad_params',
      message: "No seller row for SellerID 7 in this account's warehouse. (MPRX-FIGURES-BRAND-01: bad_params)",
    });
    expect(process.exitCode).toBe(1);
  });

  it('a not-yet-deployed pack (unknown_query) is a clean error, not a crash', async () => {
    runDispatched.mockResolvedValue(failDispatch('unknown_query', { friendly: 'not a known library query' }));
    await expect(runCli({}, '--seller-id', '7', '--out', join(dir, 'f.json'))).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_unknown_query' }));
  });

  it('a wrapped, stringified or account-less document is refused as bad_document and nothing is written', async () => {
    const outPath = join(dir, 'figures.json');
    for (const row of [{ document: JSON.stringify(document) }, { figures: '{}' }, ['a', 'b'], 'text', null, { ...document, accounts: 'none' }, scDoc]) {
      runDispatched.mockResolvedValue({ ...okDispatch(), rows: [row] });
      out = [];
      await runCli({ json: true }, '--seller-id', '7', '--out', outPath);
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.status).toBe('error');
      expect(['report_battery_bad_document', 'report_battery_empty']).toContain(parsed.error_class);
    }
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
  });

  it('an empty envelope is refused rather than written as an empty figures file', async () => {
    runDispatched.mockResolvedValue({ ...okDispatch(), rows: [], rowCount: 0 });
    const outPath = join(dir, 'figures.json');
    await runCli({ json: true }, '--seller-id', '7', '--out', outPath);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_empty' });
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
  });

  it('a bad --timeout, a missing account list, or both selectors are rejected before any call is made', async () => {
    await runCli({ json: true }, '--seller-id', '7', '--timeout', '999', '--out', join(dir, 'f.json'));
    expect(runDispatched).not.toHaveBeenCalled();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_bad_flag' });
    out = [];
    await runCli({ json: true }, '--out', join(dir, 'f.json'));
    expect(runDispatched).not.toHaveBeenCalled();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_bad_flag' });
    out = [];
    await runCli({ json: true }, '--seller-id', '7', '--brand', 'acme', '--out', join(dir, 'f.json'));
    expect(runDispatched).not.toHaveBeenCalled();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_bad_flag' });
  });
});

describe('report battery: failure mapping', () => {
  it('the client HTTP budget expiring is a timeout, not a connectivity problem', () => {
    const err = batteryFailure({ ok: false, kind: 'host_unreachable', message: 'aborted', friendly: 'Timed out connecting to host. Run mixshift doctor.', durationMs: BATTERY_HTTP_TIMEOUT_MS + 12 });
    expect(err.errorClass).toBe('report_battery_timeout');
    expect(err.message).toContain('did not answer within 290s');
    expect(err.message).toContain('fewer accounts');
    expect(err.message).toContain('references/queries.md');
    // A fast host_unreachable IS a connectivity problem.
    const fast = batteryFailure({ ok: false, kind: 'host_unreachable', message: 'ECONNREFUSED', friendly: 'Could not reach the host.', durationMs: 40 });
    expect(fast.errorClass).toBe('report_battery_host_unreachable');
  });

  it('keeps the error class bounded: an unknown wire kind folds to unknown while the message keeps the raw kind', () => {
    const err = batteryFailure({ ok: false, kind: 'brand_new_kind' as never, message: 'm', friendly: 'f', durationMs: 1 });
    expect(err.errorClass).toBe('report_battery_unknown');
    expect(err.message).toBe('f (MPRX-FIGURES-BRAND-01: brand_new_kind)');
    expect(batteryFailure({ ok: false, kind: 'busy', message: 'm', friendly: 'f', durationMs: 1 }).errorClass).toBe('report_battery_busy');
  });

  it('assertBatteryDocument accepts the brand shape and names what is missing', () => {
    expect(assertBatteryDocument(document)).toBe(document);
    expect(() => assertBatteryDocument({ accounts: [], rollup: {} })).toThrow(/missing alignment, sections_failed/);
    // A single-account SC document (the pre-2.1 shape) is refused: the skill would read the wrong keys.
    expect(() => assertBatteryDocument(scDoc)).toThrow(/missing accounts, rollup, alignment/);
  });
});

describe('report battery: summary lines', () => {
  it('names failed accounts, flags misalignment and mixed currency, coerces DECIMAL strings, prints n/a for a missing side', () => {
    const doc = {
      alignment: { aligned_end: '2026-09-08', aligned: false },
      accounts: [
        { seller_id: 7, channel: 'SC', document: { windows: { day_count: 8 }, reconciliation: { account_ops: '1234.50', sku_sum: '1230', gap_pct: '-0.36' }, sections_failed: {}, dark_days: { current: { zero_spend_days: [] } } }, failure: null },
        { seller_id: 13, channel: null, document: null, failure: 'bad_params' },
      ],
      rollup: { mixed_currency: true, by_marketplace: [{}, {}] },
      sections_failed: { account_13: 'bad_params: not a Seller Central or Vendor Central account row' },
    };
    expect(batterySummary('f.json', doc)).toEqual([
      'wrote f.json',
      'accounts: 7 (SC), 13 (?, FAILED bad_params); aligned to 2026-09-08 (8 days); NOT ALIGNED, compare day counts before summing',
      'account 7: reconciliation account $1,235 vs SKU sum $1,230 (-0.36%)',
      'SECTION FAILED (brief runs without it, label the gap): account_13: bad_params: not a Seller Central or Vendor Central account row',
      'rollup: 2 marketplaces in different currencies, so NO brand total; quote each marketplace on its own',
    ]);
    expect(batterySummary('f.json', { accounts: [{ seller_id: 9, channel: 'VC', document: { reconciliation: { account_ops: null, sku_sum: 'abc', gap_pct: null }, sections_failed: {}, dark_days: {} } }], rollup: {}, sections_failed: {} })).toEqual([
      'wrote f.json',
      'accounts: 9 (VC)',
      'account 9: reconciliation account n/a vs SKU sum n/a (null%)',
    ]);
  });

  it('truncates a long failed-section message at 140 characters', () => {
    const why = 'x'.repeat(200);
    const lines = batterySummary('f.json', { accounts: [{ seller_id: 7, channel: 'SC', document: { reconciliation: {}, sections_failed: { oos_days: why }, dark_days: {} } }], rollup: {}, sections_failed: {} });
    expect(lines[3]).toBe(`SECTION FAILED (brief runs without it, label the gap): 7/oos_days: ${'x'.repeat(140)}`);
  });
});
