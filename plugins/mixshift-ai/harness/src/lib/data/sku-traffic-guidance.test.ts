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

const ITEM_DAY_KEY = /GROUP BY s\.SellerID, s\.ChildAsin, DATE\(s\.DateTime\)/;
const TRAFFIC = /\b(Sessions|PageViews|BuyBoxPercentage|BrowserSessions|MobileAppSessions|BrowserPageViews|MobileAppPageViews)\b/;

const code = (sql: string): string =>
  sql
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

async function librarySql(file: string): Promise<string> {
  return readFile(pluginPath('shared', 'sql-library', file), 'utf8');
}

describe('business_reports_dpst_sku table guidance', () => {
  it('says traffic is per product and is counted once per product per day', async () => {
    const t = await describeTable('business_reports_dpst_sku');
    expect(t).not.toBeNull();
    expect(t!.description).toMatch(/per product \(ASIN\)/);
    expect(t!.description).toMatch(/MAX them per \(SellerID, ChildAsin, day\)/);
    expect(t!.description).toContain('LIB-TRAFFIC-01');
    const gotchas = t!.gotchas!.join(' ');
    for (const col of ['Sessions', 'PageViews', 'BuyBoxPercentage', 'Browser*', 'MobileApp*', '*Percentage', 'UnitSessionPercentage']) {
      expect(gotchas, col).toContain(col);
    }
    expect(gotchas).toMatch(/SUM\(BuyBoxPercentage \* PageViews\) \/ SUM\(PageViews\)/);
    expect(gotchas).toMatch(/Keep SellerID in the key/);
    expect(gotchas).toMatch(/best single day/);
    expect(gotchas).toMatch(/business_reports_dpst_date/);
  });

  it('describes how Amazon delivers the report, not a fault in it', async () => {
    const t = await describeTable('business_reports_dpst_sku');
    const text = [t!.description, ...(t!.gotchas ?? [])].join(' ');
    expect(text).not.toMatch(/overstat|double[- ]count|inflat|\bbug\b|\berror\b|wrong/i);
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
    expect(sql).not.toMatch(/SUM\(s\.(Sessions|PageViews|BuyBoxPercentage)\)/);
    expect(sql).toMatch(/SUM\(d\.BuyBoxPercentage \* d\.PageViews\)\s*\/ NULLIF\(SUM\(d\.PageViews\), 0\)/);
    expect(sql).toMatch(/SUM\(d\.UnitsOrdered\) \/ NULLIF\(SUM\(d\.Sessions\), 0\)/);
    expect(sql).not.toContain('UnitSessionPercentage'); // per SKU, never averaged
    expect(sql).toContain(':asin IS NULL OR s.ChildAsin = :asin');
    expect(sql).toMatch(/GROUP BY d\.ChildAsin/);
  });
});

describe('LIB-PT-01', () => {
  it('keeps its output columns and counts each product once per day', async () => {
    const sql = code(await librarySql('LIB-PT-01.sql'));
    for (const col of ['AS Title', 'd.ChildAsin', 'AS sales_prior', 'AS sales_test', 'AS units_prior', 'AS units_test', 'AS sessions_prior', 'AS sessions_test']) {
      expect(sql, col).toContain(col);
    }
    expect(sql).toMatch(ITEM_DAY_KEY);
    expect(sql).toContain('MAX(s.Sessions)');
    expect(sql).toContain('SUM(s.UnitsOrdered)');
    expect(sql).toContain('SUM(s.Amount)');
    expect(sql).toMatch(/GROUP BY d\.ChildAsin/);
    expect(sql).toContain('s.Title LIKE :title_pattern');
  });
});

describe('every library query that totals SKU-level traffic', () => {
  it('collapses business_reports_dpst_sku to one row per product per day first', async () => {
    const dir = pluginPath('shared', 'sql-library');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const readers: string[] = [];
    for (const f of files) {
      const sql = code(await readFile(`${dir}/${f}`, 'utf8'));
      if (!sql.includes('business_reports_dpst_sku') || !TRAFFIC.test(sql)) continue;
      readers.push(f);
      expect(sql, f).toMatch(ITEM_DAY_KEY);
      // Never summed straight over the raw rows (alias `s` or unqualified).
      expect(sql, f).not.toMatch(/SUM\(\s*(?:s\.)?(Sessions|PageViews|BuyBoxPercentage)\s*\)/);
    }
    expect(readers.sort()).toEqual(['LIB-PT-01.sql', 'LIB-TRAFFIC-01.sql']);
  });
});
