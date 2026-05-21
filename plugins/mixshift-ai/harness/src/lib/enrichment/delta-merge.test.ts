import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeEnrichmentIntoContext } from './delta-merge.js';
import { writeEnrichmentArtifact } from './storage.js';
import type { EnrichmentArtifact } from './types.js';

let testDir: string;
let brandDir: string;

const baseContextYaml = `# Skratch Labs brand context
# Hand-curated by the AM — DO NOT machine-edit non-enrichment fields.

schema_version: 1
brand_slug: skratch
brand_name: Skratch Labs
last_updated: 2026-05-01

accounts:
  - seller_id: 12345
    seller_name: Skratch Labs LLC
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
    - hydrapeak

capture_rate_calibration:
  enabled: false
  capture_rate_pct: null
`;

const sampleEnrichment: EnrichmentArtifact = {
  schema_version: 1,
  brand_slug: 'skratch',
  run_date: '2026-05-21',
  generated_at: '2026-05-21T08:00:00Z',
  account_count: 1,
  partial: false,
  partial_reasons: [],
  daily_settlement_curve: {
    by_campaign_type: {
      sponsoredProducts: {
        acos_1day: 45.5,
        acos_7day: 30.2,
        acos_14day: 28.0,
        improvement_pts_1_to_7: 15.3,
        improvement_pts_1_to_14: 17.5,
        settled_pct_at_1day: 62.0,
        status: 'computed',
      },
      sponsoredBrands: {
        acos_1day: null,
        acos_7day: null,
        acos_14day: null,
        improvement_pts_1_to_7: null,
        improvement_pts_1_to_14: null,
        settled_pct_at_1day: null,
        status: 'insufficient_data',
      },
      sponsoredDisplay: {
        acos_1day: null,
        acos_7day: null,
        acos_14day: null,
        improvement_pts_1_to_7: null,
        improvement_pts_1_to_14: null,
        settled_pct_at_1day: null,
        status: 'insufficient_data',
      },
    },
    dow_offset_pts: {
      monday: 5.2,
      tuesday: -1.1,
      wednesday: -2.0,
      thursday: -1.5,
      friday: -0.8,
      saturday: 0.2,
      sunday: 0.0,
    },
    stability_score: 'medium',
    last_calibrated: '2026-05-21',
  },
  stockout_candidates: [],
  brand_term_typo_candidates: [],
};

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-delta-merge-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  brandDir = join(testDir, 'clients', 'skratch');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('mergeEnrichmentIntoContext — no enrichment', () => {
  it('returns no_enrichment when artifact missing', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const result = await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    expect(result.status).toBe('no_enrichment');
    expect(result.fields_updated).toEqual([]);
  });
});

describe('mergeEnrichmentIntoContext — no settlement curve', () => {
  it('returns no_curve when enrichment has null settlement curve', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const noCurveArtifact = { ...sampleEnrichment, daily_settlement_curve: null };
    await writeEnrichmentArtifact('skratch', '2026-05-21', noCurveArtifact, testDir);
    const result = await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    expect(result.status).toBe('no_curve');
  });
});

describe('mergeEnrichmentIntoContext — no context', () => {
  it('returns context_missing when context.yaml absent', async () => {
    await writeEnrichmentArtifact('skratch', '2026-05-21', sampleEnrichment, testDir);
    const result = await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    expect(result.status).toBe('context_missing');
  });
});

describe('mergeEnrichmentIntoContext — happy path', () => {
  beforeEach(async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    await writeEnrichmentArtifact('skratch', '2026-05-21', sampleEnrichment, testDir);
  });

  it('returns ok status with updated fields list', async () => {
    const result = await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    expect(result.status).toBe('ok');
    expect(result.fields_updated).toContain('capture_rate_calibration.daily_settlement_curve');
    expect(result.fields_updated).toContain('capture_rate_calibration.stability_score');
    expect(result.fields_updated).toContain('capture_rate_calibration.last_calibrated');
    expect(result.fields_updated).toContain('last_updated');
  });

  it('patches daily_settlement_curve into capture_rate_calibration', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('daily_settlement_curve:');
    expect(raw).toContain('by_campaign_type:');
    expect(raw).toContain('sponsoredProducts:');
    expect(raw).toContain('45.5'); // acos_1day
  });

  it('sets stability_score and last_calibrated', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('stability_score: medium');
    expect(raw).toContain('last_calibrated: 2026-05-21');
  });

  it('bumps last_updated to today', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    expect(raw).toContain(`last_updated: ${today}`);
    expect(raw).not.toContain('last_updated: 2026-05-01'); // old value gone
  });

  it('PRESERVES AM-curated fields (negation, accounts, etc.)', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Negation block intact
    expect(raw).toContain('protected_terms:');
    expect(raw).toContain('- flask');
    expect(raw).toContain('- bottle');
    expect(raw).toContain('competitor_brands:');
    expect(raw).toContain('- hydrapeak');
    // Accounts intact
    expect(raw).toContain('seller_id: 12345');
    expect(raw).toContain('Skratch Labs LLC');
    // Management intact
    expect(raw).toContain('primary_metric: ACOS');
    expect(raw).toContain('acos_target_pct: 0.28');
  });

  it('flips capture_rate_calibration.enabled from false → true via missing → set', async () => {
    // Initial context has enabled: false, our merge logic only sets when
    // undefined/null. So we should NOT change it here.
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Original enabled: false preserved
    expect(raw).toMatch(/enabled:\s*false/);
  });

  it('sets enabled: true when calibration block had no enabled key', async () => {
    // Replace context with one that has no enabled key
    const ctxNoEnabled = baseContextYaml.replace(
      /capture_rate_calibration:[\s\S]*$/,
      `capture_rate_calibration:\n  capture_rate_pct: null\n`,
    );
    await writeFile(join(brandDir, 'context.yaml'), ctxNoEnabled, 'utf-8');
    const result = await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    expect(result.fields_updated).toContain('capture_rate_calibration.enabled');
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/enabled:\s*true/);
  });

  it('is idempotent — second merge produces no field changes except last_updated', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const after1 = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Wait a tick so timing of last_updated doesn't differ
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const after2 = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    // Both should be identical (today's date is the same)
    expect(after2).toBe(after1);
  });

  it('PRESERVES comments in context.yaml', async () => {
    await mergeEnrichmentIntoContext('skratch', '2026-05-21', testDir);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('# Skratch Labs brand context');
    expect(raw).toContain('# AM-curated: do NOT touch');
  });
});
