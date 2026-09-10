import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadTablesCatalog, describeTable } from './tables-catalog.js';

// ---------------------------------------------------------------------------
// Catalog column annotations (mx-ops#51)
//
// Agents were guessing date and money column names on the metric and
// business-report tables: 18 humans across 12 tenants over 30 days, on current
// versions. The cause was structural rather than a wrong entry -- the runtime
// catalog (`data-tables.yaml`) carried a description and ONE `date_column` and
// nothing else, so `data describe` could not name a money or ASIN column even
// though the repo's schema dump has held every column all along. These tests
// guard the annotations that closed that gap, and guard them against typos,
// which would be worse than no annotation at all.
// ---------------------------------------------------------------------------

/** The schema dump (`shared/tables.yaml`), used ONLY as an offline cross-check
 *  that an annotation names a column that really exists. It is not the runtime
 *  catalog and nothing reads it at runtime. */
async function loadSchemaDumpColumns(): Promise<Record<string, Set<string>>> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'shared', 'tables.yaml');
    try {
      const raw = await readFile(candidate, 'utf8');
      const parsed = parseYaml(raw) as {
        tables?: Record<string, { columns?: Array<{ name?: string }> }>;
      };
      const out: Record<string, Set<string>> = {};
      for (const [table, meta] of Object.entries(parsed.tables ?? {})) {
        out[table] = new Set((meta.columns ?? []).map((c) => c.name).filter((n): n is string => !!n));
      }
      return out;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('shared/tables.yaml not found walking up from the test file');
}

describe('table catalog column annotations', () => {
  it('carries key_columns and gotchas through the loader', async () => {
    const sku = await describeTable('business_reports_dpst_sku');
    expect(sku).not.toBeNull();
    expect(sku?.key_columns?.sales).toBe('Amount');
    expect(sku?.key_columns?.asin).toBe('ChildAsin');
    expect(sku?.gotchas?.length).toBeGreaterThan(0);
  });

  it('names the sibling-table money split on BOTH tables, since that is the trap', async () => {
    // business_reports_dpst_date calls it SalesAmount; its SKU-level sibling
    // calls the same thing Amount. A caller who learns one and assumes the
    // other is exactly the observed failure, so each entry has to warn.
    const byDate = await describeTable('business_reports_dpst_date');
    const bySku = await describeTable('business_reports_dpst_sku');
    expect(byDate?.key_columns?.sales).toBe('SalesAmount');
    expect(bySku?.key_columns?.sales).toBe('Amount');
    expect(byDate?.gotchas?.join(' ')).toMatch(/Amount/);
    expect(bySku?.gotchas?.join(' ')).toMatch(/SalesAmount/);
  });

  it('warns that no table has a `Date` column, on every annotated table', async () => {
    // Live failures used `Date` on both business_reports_dpst_date and
    // campaignmetric. Neither has it.
    for (const table of ['campaignmetric', 'business_reports_dpst_date', 'business_reports_dpst_sku']) {
      const meta = await describeTable(table);
      expect(meta?.date_column, `${table} must declare its date column`).toBeTruthy();
      expect(meta?.gotchas?.join(' '), `${table} must warn about \`Date\``).toMatch(/no `Date`/);
    }
  });

  it('every annotated column actually exists in the schema dump', async () => {
    // The guard that matters: a typo here ships a confident wrong answer, which
    // is worse than the silence it replaced.
    const schema = await loadSchemaDumpColumns();
    const catalog = await loadTablesCatalog();
    const checked: string[] = [];

    for (const table of catalog) {
      const columns = schema[table.name];
      if (!columns || columns.size === 0) continue; // not in the dump; nothing to check against
      const named = [
        ...(table.date_column ? [table.date_column] : []),
        ...Object.values(table.key_columns ?? {}),
      ];
      for (const col of named) {
        expect(columns.has(col), `${table.name}.${col} is named by the catalog but absent from the schema dump`).toBe(true);
        checked.push(`${table.name}.${col}`);
      }
    }

    // Guard the guard: if the walk-up or the parse silently returned nothing,
    // every expect above is vacuous and the test would pass while checking zero.
    expect(checked.length).toBeGreaterThan(10);
  });
});
