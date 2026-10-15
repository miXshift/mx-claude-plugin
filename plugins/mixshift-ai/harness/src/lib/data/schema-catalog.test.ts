/**
 * The shipped catalog really loads offline, and carries the tables the
 * pre-send column check needs (the ones agents guess columns on most).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSchemaCatalog, loadedSchemaCatalog, parseDumpColumns, _resetSchemaCatalogCache } from './schema-catalog.js';

beforeEach(() => _resetSchemaCatalogCache());

describe('parseDumpColumns', () => {
  it('reads the generated dump shape with a line scan (CRLF and comments included)', () => {
    const text = [
      '# Canonical schema for warehouse tables.',
      'tables:',
      '  seller:',
      '    columns:',
      '      - { name: ID, type: "int" }',
      '      - { name: Name, type: "varchar(100)" }',
      '  campaign_metric_3mo:',
      '    columns:',
      '      - { name: Cost, type: "decimal(10,2)" }',
      '',
    ].join('\r\n');
    const t0 = performance.now();
    const out = parseDumpColumns(text);
    expect(performance.now() - t0).toBeLessThan(20);
    expect([...out.keys()]).toEqual(['seller', 'campaign_metric_3mo']);
    expect(out.get('seller')).toEqual(['ID', 'Name']);
    expect(out.get('campaign_metric_3mo')).toEqual(['Cost']);
  });

  it('falls back to the YAML parser for a dump in another shape, and to empty for garbage', () => {
    const block = 'tables:\n  seller:\n    columns:\n      - name: ID\n        type: int\n      - name: Name\n        type: varchar\n';
    expect(parseDumpColumns(block).get('seller')).toEqual(['ID', 'Name']);
    expect(parseDumpColumns('tables: [not: a: map').size).toBe(0);
    expect(parseDumpColumns('').size).toBe(0);
  });

  it('the shipped dump parses by the fast path and matches the YAML parser column for column', async () => {
    const { readFile } = await import('node:fs/promises');
    const { parse } = await import('yaml');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    let dir = dirname(fileURLToPath(import.meta.url));
    let text: string | null = null;
    for (let i = 0; i < 8 && text === null; i++) {
      text = await readFile(join(dir, 'shared', 'tables.yaml'), 'utf-8').catch(() => null);
      dir = dirname(dir);
    }
    expect(text).not.toBeNull();
    const fast = parseDumpColumns(text!);
    const slow = parse(text!) as { tables: Record<string, { columns: Array<{ name: string }> }> };
    expect([...fast.keys()]).toEqual(Object.keys(slow.tables));
    for (const [name, meta] of Object.entries(slow.tables)) {
      expect(fast.get(name), name).toEqual(meta.columns.map((c) => c.name));
    }
  });
});

describe('loadSchemaCatalog', () => {
  it('finds shared/tables.yaml + data-tables.yaml from the harness and merges them', async () => {
    expect(loadedSchemaCatalog()).toBeNull();
    const cat = await loadSchemaCatalog();
    expect(loadedSchemaCatalog()).toBe(cat);
    for (const t of ['seller', 'campaignmetric', 'business_reports_dpst_sku', 'business_reports_dpst_date', 'mws_items', 'mws_inventory_history', 'productadmetric', 'campaign']) {
      expect(cat.get(t)?.columns.length, t).toBeGreaterThan(10);
    }
    const seller = cat.get('seller')!;
    expect(seller.columns).toContain('Name');
    expect(seller.columns).not.toContain('SellerName');
    expect(seller.gotchas.join(' ')).toMatch(/SellerName/);
    const cm = cat.get('campaignmetric')!;
    expect(cm.columns).toContain('Cost');
    expect(cm.keyColumns.spend).toBe('Cost');
    // Curated-only tables have no column list and are not checkable.
    expect(cat.has('sponsoredbrandsmetric')).toBe(false);
  });

  it('is cached per process', async () => {
    const a = await loadSchemaCatalog();
    const b = await loadSchemaCatalog();
    expect(a).toBe(b);
  });

  it('yields an empty catalog for a missing or broken file instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mixshift-schema-cat-'));
    expect((await loadSchemaCatalog(dir)).size).toBe(0);
    await writeFile(join(dir, 'tables.yaml'), 'tables: [not: a: map', 'utf-8');
    expect((await loadSchemaCatalog(dir)).size).toBe(0);
    await writeFile(join(dir, 'tables.yaml'), 'tables:\n  t:\n    columns:\n      - { name: A }\n      - { name: B }\n', 'utf-8');
    const cat = await loadSchemaCatalog(dir);
    expect(cat.get('t')).toEqual({ name: 't', columns: ['A', 'B'], keyColumns: {}, gotchas: [] });
  });
});
