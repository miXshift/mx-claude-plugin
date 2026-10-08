import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import { describeTable } from './tables-catalog.js';
import { getQueryEntry, resetCatalogCache } from '../prefetch/sql-library.js';
import { pluginPath } from '../prefetch/plugin-root.js';

// Search Query Performance guidance: the three sqp_* tables must carry the
// "query-level columns repeat on every ASIN row" rule, and the ready-made
// library query must implement the safe pattern (MAX per query per week, SUM
// of the Asin*Count columns, shares from counts, periods on StartDate).

describe('SQP table guidance', () => {
  for (const name of ['sqp_weekly', 'sqp_monthly', 'sqp_quarterly']) {
    it(`${name} warns against summing query-level columns across ASINs`, async () => {
      const t = await describeTable(name);
      expect(t).not.toBeNull();
      expect(t!.description).toMatch(/never SUM/i);
      expect(t!.description).toContain('SearchQueryVolume');
      expect(t!.description).toContain('LIB-SQP-01');
      expect(t!.description).not.toMatch(/search-term demand/i);
      expect(t!.gotchas?.length).toBeGreaterThan(0);
    });
  }
});

describe('LIB-SQP-01', () => {
  beforeEach(() => resetCatalogCache());

  it('is registered and its file exists', async () => {
    const entry = await getQueryEntry('LIB-SQP-01');
    expect(entry.file).toBe('LIB-SQP-01.sql');
    const sql = await readFile(pluginPath('shared', 'sql-library', entry.file!), 'utf8');
    expect(sql).toContain('-- ID: LIB-SQP-01');
  });

  it('counts query-level columns once and never sums the share percent columns', async () => {
    const sql = await readFile(pluginPath('shared', 'sql-library', 'LIB-SQP-01.sql'), 'utf8');
    const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).toMatch(/MAX\(SearchQueryVolume\)/);
    expect(code).toMatch(/MAX\(TotalClickCount\)/);
    expect(code).toMatch(/SUM\(AsinClickCount\)/);
    expect(code).toMatch(/GROUP BY SearchQuery, StartDate/);
    expect(code).not.toMatch(/SUM\(\s*SearchQueryVolume/);
    expect(code).not.toMatch(/Share\b/); // Asin*Share columns are never read
    expect(code).not.toMatch(/ReportDate/); // periods key on StartDate
    expect(code).toMatch(/NULLIF\(/); // zero totals give NULL, not a divide error
  });
});
