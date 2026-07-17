import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReportCatalog, findReportType } from './catalog.js';

/**
 * The loader has two jobs: (1) load + normalize the real shipped catalog via
 * the walk-up, and (2) behave well on overrides / missing files. We test both,
 * and we assert some invariants on the real catalog so a malformed edit to the
 * YAML fails CI rather than silently shipping.
 */

async function withTempCatalog<T>(
  yaml: string | null,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mx-report-catalog-'));
  const path = join(dir, 'catalog.yaml');
  try {
    if (yaml !== null) await writeFile(path, yaml, 'utf-8');
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('loadReportCatalog — real shipped catalog', () => {
  it('parses and returns a non-trivial number of entries', async () => {
    const all = await loadReportCatalog();
    // No exclusions by design — this should be a big list, not a stub.
    expect(all.length).toBeGreaterThan(40);
  });

  it('every entry has the wire-critical fields populated', async () => {
    const all = await loadReportCatalog();
    for (const e of all) {
      expect(e.reportType, 'reportType missing').toBeTruthy();
      expect(e.reportType.startsWith('GET_'), `unexpected reportType ${e.reportType}`).toBe(true);
      expect(e.title, `title missing for ${e.reportType}`).toBeTruthy();
      expect(['seller', 'vendor', 'both']).toContain(e.appliesTo);
      expect(['tsv', 'json']).toContain(e.documentFormat);
      expect(['required', 'optional', 'forbidden']).toContain(e.window);
      expect(['have', 'partial', 'none']).toContain(e.warehouseCoverage);
    }
  });

  it('has no duplicate report types', async () => {
    const all = await loadReportCatalog();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of all) {
      if (seen.has(e.reportType)) dupes.push(e.reportType);
      seen.add(e.reportType);
    }
    expect(dupes).toEqual([]);
  });

  it('includes the non-PII order reports (no exclusions)', async () => {
    const all = await loadReportCatalog();
    const types = all.map((e) => e.reportType);
    // These are the order/returns reports we deliberately do NOT pre-exclude;
    // Amazon rejects reactively as restricted_report if a PII variant is asked.
    expect(types).toContain('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL');
    expect(types).toContain('GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA');
  });

  it('includes both vendor (JSON) and brand-analytics (JSON) report types', async () => {
    const all = await loadReportCatalog();
    const vendor = all.find((e) => e.reportType === 'GET_VENDOR_SALES_REPORT');
    expect(vendor?.appliesTo).toBe('vendor');
    expect(vendor?.documentFormat).toBe('json');

    const ba = all.find((e) => e.reportType === 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT');
    expect(ba?.documentFormat).toBe('json');
    expect(ba?.reportOptions.some((o) => o.key === 'reportPeriod')).toBe(true);
  });

  it('documents SQP as requiring BOTH reportPeriod and asin (Amazon FATALs the report without asin)', async () => {
    const all = await loadReportCatalog();
    const sqp = all.find(
      (e) => e.reportType === 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    );
    expect(sqp).toBeTruthy();
    expect(sqp?.documentFormat).toBe('json');
    expect(sqp?.reportOptions.some((o) => o.key === 'reportPeriod')).toBe(true);
    const asinOpt = sqp?.reportOptions.find((o) => o.key === 'asin');
    expect(asinOpt, 'SQP catalog entry is missing the required `asin` reportOption').toBeTruthy();
    // Singular `asin` (not the plural `asins` used by Search Catalog
    // Performance) is the classic silent-failure trap this entry exists to
    // prevent -- pin the note text so a future edit can't quietly drop it.
    expect(asinOpt?.note ?? '').toMatch(/required/i);
  });
});

describe('findReportType — real shipped catalog', () => {
  it('finds a known entry by exact enum', async () => {
    const entry = await findReportType('GET_SALES_AND_TRAFFIC_REPORT');
    expect(entry).not.toBeNull();
    expect(entry?.documentFormat).toBe('json');
    expect(entry?.window).toBe('required');
  });

  it('returns null for an unknown enum (no fuzzy matching)', async () => {
    expect(await findReportType('GET_NOT_A_REAL_REPORT')).toBeNull();
  });
});

describe('loadReportCatalog — override + normalization', () => {
  it('loads from an override path and normalizes raw fields', async () => {
    const yaml = `
schema_version: 1
reports:
  - report_type: GET_SAMPLE_REPORT
    title: Sample
    purpose: A sample.
    applies_to: seller
    document_format: json
    window: forbidden
    warehouse_coverage: have
    report_options:
      - key: reportPeriod
        example: WEEK
        note: pick a period
`;
    await withTempCatalog(yaml, async (path) => {
      const all = await loadReportCatalog(path);
      expect(all).toHaveLength(1);
      const e = all[0]!;
      expect(e.reportType).toBe('GET_SAMPLE_REPORT');
      expect(e.appliesTo).toBe('seller');
      expect(e.documentFormat).toBe('json');
      expect(e.window).toBe('forbidden');
      expect(e.warehouseCoverage).toBe('have');
      expect(e.reportOptions).toEqual([
        { key: 'reportPeriod', example: 'WEEK', note: 'pick a period' },
      ]);
    });
  });

  it('defaults unknown enums for applies_to / document_format / window / coverage', async () => {
    const yaml = `
reports:
  - report_type: GET_WEIRD
    applies_to: martian
    document_format: parquet
    window: whenever
    warehouse_coverage: maybe
`;
    await withTempCatalog(yaml, async (path) => {
      const [e] = await loadReportCatalog(path);
      expect(e!.appliesTo).toBe('both'); // unknown -> both
      expect(e!.documentFormat).toBe('tsv'); // non-json -> tsv
      expect(e!.window).toBe('optional'); // unknown -> optional
      expect(e!.warehouseCoverage).toBe('none'); // unknown -> none
      expect(e!.title).toBe('GET_WEIRD'); // title falls back to reportType
      expect(e!.reportOptions).toEqual([]); // missing -> []
    });
  });

  it('skips entries with no report_type', async () => {
    const yaml = `
reports:
  - title: orphan with no report_type
  - report_type: GET_REAL_ONE
    title: real
`;
    await withTempCatalog(yaml, async (path) => {
      const all = await loadReportCatalog(path);
      expect(all.map((e) => e.reportType)).toEqual(['GET_REAL_ONE']);
    });
  });

  it('returns [] when the override file is missing (no throw)', async () => {
    await withTempCatalog(null, async (path) => {
      expect(await loadReportCatalog(path)).toEqual([]);
    });
  });
});
