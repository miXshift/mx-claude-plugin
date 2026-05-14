import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { bootstrapBrand, sortAccountsForPrimary } from './bootstrap.js';
import { contextSchema } from '../context/schema.js';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-bootstrap-test-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function row(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    amazon_seller_id: 'A1XXX',
    merchant_alias: 'acme storefront',
    account_type: 'SC',
    marketplace: 'United States',
    region: 'NA',
    agency_name: null,
    acos_target: 22,
    ads_active: true,
    retail_active: true,
    is_active: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function suggestion(rows: SellerRow[]): BrandSuggestion {
  return {
    slug: 'acme',
    display_name: 'Acme Corp',
    accounts: rows,
    ads_active: rows.some((r) => r.ads_active),
    retail_active: rows.some((r) => r.retail_active),
  };
}

describe('bootstrapBrand', () => {
  it('writes a schema-valid context.yaml + narrative.md + README.md', async () => {
    const result = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      asOfDate: '2026-05-14',
    });

    expect(result.brand_dir).toContain('acme');
    expect(result.written_files.length).toBeGreaterThanOrEqual(3);

    // context.yaml validates against the schema
    const yamlRaw = await readFile(result.context_path, 'utf-8');
    const parsed = parseYaml(yamlRaw);
    const validated = contextSchema.safeParse(parsed);
    expect(validated.success).toBe(true);

    if (validated.success) {
      expect(validated.data.brand_slug).toBe('acme');
      expect(validated.data.brand_name).toBe('Acme Corp');
      expect(validated.data.accounts).toHaveLength(1);
      expect(validated.data.accounts[0]!.role).toBe('primary');
      expect(validated.data.accounts[0]!.merchant_type).toBe('seller');
      expect(validated.data.management.acos_target_pct).toBe(22); // from warehouse
      expect(validated.data.sources.ops_revenue).toBe('business_reports_dpst_date');
    }

    // narrative.md has the canonical headings
    const narrative = await readFile(result.narrative_path, 'utf-8');
    expect(narrative).toContain('## Brand Identity');
    expect(narrative).toContain('## Current Quarter Context');
    expect(narrative).toContain('## Historical Notes');
  });

  it('uses VC sources when primary account is VC', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ account_type: 'VC', merchant_alias: 'vc storefront' })]),
      { dataDirOverride: testDir },
    );
    const yamlRaw = await readFile(result.context_path, 'utf-8');
    const parsed = parseYaml(yamlRaw) as Record<string, unknown>;
    const sources = parsed.sources as Record<string, string>;
    expect(sources.ops_revenue).toBe('vendor_sales_manufacturing_asin');
    expect(sources.ops_revenue_field).toBe('OrderedRevenueAmount');
    expect(sources.ops_units_field).toBe('OrderedUnits');
  });

  it('marks first sorted account primary, rest secondary', async () => {
    const result = await bootstrapBrand(
      suggestion([
        row({ seller_id: 1, account_type: 'VC', marketplace: 'Germany' }),
        row({ seller_id: 2, account_type: 'SC', marketplace: 'United States' }),
        row({ seller_id: 3, account_type: 'SC', marketplace: 'Canada' }),
      ]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<{ seller_id: number; role: string }>;

    // SC US is the most-preferred primary
    expect(accounts[0]!.seller_id).toBe(2);
    expect(accounts[0]!.role).toBe('primary');
    expect(accounts.slice(1).every((a) => a.role === 'secondary')).toBe(true);
  });

  it('defaults acos_target_pct to 20 when no warehouse value', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ acos_target: null })]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const management = yaml.management as Record<string, unknown>;
    expect(management.acos_target_pct).toBe(20);
  });

  it('throws when slug directory already exists and force is not set', async () => {
    const s = suggestion([row({})]);
    await bootstrapBrand(s, { dataDirOverride: testDir });
    await expect(
      bootstrapBrand(s, { dataDirOverride: testDir }),
    ).rejects.toThrow(/already exists/);
  });

  it('overwrites when force is true', async () => {
    const s = suggestion([row({})]);
    await bootstrapBrand(s, { dataDirOverride: testDir });
    const result = await bootstrapBrand(s, {
      dataDirOverride: testDir,
      force: true,
    });
    expect(result.brand_dir).toBeDefined();
  });

  it('throws when all accounts have account_type = unknown', async () => {
    const s = suggestion([
      row({ account_type: 'unknown' }),
      row({ account_type: 'unknown', seller_id: 2 }),
    ]);
    await expect(
      bootstrapBrand(s, { dataDirOverride: testDir }),
    ).rejects.toThrow(/MerchantType outside SC \/ VC/);
  });

  it('filters out unknown account_type rows but proceeds if at least one SC/VC remains', async () => {
    const s: BrandSuggestion = {
      slug: 'mixed',
      display_name: 'Mixed Brand',
      accounts: [
        row({ seller_id: 1, account_type: 'unknown' }),
        row({ seller_id: 2, account_type: 'SC' }),
      ],
      ads_active: true,
      retail_active: true,
    };
    const result = await bootstrapBrand(s, { dataDirOverride: testDir });
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<{ seller_id: number }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.seller_id).toBe(2);
  });

  it('preserves merchant_alias on each account for reference', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ merchant_alias: 'original-storefront-name' })]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<Record<string, unknown>>;
    expect(accounts[0]!.merchant_alias).toBe('original-storefront-name');
  });
});

describe('sortAccountsForPrimary', () => {
  it('puts SC ahead of VC', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'VC', marketplace: 'United States' }),
      row({ account_type: 'SC', marketplace: 'United States' }),
    ]);
    expect(sorted[0]!.account_type).toBe('SC');
  });

  it('within same type, prefers full-access over partial', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'SC', ads_active: false, retail_active: true }),
      row({ account_type: 'SC', ads_active: true, retail_active: true }),
    ]);
    expect(sorted[0]!.ads_active).toBe(true);
    expect(sorted[0]!.retail_active).toBe(true);
  });

  it('within same type and access, prefers US over non-US', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'SC', marketplace: 'Canada' }),
      row({ account_type: 'SC', marketplace: 'United States' }),
    ]);
    expect(sorted[0]!.marketplace).toBe('United States');
  });
});
