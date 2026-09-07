/**
 * `mixshift report battery`: the thin call that replaced the skill-shipped
 * pull_figures.py. The battery runs server-side (named query MPRX-FIGURES-01);
 * this command translates flags into the battery's params, unwraps the one-row
 * envelope, writes figures.json, and echoes the script's closing summary. The
 * dispatcher is mocked: what is pinned here is the flag contract, the params
 * that reach the service, the unwrap + document-shape assertion, the error
 * envelope (incl. the client-budget timeout and unknown kinds), and the summary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
  BATTERY_QUERY_ID,
  BATTERY_HTTP_TIMEOUT_MS,
} from './report.js';

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
      batteryParams({ sellerId: '7', asOf: '2026-09-03', brands: ' Acme , Zed,, ', minItemSales: '250', buyboxFloor: '95', buyboxDrop: '3', out: 'figures.json', timeout: '60' }),
    ).toEqual({ seller_id: 7, as_of: '2026-09-03', brands: ['Acme', 'Zed'], min_item_sales: 250, buybox_floor: 95, buybox_drop: 3 });
    const defaults = batteryParams({ sellerId: '7', buyboxFloor: '92', buyboxDrop: '5', out: 'figures.json', timeout: '60' });
    expect(defaults).toEqual({ seller_id: 7, as_of: expect.stringMatching(DATE), brands: [], buybox_floor: 92, buybox_drop: 5 });
    // The script defaulted --as-of on the operator's clock; a month-end run must not roll over because the service is in UTC.
    const t = new Date();
    expect(defaults.as_of).toBe(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  });

  it('rejects malformed flags locally with a stable error class', () => {
    const base = { buyboxFloor: '92', buyboxDrop: '5', out: 'figures.json', timeout: '60' };
    for (const bad of [
      { ...base, sellerId: '0' },
      { ...base, sellerId: '7.5' },
      { ...base, sellerId: 'seven' },
      { ...base, sellerId: '99999999999999999999' },
      { ...base, sellerId: '7', asOf: '2026-9-3' },
      { ...base, sellerId: '7', asOf: '2026-13-45' },
      { ...base, sellerId: '7', asOf: '2026-02-30' },
      { ...base, sellerId: '7', minItemSales: '-1' },
      { ...base, sellerId: '7', buyboxFloor: '101' },
      { ...base, sellerId: '7', buyboxFloor: '0x10' },
      { ...base, sellerId: '7', buyboxFloor: '1e1' },
      { ...base, sellerId: '7', buyboxDrop: 'x' },
    ]) {
      expect(() => batteryParams(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ errorClass: 'report_battery_bad_flag' }));
    }
  });

  it('"-" means stdout, anything else is a path, and the default is figures.json', () => {
    expect(resolveBatteryOut('-')).toBeUndefined();
    expect(resolveBatteryOut('out/figures.json')).toBe('out/figures.json');
    const battery = buildProgram().commands.find((c) => c.name() === 'report')!.commands.find((c) => c.name() === 'battery')!;
    expect(battery.options.find((o) => o.long === '--out')!.defaultValue).toBe('figures.json');
  });
});

describe('report battery: command', () => {
  it('calls the battery id with the params, the seller scope and the battery HTTP budget, writes --out, prints the summary', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    const outPath = join(dir, 'nested', 'figures.json');
    await runCli({}, '--seller-id', '7', '--as-of', '2026-09-03', '--brands', 'Acme,Zed', '--min-item-sales', '250', '--buybox-floor', '95', '--buybox-drop', '3', '--out', outPath, '--timeout', '90');

    expect(runDispatched).toHaveBeenCalledTimes(1);
    expect(runDispatched).toHaveBeenCalledWith(BATTERY_QUERY_ID, {
      params: { seller_id: 7, as_of: '2026-09-03', brands: ['Acme', 'Zed'], min_item_sales: 250, buybox_floor: 95, buybox_drop: 3 },
      sellerIds: [7],
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

  it('--out - prints the raw document to stdout and writes nothing', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({}, '--seller-id', '7', '--out', '-');
    expect(JSON.parse(out.join('\n'))).toEqual(document);
  });

  it('--json carries the revision, sections_failed and reconciliation, and the figures only when nothing was written', async () => {
    runDispatched.mockResolvedValue(okDispatch());
    await runCli({ json: true }, '--seller-id', '7', '--out', '-');
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
    runDispatched.mockResolvedValue(
      failDispatch('bad_params', { message: 'No data for SellerID 7.', friendly: 'No data for SellerID 7. Confirm the account row: wrong twin (VC vs SC).' }),
    );
    await runCli({ json: true }, '--seller-id', '7', '--out', join(dir, 'f.json'));
    expect(JSON.parse(out.join('\n'))).toEqual({
      status: 'error',
      error_class: 'report_battery_bad_params',
      message: 'No data for SellerID 7. Confirm the account row: wrong twin (VC vs SC). (MPRX-FIGURES-01: bad_params)',
    });
    expect(process.exitCode).toBe(1);
  });

  it('a not-yet-deployed pack (unknown_query) is a clean error, not a crash', async () => {
    runDispatched.mockResolvedValue(failDispatch('unknown_query', { friendly: 'not a known library query' }));
    await expect(runCli({}, '--seller-id', '7', '--out', join(dir, 'f.json'))).rejects.toThrow(expect.objectContaining({ errorClass: 'report_battery_unknown_query' }));
  });

  it('a wrapped or stringified document is refused as bad_document and nothing is written', async () => {
    const outPath = join(dir, 'figures.json');
    for (const row of [{ document: JSON.stringify(document) }, { figures: '{}' }, ['a', 'b'], 'text', null]) {
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

  it('a bad --timeout is rejected before any call is made', async () => {
    await runCli({ json: true }, '--seller-id', '7', '--timeout', '999', '--out', join(dir, 'f.json'));
    expect(runDispatched).not.toHaveBeenCalled();
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'error', error_class: 'report_battery_bad_flag' });
  });
});

describe('report battery: failure mapping', () => {
  it('the client HTTP budget expiring is a timeout, not a connectivity problem', () => {
    const err = batteryFailure({ ok: false, kind: 'host_unreachable', message: 'aborted', friendly: 'Timed out connecting to host. Run mixshift doctor.', durationMs: BATTERY_HTTP_TIMEOUT_MS + 12 });
    expect(err.errorClass).toBe('report_battery_timeout');
    expect(err.message).toContain('did not answer within 290s');
    expect(err.message).toContain('mixshift feedback');
    // A fast host_unreachable IS a connectivity problem.
    const fast = batteryFailure({ ok: false, kind: 'host_unreachable', message: 'ECONNREFUSED', friendly: 'Could not reach the host.', durationMs: 40 });
    expect(fast.errorClass).toBe('report_battery_host_unreachable');
  });

  it('keeps the error class bounded: an unknown wire kind folds to unknown while the message keeps the raw kind', () => {
    const err = batteryFailure({ ok: false, kind: 'brand_new_kind' as never, message: 'm', friendly: 'f', durationMs: 1 });
    expect(err.errorClass).toBe('report_battery_unknown');
    expect(err.message).toBe('f (MPRX-FIGURES-01: brand_new_kind)');
    expect(batteryFailure({ ok: false, kind: 'busy', message: 'm', friendly: 'f', durationMs: 1 }).errorClass).toBe('report_battery_busy');
  });

  it('assertBatteryDocument accepts the real shape and names what is missing', () => {
    expect(assertBatteryDocument(document)).toBe(document);
    expect(() => assertBatteryDocument({ windows: {}, thresholds_applied: {} })).toThrow(/missing sections_failed, reconciliation/);
  });
});

describe('report battery: summary lines', () => {
  it('coerces DECIMAL strings, prints n/a for a missing side, and skips windows with no dark days', () => {
    expect(
      batterySummary('f.json', {
        reconciliation: { account_ops: '1234.50', sku_sum: '1230', gap_pct: '-0.36' },
        sections_failed: {},
        dark_days: { current: { zero_spend_days: [] } },
      }),
    ).toEqual(['wrote f.json', 'reconciliation: account $1,235 vs SKU sum $1,230 (-0.36%)']);
    expect(batterySummary('f.json', { reconciliation: { account_ops: null, sku_sum: 'abc', gap_pct: null }, sections_failed: {}, dark_days: {} })).toEqual([
      'wrote f.json',
      'reconciliation: account n/a vs SKU sum n/a (null%)',
    ]);
  });

  it('truncates a long failed-section message at 140 characters', () => {
    const why = 'x'.repeat(200);
    const lines = batterySummary('f.json', { reconciliation: {}, sections_failed: { oos_days: why }, dark_days: {} });
    expect(lines[2]).toBe(`SECTION FAILED (brief runs without it, label the gap): oos_days: ${'x'.repeat(140)}`);
  });
});
