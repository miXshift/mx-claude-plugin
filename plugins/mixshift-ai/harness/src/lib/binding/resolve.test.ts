import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBinding, isSubBrand } from './resolve.js';

let testDir: string;
let brandDir: string;

const baseContextYaml = `
schema_version: 1
brand_slug: acme
brand_name: Acme
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Seller
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: ads
  ops_revenue: rev
  ops_revenue_field: r
  ops_units_field: u
  ops_date_field: d
management:
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 7
`;

const bindingBlockYaml = `
binding:
  kind: sub_brand
  amazon_seller_id: A1EXAMPLE23456
  retail_label:
    source: mws_items.Brand
    value: Forager Pantry
`;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-binding-resolve-${process.pid}-${Date.now()}-${Math.random()}`);
  brandDir = join(testDir, 'clients', 'acme');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('resolveBinding', () => {
  it('returns null when the brand has no context.yaml at all', async () => {
    expect(await resolveBinding('acme', testDir)).toBeNull();
  });

  it('returns null when context.yaml has no binding block (the normal brand)', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    expect(await resolveBinding('acme', testDir)).toBeNull();
  });

  it('returns the typed binding when present', async () => {
    await writeFile(
      join(brandDir, 'context.yaml'),
      baseContextYaml + bindingBlockYaml,
      'utf-8',
    );
    const binding = await resolveBinding('acme', testDir);
    expect(binding).not.toBeNull();
    expect(binding?.kind).toBe('sub_brand');
    expect(binding?.amazon_seller_id).toBe('A1EXAMPLE23456');
    expect(binding?.retail_label?.value).toBe('Forager Pantry');
  });

  it('returns null (never throws) when context.yaml fails schema validation', async () => {
    await writeFile(join(brandDir, 'context.yaml'), 'not: [valid, context', 'utf-8');
    await expect(resolveBinding('acme', testDir)).resolves.toBeNull();
  });
});

describe('isSubBrand', () => {
  it('mirrors resolveBinding as a boolean', async () => {
    expect(await isSubBrand('acme', testDir)).toBe(false);
    await writeFile(
      join(brandDir, 'context.yaml'),
      baseContextYaml + bindingBlockYaml,
      'utf-8',
    );
    expect(await isSubBrand('acme', testDir)).toBe(true);
  });
});
