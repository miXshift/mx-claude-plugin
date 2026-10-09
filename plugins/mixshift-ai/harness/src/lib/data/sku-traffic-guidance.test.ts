import { describe, it, expect, beforeEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

import { describeTable } from './tables-catalog.js';
import { getQueryEntry, resetCatalogCache } from '../prefetch/sql-library.js';
import { pluginPath } from '../prefetch/plugin-root.js';

// SKU-level Sales & Traffic guidance: Amazon reports traffic (sessions, page
// views, Buy Box) per product (ASIN) and the SKU-level table repeats it on
// each SKU row of the product for the day, while sales and units are each
// SKU's own. Every total of traffic from business_reports_dpst_sku counts each
// product once per day: MAX per (SellerID, ChildAsin, day), SUM of the sales
// columns, then the days added up.

/** The per-product traffic columns of business_reports_dpst_sku. */
const TRAFFIC_COLS = [
  'Sessions', 'BrowserSessions', 'MobileAppSessions',
  'PageViews', 'BrowserPageViews', 'MobileAppPageViews',
  'BuyBoxPercentage',
  'SessionPercentage', 'BrowserSessionPercentage', 'MobileAppSessionPercentage',
  'PageViewsPercentage', 'BrowserPageViewsPercentage', 'MobileAppPageViewsPercentage',
];
const COLS = TRAFFIC_COLS.join('|');
const TRAFFIC = new RegExp(`\\b(${COLS})\\b`);
/** The per-product-per-day key, on whatever alias the raw table carries. */
const ITEM_DAY_KEY = /GROUP BY\s+(\w+)\.SellerID,\s*\1\.ChildAsin,\s*DATE\(\1\.DateTime\)/;

const code = (sql: string): string =>
  sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const comments = (sql: string): string =>
  sql
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('--'))
    .join('\n');

async function librarySql(file: string): Promise<string> {
  return readFile(pluginPath('shared', 'sql-library', file), 'utf8');
}

/** Words that would describe how Amazon delivers the report as a fault. */
const FAULT_WORDS = /overstat|over-?count|double[- ]count|inflat|\bbug\b|\berror\b|wrong|incorrect|mistake|duplicat/i;

describe('business_reports_dpst_sku table guidance', () => {
  it('names every per-product traffic column, the additive sales columns and the per-SKU ratios', async () => {
    const t = await describeTable('business_reports_dpst_sku');
    expect(t).not.toBeNull();
    expect(t!.description).toMatch(/per product \(ASIN\)/);
    expect(t!.description).toMatch(/MAX them per \(SellerID, ChildAsin, day\)/);
    expect(t!.description).toContain('LIB-TRAFFIC-01');
    const gotchas = t!.gotchas!.join(' ');
    for (const col of [...TRAFFIC_COLS, 'AmountB2B', 'UnitsOrderedB2B', 'TotalOrderItemsB2B', 'UnitSessionPercentage', 'UnitSessionPercentageB2B']) {
      expect(gotchas, col).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(gotchas).toMatch(/SUM\(BuyBoxPercentage \* PageViews\) \/ SUM\(PageViews\)/);
    expect(gotchas).toMatch(/Keep SellerID in the key/);
    expect(gotchas).toMatch(/best single day/);
    expect(gotchas).toMatch(/Selling days only/);
    expect(gotchas).toMatch(/never by adding the SKU rows/);
    expect(gotchas).toMatch(/business_reports_dpst_date/);
  });
});

describe('wording: how Amazon delivers the report, never a fault in it', () => {
  it('holds across the table notes, both queries, their catalog entries and the changelog fragment', async () => {
    const t = await describeTable('business_reports_dpst_sku');
    const catalog = await readFile(pluginPath('shared', 'sql-library', 'catalog.yaml'), 'utf8');
    const entry = (id: string) => catalog.slice(catalog.indexOf(`- id: ${id}\n`), catalog.indexOf('\n\n', catalog.indexOf(`- id: ${id}\n`)));
    // The fragment is folded into CHANGELOG.md and deleted at the release cut.
    const fragment = await readFile(pluginPath('..', '..', 'changelog.d', 'changed-traffic-once-per-product.md'), 'utf8').catch(() => null);
    const texts: Record<string, string> = {
      'data-tables': [t!.description, ...(t!.gotchas ?? [])].join(' '),
      'LIB-TRAFFIC-01.sql': comments(await librarySql('LIB-TRAFFIC-01.sql')),
      'LIB-PT-01.sql': comments(await librarySql('LIB-PT-01.sql')),
      'catalog LIB-TRAFFIC-01': entry('LIB-TRAFFIC-01'),
      'catalog LIB-PT-01': entry('LIB-PT-01'),
      ...(fragment === null ? {} : { fragment }),
    };
    for (const [where, text] of Object.entries(texts)) {
      expect(text.length, where).toBeGreaterThan(50);
      expect(text, where).not.toMatch(FAULT_WORDS);
    }
  });
});

describe('LIB-TRAFFIC-01', () => {
  beforeEach(() => resetCatalogCache());

  it('is registered and its file exists', async () => {
    const entry = await getQueryEntry('LIB-TRAFFIC-01');
    expect(entry.file).toBe('LIB-TRAFFIC-01.sql');
    expect(await librarySql(entry.file!)).toContain('-- ID: LIB-TRAFFIC-01');
  });

  it('collapses to one row per product per day before adding the days up', async () => {
    const sql = code(await librarySql('LIB-TRAFFIC-01.sql'));
    expect(sql).toMatch(ITEM_DAY_KEY);
    for (const c of ['Sessions', 'PageViews', 'BuyBoxPercentage']) expect(sql).toContain(`MAX(s.${c})`);
    for (const c of ['UnitsOrdered', 'Amount']) expect(sql).toContain(`SUM(s.${c})`);
    expect(sql).toMatch(/SUM\(d\.BuyBoxPercentage \* d\.PageViews\)\s*\/ NULLIF\(SUM\(d\.PageViews\), 0\)/);
    expect(sql).toMatch(/SUM\(d\.UnitsOrdered\) \/ NULLIF\(SUM\(d\.Sessions\), 0\)/);
    expect(sql).toContain(':asin IS NULL OR s.ChildAsin = :asin');
    expect(sql).toMatch(/GROUP BY d\.ChildAsin/);
    expect(sql).toMatch(/ORDER BY sessions DESC, asin/); // deterministic paging
  });

  it('labels the conversion and Buy Box columns as selling-day figures and shows the coverage', async () => {
    const sql = code(await librarySql('LIB-TRAFFIC-01.sql'));
    expect(sql).toContain('AS unit_session_pct_selling_days');
    expect(sql).toContain('AS buy_box_pct_selling_days');
    expect(sql).toContain('AS days_with_sales');
    expect(sql).toMatch(/DATEDIFF\(:end_date, :start_date\) \+ 1\s+AS days_in_range/);
    expect(sql).not.toMatch(/AS (unit_session_pct|buy_box_pct)\b/);
  });
});

describe('LIB-PT-01', () => {
  it('keeps its output columns, counts each product once per day and adds the days per window', async () => {
    const sql = code(await librarySql('LIB-PT-01.sql'));
    for (const col of ['AS Title', 'd.ChildAsin', 'AS sales_prior', 'AS sales_test', 'AS units_prior', 'AS units_test', 'AS sessions_prior', 'AS sessions_test']) {
      expect(sql, col).toContain(col);
    }
    expect(sql).toMatch(ITEM_DAY_KEY);
    expect(sql).toContain('MAX(s.Sessions)');
    expect(sql).toContain('SUM(s.UnitsOrdered)');
    expect(sql).toContain('SUM(s.Amount)');
    for (const w of ['prior', 'test']) {
      expect(sql, w).toMatch(new RegExp(`SUM\\(CASE WHEN d\\.DateTime BETWEEN :${w}_start\\s+AND :${w}_end\\s+THEN d\\.Sessions`));
    }
    expect(sql).toMatch(/GROUP BY d\.ChildAsin/);
    expect(sql).toContain('s.Title LIKE :title_pattern');
    // Only the two windows enter the per-day collapse.
    expect(sql).toMatch(/s\.DateTime BETWEEN :prior_start AND :prior_end\s+OR s\.DateTime BETWEEN :test_start AND :test_end/);
  });
});

describe('every library query that totals SKU-level traffic', () => {
  it('collapses business_reports_dpst_sku to one row per product per day first, and never reads raw traffic otherwise', async () => {
    const dir = pluginPath('shared', 'sql-library');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const readers: string[] = [];
    for (const f of files) {
      const sql = code(await readFile(`${dir}/${f}`, 'utf8'));
      if (!sql.includes('business_reports_dpst_sku') || !TRAFFIC.test(sql)) continue;
      readers.push(f);
      const key = sql.match(ITEM_DAY_KEY);
      expect(key, f).not.toBeNull();
      const raw = key![1]!;
      expect(sql, f).toMatch(new RegExp(`business_reports_dpst_sku\\s+${raw}\\b`));
      // The derived table the collapse feeds: `) d` right after the GROUP BY.
      const collapsed = sql.slice(key!.index!).match(/\)\s*\)\s*(\w+)/)?.[1];
      expect(collapsed, f).toBeTruthy();
      // Strip the allowed reads: MAX of a raw traffic column, its alias, and
      // reads of the collapsed rows. Any other read of a traffic column, bare,
      // backticked or under any other alias, is a total taken straight across
      // SKU rows.
      const rest = sql
        .replace(new RegExp(`MAX\\(${raw}\\.(${COLS})\\)`, 'g'), '')
        .replace(new RegExp(`\\bAS\\s+(${COLS})\\b`, 'g'), '')
        .replace(new RegExp(`\\b${collapsed}\\.(${COLS})\\b`, 'g'), '');
      expect(rest, f).not.toMatch(new RegExp(`\\b(${COLS})\\b`));
      expect(sql, f).not.toMatch(/UnitSessionPercentage/); // per SKU: never MAX, SUM or average
    }
    expect(readers.sort()).toEqual(['LIB-PT-01.sql', 'LIB-TRAFFIC-01.sql']);
  });
});
