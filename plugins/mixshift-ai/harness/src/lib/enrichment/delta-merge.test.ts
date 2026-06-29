import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeEnrichmentIntoContext } from './delta-merge.js';

// Phase 8: delta-merge now sources the settlement curve from the Tier-2 brain
// (brand-brain.yaml::capture_rate_calibration.daily_settlement_curve), not the
// retired per-run enrichment.json artifact. These fixtures write a brain that
// validates against brandBrainSchema (seller spine + sources mirror the golden
// fixture) plus a capture_rate_calibration block.

let testDir: string;
let brandDir: string;

const baseContextYaml = `# Summit Labs brand context
# Hand-curated by the AM — DO NOT machine-edit non-enrichment fields.

schema_version: 1
brand_slug: summit
brand_name: Summit Labs
last_updated: 2026-05-01

accounts:
  - seller_id: 12345
    seller_name: Summit Labs LLC
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
  acos_target_pct: 0.28
  attribution_window_days: 7

# AM-curated: do NOT touch
negation:
  protected_terms:
    - flask
    - bottle
  competitor_brands:
    - ridgepeak

capture_rate_calibration:
  enabled: false
  capture_rate_pct: null
`;

/** A valid Tier-2 brain WITH a settlement curve. Seller spine + sources mirror
 *  the golden fixture (known-valid against brandBrainSchema). */
const brainWithCurveYaml = `# Summit Labs — Brand Brain (Tier 2, test fixture)
schema_version: 1
brand_slug: summit
generated_at: "2026-05-21T08:00:00.000Z"
generator: "plugin@test"

sources:
  seller:
    sproc: "sp_brain_seller_fetch"
    fetched_at: "2026-05-21T08:00:00.000Z"
    row_count: 1
    source_hash: "sha256:0000000000000000000000000000000000000000000000000000000000summit"

seller:
  merchant_alias: "Summit Labs US"
  storefront_name: "Summit Labs"
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
  primary_seller_id: 12345

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

/** Same brain spine but no capture_rate_calibration block → no curve to merge. */
const brainNoCurveYaml = `# Summit Labs — Brand Brain (Tier 2, no curve)
schema_version: 1
brand_slug: summit
generated_at: "2026-05-21T08:00:00.000Z"
generator: "plugin@test"

sources:
  seller:
    sproc: "sp_brain_seller_fetch"
    fetched_at: "2026-05-21T08:00:00.000Z"
    row_count: 1
    source_hash: "sha256:0000000000000000000000000000000000000000000000000000000000summit"

seller:
  merchant_alias: "Summit Labs US"
  storefront_name: "Summit Labs"
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
  primary_seller_id: 12345

observations: {}
`;

async function writeBrain(yaml: string): Promise<void> {
  await writeFile(join(brandDir, 'brand-brain.yaml'), yaml, 'utf-8');
}

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-delta-merge-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  brandDir = join(testDir, 'clients', 'summit');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('mergeEnrichmentIntoContext — no brain', () => {
  it('returns no_brain when the brain is absent', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const result = await mergeEnrichmentIntoContext('summit', testDir);
    expect(result.status).toBe('no_brain');
    expect(result.fields_updated).toEqual([]);
  });
});

describe('mergeEnrichmentIntoContext — no settlement curve', () => {
  it('returns no_curve when the brain has no capture_rate_calibration curve', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    await writeBrain(brainNoCurveYaml);
    const result = await mergeEnrichmentIntoContext('summit', testDir);
    expect(result.status).toBe('no_curve');
  });
});

describe('mergeEnrichmentIntoContext — no context', () => {
  it('returns context_missing when context.yaml absent', async () => {
    await writeBrain(brainWithCurveYaml);
    const result = await mergeEnrichmentIntoContext('summit', testDir);
    expect(result.status).toBe('context_missing');
  });
});

describe('mergeEnrichmentIntoContext — happy path', () => {
  beforeEach(async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    await writeBrain(brainWithCurveYaml);
  });

  it('returns ok status with updated fields list', async () => {
    const result = await mergeEnrichmentIntoContext('summit', testDir);
    expect(result.status).toBe('ok');
    expect(result.fields_updated).toContain('capture_rate_calibration.daily_settlement_curve');
    expect(result.fields_updated).toContain('capture_rate_calibration.stability_score');
    expect(result.fields_updated).toContain('capture_rate_calibration.last_calibrated');
    expect(result.fields_updated).toContain('last_updated');
  });

  it('patches daily_settlement_curve from the brain into capture_rate_calibration', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('daily_settlement_curve:');
    expect(raw).toContain('by_campaign_type:');
    expect(raw).toContain('sponsoredProducts:');
    expect(raw).toContain('45.5'); // acos_1day from the brain curve
  });

  it('sets stability_score and last_calibrated', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('stability_score: medium');
    expect(raw).toContain('last_calibrated: 2026-05-21');
  });

  it('bumps last_updated to today', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    expect(raw).toContain(`last_updated: ${today}`);
    expect(raw).not.toContain('last_updated: 2026-05-01'); // old value gone
  });

  it('PRESERVES AM-curated fields (negation, accounts, etc.)', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Negation block intact
    expect(raw).toContain('protected_terms:');
    expect(raw).toContain('- flask');
    expect(raw).toContain('- bottle');
    expect(raw).toContain('competitor_brands:');
    expect(raw).toContain('- ridgepeak');
    // Accounts intact
    expect(raw).toContain('seller_id: 12345');
    expect(raw).toContain('Summit Labs LLC');
    // Management intact
    expect(raw).toContain('primary_metric: ACOS');
    expect(raw).toContain('acos_target_pct: 0.28');
  });

  it('leaves an explicit capture_rate_calibration.enabled: false untouched', async () => {
    // Initial context has enabled: false; the merge only sets enabled when
    // undefined/null, so it must NOT change here.
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/enabled:\s*false/);
  });

  it('sets enabled: true when calibration block had no enabled key', async () => {
    const ctxNoEnabled = baseContextYaml.replace(
      /capture_rate_calibration:[\s\S]*$/,
      `capture_rate_calibration:\n  capture_rate_pct: null\n`,
    );
    await writeFile(join(brandDir, 'context.yaml'), ctxNoEnabled, 'utf-8');
    const result = await mergeEnrichmentIntoContext('summit', testDir);
    expect(result.fields_updated).toContain('capture_rate_calibration.enabled');
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/enabled:\s*true/);
  });

  it('is idempotent — second merge produces no field changes except last_updated', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const after1 = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    await mergeEnrichmentIntoContext('summit', testDir);
    const after2 = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Both identical (today's date is the same across both runs).
    expect(after2).toBe(after1);
  });

  it('PRESERVES comments in context.yaml', async () => {
    await mergeEnrichmentIntoContext('summit', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('# Summit Labs brand context');
    expect(raw).toContain('# AM-curated: do NOT touch');
  });
});
