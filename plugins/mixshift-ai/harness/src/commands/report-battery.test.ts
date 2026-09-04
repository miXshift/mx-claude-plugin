/**
 * `mixshift report battery`: the thin call that replaced the skill-shipped
 * pull_figures.py. The battery runs server-side (named query MPRX-FIGURES-01);
 * this command translates flags into the battery's params, unwraps the one-row
 * envelope, writes figures.json, and echoes the script's closing summary. The
 * dispatcher is mocked: what is pinned here is the flag contract, the params
 * that reach the service, the unwrap, the error envelope, and the summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runDispatched = vi.fn();
vi.mock('../lib/data/dispatch.js', () => ({ runDispatched: (...args: unknown[]) => runDispatched(...args) }));

import { registerReportCommands, batteryParams, batterySummary, BATTERY_QUERY_ID, BATTERY_HTTP_TIMEOUT_MS } from './report.js';

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('--json', 'emit machine-readable JSON to stdout', false);
  registerReportCommands(program);
  return program;
}

async function runCli(opts: { json?: boolean }, ...args: string[]): Promise<void> {
  const globalArgs = opts.json ? ['--json'] : [];
  await buildProgram().parseAsync(['node', 'mixshift', ...globalArgs, 'report', 'battery', ...args]);
}

const document = {
  seller_id: 7,
  as_of: '2026-09-03',
  windows: { current: ['2026-09-01', '2026-09-02'] },
  thresholds_applied: { sales_floor: 300 },
  account_ads: {},
  account_retail: {},
  dark_days: { current: { zero_spend_days: ['2026-09-02'], normalization_factor: 2 }, prior_month: { zero_spend_days: [], normalization_factor: 1 } },
  movers: { sum_cur: 1000 },
  sections_failed: { oos_days: 'timeout: Query execution was interrupted, maximum statement execution time exceeded' },
  reconciliation: { account_ops: 1234.5, sku_sum: 1230, gap_pct: -0.36, note: 'x' },
};

function okDispatch() {
  return { ok: true, id: BATTERY_QUERY_ID, rows: [document], rowCount: 1, durationMs: 5, usedDispatch: 'named', displaySql: '--', boundParams: {}, revision: 'abcd1234' };
}

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
  it('translates every flag, splits and trims brands, and omits absent optionals', () => {
    expect(
      batteryParams({ sellerId: '7', asOf: '2026-09-03', brands: ' Acme , Zed,, ', minItemSales: '250', buyboxFloor: '95', buyboxDrop: '3', timeout: '60' }),
    ).toEqual({ seller_id: 7, as_of: '2026-09-03', brands: ['Acme', 'Zed'], min_item_sales: 250, buybox_floor: 95, buybox_drop: 3 });
    expect(batteryParams({ sellerId: '7', buyboxFloor: '92', buyboxDrop: '5', timeout: '60' })).toEqual({
      seller_id: 7,
      brands: [],
      buybox_floor: 92,
      buybox_drop: 5,
    });
  });

  it('rejects malformed flags locally with a stable error class', () => {
    const base = { buyboxFloor: '92', buyboxDrop: '5', timeout: '60' };
    for (const bad of [
      { ...base, sellerId: '0' },
      { ...base, sellerId: '7.5' },
      { ...base, sellerId: 'seven' },
      { ...base, sellerId: '7', asOf: '2026-9-3' },
      { ...base, sellerId: '7', minItemSales: '-1' },
      { ...base, sellerId: '7', buyboxFloor: '101' },
      { ...base, sellerId: '7', buyboxDrop: 'x' },
    ]) {
      expect(() => batteryParams(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_flag' }));
    }
  });
});

describe('report battery: command', () => {
  it('calls the battery id with the params and the battery HTTP budget, writes --out, prints the summary', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    const outPath = join(dir, 'nested', 'figures.json');
    await runCli({}, '--seller-id', '7', '--as-of', '2026-09-03', '--brands', 'Acme,Zed', '--out', outPath, '--timeout', '90');

    expect(runDispatched).toHaveBeenCalledTimes(1);
    expect(runDispatched).toHaveBeenCalledWith(BATTERY_QUERY_ID, {
      params: { seller_id: 7, as_of: '2026-09-03', brands: ['Acme', 'Zed'], buybox_floor: 92, buybox_drop: 5 },
      queryTimeoutMs: 90_000,
      httpTimeoutMs: BATTERY_HTTP_TIMEOUT_MS,
    });
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(document);
    expect(out).toEqual([
      `wrote ${outPath}`,
      'reconciliation: account $1,235 vs SKU sum $1,230 (-0.36%)',
      'SECTION FAILED (brief runs without it, label the gap): oos_days: timeout: Query execution was interrupted, maximum statement execution time exceeded',
      'dark ad days in current: 2026-09-02 (normalize by 2)',
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the raw document to stdout without --out', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({}, '--seller-id', '7');
    expect(JSON.parse(out.join('\n'))).toEqual(document);
  });

  it('--json carries the revision, sections_failed and reconciliation, and the figures when not written to a file', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({ json: true }, '--seller-id', '7');
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed).toMatchObject({ ok: true, out: null, revision: 'abcd1234', sections_failed: document.sections_failed, reconciliation: document.reconciliation });
    expect(parsed.figures).toEqual(document);

    out = [];
    const outPath = join(dir, 'figures.json');
    await runCli({ json: true }, '--seller-id', '7', '--out', outPath);
    const withOut = JSON.parse(out.join('\n'));
    expect(withOut.out).toBe(outPath);
    expect(withOut).not.toHaveProperty('figures');
  });

  it('surfaces a service failure as the envelope friendly text with the kind as error class', async () => {
    runDispatched.mockResolvedValue({
      ok: false,
      id: BATTERY_QUERY_ID,
      usedDispatch: 'named',
      failure: { ok: false, kind: 'bad_params', message: 'No data for SellerID 7.', friendly: 'No data for SellerID 7. Confirm the account row: wrong twin (VC vs SC).', durationMs: 1 },
    });
    await runCli({ json: true }, '--seller-id', '7');
    expect(JSON.parse(out.join('\n'))).toEqual({
      status: 'error',
      error_class: 'report_battery_bad_params',
      message: 'No data for SellerID 7. Confirm the account row: wrong twin (VC vs SC). (MPRX-FIGURES-01: bad_params)',
    });
    expect(process.exitCode).toBe(1);
  });

  it('a not-yet-deployed pack (unknown_query) is a clean error, not a crash', async () => {
    runDispatched.mockResolvedValue({
      ok: false,
      id: BATTERY_QUERY_ID,
      usedDispatch: 'named',
      failure: { ok: false, kind: 'unknown_query', message: 'x', friendly: 'not a known library query', durationMs: 1 },
    });
    await expect(runCli({}, '--seller-id', '7')).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_unknown_query' }));
  });

  it('an empty envelope is refused rather than written as an empty figures file', async () => {
    runDispatched.mockResolvedValue({ ...okDispatch(), rows: [], rowCount: 0 });
    const outPath = join(dir, 'figures.json');
    await runCli({ json: true }, '--seller-id', '7', '--out', outPath);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_empty' });
    await expect(readFile(outPath, 'utf8')).rejects.toThrow();
  });

  it('a bad --timeout is rejected before any call is made', async () => {
    await runCli({ json: true }, '--seller-id', '7', '--timeout', '999');
    expect(runDispatched).not.toHaveBeenCalled();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_bad_flag' });
  });
});

describe('report battery: summary lines', () => {
  it('prints n/a for a missing reconciliation side and skips windows with no dark days', () => {
    expect(batterySummary('f.json', { reconciliation: { account_ops: null, sku_sum: 5, gap_pct: null }, sections_failed: {}, dark_days: { current: { zero_spend_days: [] } } })).toEqual([
      'wrote f.json',
      'reconciliation: account n/a vs SKU sum $5 (null%)',
    ]);
  });
});
