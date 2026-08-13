/**
 * Regression proof: a `binding` block on context.yaml (mx-ops#6 P1) survives
 * BOTH writer paths untouched.
 *
 *   1. The context editor (lib/context-editor/flow.ts): reads the whole YAML
 *      file into a plain object, patches only the edited dotted paths via
 *      setNested, and writes the whole object back — never through this
 *      schema's zod parse, so an unrecognized-to-the-editor block like
 *      `binding` cannot be stripped.
 *   2. Delta-merge (lib/enrichment/delta-merge.ts): uses the `yaml` package's
 *      Document API to patch ONLY `capture_rate_calibration.*` +
 *      `last_updated`, preserving comments and every other field.
 *
 * This is the regression test the build brief asked for: prove the binding
 * block round-trips through both without loss, since this context.yaml file
 * may be shared with another in-flight stream and must stay additive-safe.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { prepareBrandConfigEdit, applyBrandConfigEdit } from '../context-editor/flow.js';
import { mergeEnrichmentIntoContext } from '../enrichment/delta-merge.js';
import { contextSchema } from '../context/schema.js';

let testDir: string;
let brandDir: string;

const bindingBlock = {
  kind: 'sub_brand',
  amazon_seller_id: 'A1EXAMPLE23456',
  seller_ids: [111, 222],
  retail_label: { source: 'mws_items.Brand', value: 'Forager Pantry' },
  ads_label: { source: 'campaign.Brand', value: 'Forager Pantry' },
  scope_note: 'This brand is label-scoped to one sub-brand of a larger seller account.',
};

const contextYaml = `
schema_version: 1
brand_slug: forager-pantry
brand_name: Forager Pantry
last_updated: 2026-05-01
accounts:
  - seller_id: 123
    seller_name: Acme Agency Seller
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
  acos_target_pct: 28
  attribution_window_days: 7
binding:
  kind: sub_brand
  amazon_seller_id: A1EXAMPLE23456
  seller_ids: [111, 222]
  retail_label:
    source: mws_items.Brand
    value: Forager Pantry
  ads_label:
    source: campaign.Brand
    value: Forager Pantry
  scope_note: This brand is label-scoped to one sub-brand of a larger seller account.
`;

/** A valid Tier-2 brain WITH a settlement curve, so delta-merge has
 *  something real to patch (mirrors enrichment/delta-merge.test.ts). */
const brainWithCurveYaml = `
schema_version: 1
brand_slug: forager-pantry
generated_at: "2026-05-21T08:00:00.000Z"
generator: "plugin@test"

sources:
  seller:
    sproc: "sp_brain_seller_fetch"
    fetched_at: "2026-05-21T08:00:00.000Z"
    row_count: 1
    source_hash: "sha256:0000000000000000000000000000000000000000000000000000000forager"

seller:
  merchant_alias: "Forager Pantry US"
  storefront_name: "Forager Pantry"
  acos_target_pct: 28.0
  monthly_budget: 30000
  marketplace: "US"
  merchant_region: "NA"
  agency_name: "MixShift QA (synthetic)"
  default_currency_code: "USD"
  i_brand_report_enabled: true
  i_running_initial_pull: false
  data_freshness:
    ads_latest: "2026-05-20T00:00:00.000Z"
    retail_latest: "2026-05-19T00:00:00.000Z"
  activated:
    ads: "2024-01-01T00:00:00.000Z"
    retail: "2024-01-01T00:00:00.000Z"
  primary_seller_id: 123

capture_rate_calibration:
  enabled: true
  capture_rate_pct: 62.0
  fresh_day_acos_improvement_pts: 15.3
  settlement_application_rule: "apply_when_attribution_gt_1day"
  basis: "SC"
  settled_window_days: 7
  daily_settlement_curve:
    by_campaign_type:
      sponsoredProducts:
        acos_1day: 45.5
        acos_7day: 30.2
        acos_14day: 28.0
        improvement_pts_1_to_7: 15.3
        improvement_pts_1_to_14: 17.5
        settled_pct_at_1day: 62.0
        status: computed
      sponsoredBrands:
        acos_1day: null
        acos_7day: null
        acos_14day: null
        improvement_pts_1_to_7: null
        improvement_pts_1_to_14: null
        settled_pct_at_1day: null
        status: insufficient_data
      sponsoredDisplay:
        acos_1day: null
        acos_7day: null
        acos_14day: null
        improvement_pts_1_to_7: null
        improvement_pts_1_to_14: null
        settled_pct_at_1day: null
        status: insufficient_data
    dow_offset_pts:
      monday: 5.2
      tuesday: -1.1
      wednesday: -2.0
      thursday: -1.5
      friday: -0.8
      saturday: 0.2
      sunday: 0.0
    stability_score: medium
    last_calibrated: "2026-05-21"

observations: {}
`;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-binding-roundtrip-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  brandDir = join(testDir, 'clients', 'forager-pantry');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('binding block survives the context editor + delta-merge writers', () => {
  it('the schema fixture itself validates with the binding block intact', () => {
    const parsed = parseYaml(contextYaml);
    const r = contextSchema.safeParse(parsed);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.binding).toEqual(bindingBlock);
  });

  it('applyBrandConfigEdit (unrelated field) leaves binding untouched', async () => {
    await writeFile(join(brandDir, 'context.yaml'), contextYaml, 'utf-8');

    const payload = await prepareBrandConfigEdit({
      brandSlug: 'forager-pantry',
      brandName: 'Forager Pantry',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '32' } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);

    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.binding).toEqual(bindingBlock);
    // The edit itself did land — proves this isn't just an untouched file.
    expect((parsed.management as Record<string, unknown>).acos_target_pct).toBe(32);
  });

  it('mergeEnrichmentIntoContext (settlement curve patch) leaves binding untouched', async () => {
    await writeFile(join(brandDir, 'context.yaml'), contextYaml, 'utf-8');
    await writeFile(join(brandDir, 'brand-brain.yaml'), brainWithCurveYaml, 'utf-8');

    const result = await mergeEnrichmentIntoContext('forager-pantry', testDir);
    expect(result.status).toBe('ok');
    expect(result.fields_updated).toContain('capture_rate_calibration.daily_settlement_curve');

    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.binding).toEqual(bindingBlock);
    // The merge itself did land — proves this isn't just an untouched file.
    const curve = (parsed.capture_rate_calibration as Record<string, unknown>)
      .daily_settlement_curve as Record<string, unknown>;
    expect(curve).toBeDefined();
  });

  it('BOTH writers in sequence still leave binding untouched', async () => {
    await writeFile(join(brandDir, 'context.yaml'), contextYaml, 'utf-8');
    await writeFile(join(brandDir, 'brand-brain.yaml'), brainWithCurveYaml, 'utf-8');

    const payload = await prepareBrandConfigEdit({
      brandSlug: 'forager-pantry',
      brandName: 'Forager Pantry',
      dataDirOverride: testDir,
    });
    await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '31' } },
      { dataDirOverride: testDir },
    );
    await mergeEnrichmentIntoContext('forager-pantry', testDir);

    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.binding).toEqual(bindingBlock);
    // Both edits landed, so the untouched binding isn't a fluke of a no-op run.
    expect((parsed.management as Record<string, unknown>).acos_target_pct).toBe(31);
    expect(parsed.capture_rate_calibration).toBeDefined();

    // Re-validate the WHOLE file against the live schema at the end, so this
    // test also proves the round-tripped file is still a valid context.yaml.
    const revalidated = contextSchema.safeParse(parsed);
    expect(revalidated.success).toBe(true);
  });
});
