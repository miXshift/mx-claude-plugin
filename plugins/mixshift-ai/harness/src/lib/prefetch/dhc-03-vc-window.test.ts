/**
 * Regression test for mx-ops#408: VC daily health check windows end at the
 * latest loaded Vendor Central date, not at a fixed 2-day lag, and the VC
 * revenue windows (DHC-03) and the VC spend windows cover the same days.
 *
 * The real library SQL runs against an in-memory SQLite fixture. The params
 * come from the real pipeline (buildStandardParams, then substituteParams).
 * The only MySQL-to-SQLite rewrites are DATE_SUB(x, INTERVAL n DAY) and the
 * two-argument LEAST(a, b), done by `toSqlite` below; everything else in the
 * files runs as written.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildStandardParams } from './params.js';
import { substituteParams } from './substitute.js';
import type { BrandContext } from '../context/schema.js';

// Loaded through require so the bundler leaves the builtin alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
  };
  close(): void;
}

const SQL_DIR = fileURLToPath(
  new URL('../../../../shared/sql-library/', import.meta.url),
);

function librarySql(id: string): string {
  return readFileSync(`${SQL_DIR}${id}.sql`, 'utf8');
}

/** The two MySQL date forms the DHC files use, rewritten for SQLite. */
function toSqlite(sql: string): string {
  return sql
    .replace(
      /DATE_SUB\(\s*([^,()]+?)\s*,\s*INTERVAL\s+([^()]+?)\s+DAY\s*\)/g,
      "date($1, '-' || ($2) || ' days')",
    )
    .replace(/\bLEAST\(/g, 'MIN(');
}

const SELLER = 555;
const OTHER_SELLER = 777;

function vcContext(): BrandContext {
  return {
    schema_version: 1,
    brand_slug: 'vcbrand',
    brand_name: 'VC Brand',
    last_updated: '2026-11-24',
    accounts: [
      {
        seller_id: SELLER,
        seller_name: 'Vendor Co',
        account_type: 'VC',
        status: 'active',
        role: 'primary',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'vendor_sales_manufacturing_asin',
      ops_revenue_field: 'OrderedRevenueAmount',
      ops_units_field: 'OrderedUnits',
      ops_date_field: 'DateTime',
    },
    management: {
      primary_metric: 'TACOS',
      acos_target_pct: 20,
      attribution_window_days: 14,
    },
  } as BrandContext;
}

function scContext(): BrandContext {
  const ctx = vcContext();
  ctx.accounts = [
    {
      seller_id: SELLER,
      seller_name: 'Seller Co',
      account_type: 'SC',
      status: 'active',
      role: 'primary',
    },
  ] as BrandContext['accounts'];
  return ctx;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function shift(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) out.push(d);
  return out;
}

// Distinct per-day values, so a window that is off by even one day sums to
// a different number.
function revenueOn(day: string): number {
  return 1000 + Number(day.slice(8, 10)) * 10 + Number(day.slice(5, 7));
}
function spendOn(day: string): number {
  return 100 + Number(day.slice(8, 10)) + Number(day.slice(5, 7)) / 10;
}

interface Fixture {
  db: SqliteDb;
  revenue: Map<string, number>;
  spend: Map<string, number>;
}

/**
 * Spend loads through `spendThrough` (normally yesterday). VC revenue loads
 * through `vcThrough` (or not at all when null). Another seller has VC rows
 * right up to yesterday, which the seller filter must ignore.
 */
function makeFixture(opts: {
  from: string;
  spendThrough: string;
  vcThrough: string | null;
  otherSellerVcThrough?: string;
  scSalesThrough?: string;
}): Fixture {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE vendor_sales_manufacturing_asin (
      SellerID INTEGER, DateTime TEXT, Asin TEXT, OrderedRevenueAmount REAL);
    CREATE TABLE campaignmetric (
      SellerID INTEGER, DateTime TEXT, CampaignId INTEGER, Cost REAL, Sales REAL, Orders INTEGER);
    CREATE TABLE business_reports_dpst_date (
      SellerID INTEGER, DateTime TEXT, SalesAmount REAL);
  `);
  const insVc = db.prepare(
    'INSERT INTO vendor_sales_manufacturing_asin VALUES (?, ?, ?, ?)',
  );
  const insCm = db.prepare('INSERT INTO campaignmetric VALUES (?, ?, ?, ?, ?, ?)');
  const insBr = db.prepare('INSERT INTO business_reports_dpst_date VALUES (?, ?, ?)');
  const revenue = new Map<string, number>();
  const spend = new Map<string, number>();

  for (const day of daysBetween(opts.from, opts.spendThrough)) {
    // Two campaigns per day; the day's spend is their sum.
    const s = spendOn(day);
    insCm.run(SELLER, day, 1, s * 0.6, s * 3, 4);
    insCm.run(SELLER, day, 2, s * 0.4, s * 2, 3);
    insCm.run(OTHER_SELLER, day, 9, 999, 999, 9);
    spend.set(day, s);
  }
  if (opts.vcThrough) {
    for (const day of daysBetween(opts.from, opts.vcThrough)) {
      // Two ASINs per day; the day's revenue is their sum.
      const r = revenueOn(day);
      insVc.run(SELLER, day, 'B000000001', r * 0.75);
      insVc.run(SELLER, day, 'B000000002', r * 0.25);
      revenue.set(day, r);
    }
  }
  for (const day of daysBetween(opts.from, opts.otherSellerVcThrough ?? opts.from)) {
    insVc.run(OTHER_SELLER, day, 'B000000009', 50000);
  }
  if (opts.scSalesThrough) {
    for (const day of daysBetween(opts.from, opts.scSalesThrough)) {
      insBr.run(SELLER, day, revenueOn(day));
    }
  }
  return { db, revenue, spend };
}

function runLibrary(
  db: SqliteDb,
  id: string,
  context: BrandContext,
  runDate: string,
): Record<string, unknown> {
  const params = buildStandardParams({ context, runDate });
  const { sql, params: bound } = substituteParams(librarySql(id), params);
  const row = db.prepare(toSqlite(sql)).get(bound);
  if (!row) throw new Error(`${id} returned no row`);
  return row;
}

function sumOver(values: Map<string, number>, from: string, to: string): number {
  let total = 0;
  for (const day of daysBetween(from, to)) total += values.get(day) ?? 0;
  return total;
}

describe('DHC-03 VC windows follow the latest loaded VC date (mx-ops#408)', () => {
  // run_date 2026-11-24: yesterday 11-23, spend loaded through 11-23,
  // VC revenue loaded only through 11-20 = run_date - 4.
  const RUN_DATE = '2026-11-24';
  const VC_LATEST = '2026-11-20';

  it('ends T-1, T-7, T-30 and MTD for revenue and spend on the same date', () => {
    const fx = makeFixture({
      from: '2026-09-15',
      spendThrough: '2026-11-23',
      vcThrough: VC_LATEST,
      otherSellerVcThrough: '2026-11-23',
    });
    try {
      const row = runLibrary(fx.db, 'DHC-03', vcContext(), RUN_DATE);
      expect(row.vc_window_end).toBe(VC_LATEST);

      const windows = [
        { rev: 'ordered_rev_t1', spend: 'spend_t1_vc_window', from: VC_LATEST },
        { rev: 'ordered_rev_t7_total', spend: 'spend_t7_vc_window', from: '2026-11-14' },
        { rev: 'ordered_rev_t30_total', spend: 'spend_t30_vc_window', from: '2026-10-22' },
        { rev: 'ordered_rev_mtd', spend: 'spend_mtd_vc_window', from: '2026-11-01' },
      ];
      for (const w of windows) {
        const expectedRev = sumOver(fx.revenue, w.from, VC_LATEST);
        const expectedSpend = sumOver(fx.spend, w.from, VC_LATEST);
        expect(row[w.rev], w.rev).toBeCloseTo(expectedRev, 6);
        expect(row[w.spend], w.spend).toBeCloseTo(expectedSpend, 6);
        // TACoS over matching days: spend and revenue of the same dates.
        const tacos = (Number(row[w.spend]) / Number(row[w.rev])) * 100;
        expect(tacos, `${w.rev} TACoS`).toBeCloseTo(
          (expectedSpend / expectedRev) * 100,
          9,
        );
      }

      // The T-1 revenue day is a loaded day, not an empty one.
      expect(Number(row.ordered_rev_t1)).toBeGreaterThan(0);
      // Window lengths in days: 1, 7, 30, and 1..20 for MTD.
      expect(daysBetween('2026-11-14', VC_LATEST)).toHaveLength(7);
      expect(daysBetween('2026-10-22', VC_LATEST)).toHaveLength(30);
    } finally {
      fx.db.close();
    }
  });

  it('bounds MTD spend at the VC window end, not at yesterday', () => {
    const fx = makeFixture({
      from: '2026-09-15',
      spendThrough: '2026-11-23',
      vcThrough: VC_LATEST,
    });
    try {
      const row = runLibrary(fx.db, 'DHC-03', vcContext(), RUN_DATE);
      const spendThroughYesterday = sumOver(fx.spend, '2026-11-01', '2026-11-23');
      expect(Number(row.spend_mtd_vc_window)).toBeLessThan(spendThroughYesterday);
      expect(Number(row.spend_mtd_vc_window)).toBeCloseTo(
        sumOver(fx.spend, '2026-11-01', VC_LATEST),
        6,
      );
    } finally {
      fx.db.close();
    }
  });

  it('uses the newest loaded day when VC is only one day behind spend', () => {
    // VC through run_date - 2: the old fixed lag skipped this day.
    const fx = makeFixture({
      from: '2026-09-15',
      spendThrough: '2026-11-23',
      vcThrough: '2026-11-22',
    });
    try {
      const row = runLibrary(fx.db, 'DHC-03', vcContext(), RUN_DATE);
      expect(row.vc_window_end).toBe('2026-11-22');
      expect(row.ordered_rev_t1).toBeCloseTo(revenueOn('2026-11-22'), 6);
      expect(row.spend_t1_vc_window).toBeCloseTo(spendOn('2026-11-22'), 6);
    } finally {
      fx.db.close();
    }
  });

  it('returns NULL MTD on both sides when no VC day of the month has loaded', () => {
    // run_date 2026-12-02, VC through 11-28: nothing loaded for December.
    const fx = makeFixture({
      from: '2026-10-01',
      spendThrough: '2026-12-01',
      vcThrough: '2026-11-28',
    });
    try {
      const row = runLibrary(fx.db, 'DHC-03', vcContext(), '2026-12-02');
      expect(row.vc_window_end).toBe('2026-11-28');
      expect(row.ordered_rev_mtd).toBeNull();
      expect(row.spend_mtd_vc_window).toBeNull();
      expect(row.ordered_rev_t7_total).toBeCloseTo(
        sumOver(fx.revenue, '2026-11-22', '2026-11-28'),
        6,
      );
    } finally {
      fx.db.close();
    }
  });

  it('falls back to run_date - vc_lag only when no VC row has loaded', () => {
    const fx = makeFixture({
      from: '2026-09-15',
      spendThrough: '2026-11-23',
      vcThrough: null,
      otherSellerVcThrough: '2026-11-23',
    });
    try {
      const row = runLibrary(fx.db, 'DHC-03', vcContext(), RUN_DATE);
      expect(row.vc_window_end).toBe('2026-11-22');
      expect(row.ordered_rev_t1).toBe(0);
      expect(row.spend_t1_vc_window).toBeCloseTo(spendOn('2026-11-22'), 6);
    } finally {
      fx.db.close();
    }
  });
});

describe('DHC-02 SC windows are unchanged by mx-ops#408', () => {
  it('still ends every SC window at yesterday - 1 day', () => {
    const fx = makeFixture({
      from: '2026-09-15',
      spendThrough: '2026-11-23',
      vcThrough: null,
      scSalesThrough: '2026-11-23',
    });
    try {
      const row = runLibrary(fx.db, 'DHC-02', scContext(), '2026-11-24');
      const sales = new Map(
        daysBetween('2026-09-15', '2026-11-23').map((d) => [d, revenueOn(d)]),
      );
      expect(row.total_sales_t1).toBeCloseTo(revenueOn('2026-11-22'), 6);
      expect(row.total_sales_t7_total).toBeCloseTo(
        sumOver(sales, '2026-11-16', '2026-11-22'),
        6,
      );
      expect(row.total_sales_t30_total).toBeCloseTo(
        sumOver(sales, '2026-10-24', '2026-11-22'),
        6,
      );
      expect(row.total_sales_mtd_tacos).toBeCloseTo(
        sumOver(sales, '2026-11-01', '2026-11-22'),
        6,
      );
    } finally {
      fx.db.close();
    }
  });
});
