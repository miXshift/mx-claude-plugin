import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { previewDemotion, applyDemotion } from './demote.js';

let testDir: string;
let clientsDir: string;

const SLUG = 'forager-pantry';
const SELLER_ID = 'A1EXAMPLE23456';

const boundContextYaml = `
schema_version: 1
brand_slug: ${SLUG}
brand_name: Forager Pantry
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Agency
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: campaignmetric
  ops_revenue: business_reports_dpst_date
  ops_revenue_field: SalesAmount
  ops_units_field: UnitsOrdered
  ops_date_field: DateTime
management:
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 14
binding:
  kind: sub_brand
  amazon_seller_id: ${SELLER_ID}
  seller_ids: [1]
  retail_label:
    source: mws_items.Brand
    value: "Forager Pantry"
  scope_note: "This brand is a sub-brand scoped to the Forager Pantry label."
`;

const unboundContextYaml = `
schema_version: 1
brand_slug: acme
brand_name: Acme
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Agency
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: campaignmetric
  ops_revenue: business_reports_dpst_date
  ops_revenue_field: SalesAmount
  ops_units_field: UnitsOrdered
  ops_date_field: DateTime
management:
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 14
`;

async function writeContext(slug: string, yaml: string): Promise<void> {
  const dir = join(clientsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'context.yaml'), yaml, 'utf-8');
}

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-binding-demote-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  clientsDir = join(testDir, 'clients');
  await mkdir(clientsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('previewDemotion', () => {
  it('reports is_sub_brand true with a binding summary when a binding is present', async () => {
    await writeContext(SLUG, boundContextYaml);
    const preview = await previewDemotion(SLUG, testDir);
    expect(preview.is_sub_brand).toBe(true);
    expect(preview.binding_summary).toContain('Forager Pantry');
    expect(preview.would_park_to).toBe(`${SLUG}.parked`);
  });

  it('reports is_sub_brand false when there is no binding', async () => {
    await writeContext('acme', unboundContextYaml);
    const preview = await previewDemotion('acme', testDir);
    expect(preview.is_sub_brand).toBe(false);
    expect(preview.binding_summary).toBeNull();
  });

  it('never writes anything', async () => {
    await writeContext(SLUG, boundContextYaml);
    await previewDemotion(SLUG, testDir);
    const raw = await readFile(join(clientsDir, SLUG, 'context.yaml'), 'utf-8');
    expect(raw).toContain('binding:');
  });
});

describe('applyDemotion', () => {
  it('unsets the binding and parks the local directory', async () => {
    await writeContext(SLUG, boundContextYaml);
    const result = await applyDemotion(SLUG, testDir);
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);
    expect(result.parked_dir).toBeDefined();

    await expect(access(join(clientsDir, SLUG))).rejects.toThrow();
    const parkedRaw = await readFile(join(clientsDir, `${SLUG}.parked`, 'context.yaml'), 'utf-8');
    const parsed = parseYaml(parkedRaw) as Record<string, unknown>;
    expect(parsed.binding).toBeUndefined();
    expect(parsed.brand_slug).toBe(SLUG);
  });

  it('reports not_a_sub_brand (never an error) when the brand has no binding', async () => {
    await writeContext('acme', unboundContextYaml);
    const result = await applyDemotion('acme', testDir);
    expect(result.status).toBe('not_a_sub_brand');
    expect(result.did_write).toBe(false);
  });

  it('is idempotent: demoting an already-demoted brand reports not_a_sub_brand, never a crash', async () => {
    await writeContext(SLUG, boundContextYaml);
    const first = await applyDemotion(SLUG, testDir);
    expect(first.status).toBe('ok');

    const second = await applyDemotion(SLUG, testDir);
    expect(second.status).toBe('not_a_sub_brand');
    expect(second.did_write).toBe(false);
  });

  it('never deletes the parked directory or its content', async () => {
    await writeContext(SLUG, boundContextYaml);
    const result = await applyDemotion(SLUG, testDir);
    const parkedFiles = await readFile(join(clientsDir, `${SLUG}.parked`, 'context.yaml'), 'utf-8');
    expect(parkedFiles.length).toBeGreaterThan(0);
    expect(result.parked_dir).toContain('.parked');
  });
});
