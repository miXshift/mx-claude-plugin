/**
 * mx-ops#291, slice 1: each target-dependent skill gets the brand's
 * product-level ACoS targets (per ASIN and per SKU) beside its brand-level
 * ACoS target through `skill config`, and a brand without product targets
 * gets exactly what it got before.
 *
 * One block per skill, run against the skill's REAL shipped manifest and
 * SKILL.md, so a skill that stops seeding the brand target, or whose doc
 * stops applying the product targets, fails here by name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { prepareConfirmation, applyConfirmation } from './confirm-flow.js';
import { extractCalibration, type CalibrationManifest } from './manifest-schema.js';
import { renderConfirmationCard } from './render-chat.js';

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'skills');

/** The eight skills that judge spend against an ACoS target (mx-ops#291). */
const TARGET_DEPENDENT_SKILLS = [
  'mx-keyword-bid-health',
  'mx-runaway-spend-check',
  'mx-budget-balance',
  'mx-daily-health-check',
  'mx-search-term-negation',
  'mx-search-term-harvest',
  'mx-asin-target-negation',
  'mx-monthly-report',
] as const;

const BASE_CONTEXT = ['management:', '  primary_metric: ACOS', '  acos_target_pct: 20', ''].join('\n');

const WITH_PRODUCT_TARGETS = [
  'management:',
  '  primary_metric: ACOS',
  '  acos_target_pct: 20',
  'thresholds:',
  '  acos_target_by_asin:',
  '    B0TESTAAA1: 25',
  '    B0TESTAAA2: 40',
  '  acos_target_by_sku:',
  '    SKU-RED-01: 30',
  '',
].join('\n');

// A brand with OTHER thresholds but no product targets: still unchanged.
const WITH_OTHER_THRESHOLDS = [
  'management:',
  '  primary_metric: ACOS',
  '  acos_target_pct: 20',
  'thresholds:',
  '  forecast_actual_tolerance_pct: 5',
  '',
].join('\n');

let testDir: string;
let brandDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-product-targets-${process.pid}-${Date.now()}-${Math.random()}`);
  brandDir = join(testDir, 'clients', 'summit');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function loadCalibration(skillId: string): Promise<CalibrationManifest> {
  const raw = await readFile(join(skillsDir, skillId, 'skill.manifest.yaml'), 'utf-8');
  const cal = extractCalibration(parseYaml(raw));
  if (!cal) throw new Error(`${skillId} has no calibration block`);
  return cal;
}

async function runConfig(skillId: string, contextYaml: string) {
  await writeFile(join(brandDir, 'context.yaml'), contextYaml, 'utf-8');
  const manifest = await loadCalibration(skillId);
  const payload = await prepareConfirmation({
    brandSlug: 'summit',
    brandName: 'Summit',
    skillId,
    manifest,
    dataDirOverride: testDir,
  });
  const result = await applyConfirmation(payload, { action: 'confirm' }, { dataDirOverride: testDir });
  return { payload, result };
}

describe.each(TARGET_DEPENDENT_SKILLS)('%s: product-level ACoS targets', (skillId) => {
  it('seeds its ACoS target from the brand target (the field product targets sit beside)', async () => {
    const manifest = await loadCalibration(skillId);
    const seeded = manifest.fields.filter(
      (f) => f.seed_from === 'context.management.acos_target_pct' && !f.deprecated,
    );
    expect(seeded.map((f) => f.id)).toEqual(['acos_target']);
  });

  it('skill config returns the per-ASIN and per-SKU map beside acos_target', async () => {
    const { payload, result } = await runConfig(skillId, WITH_PRODUCT_TARGETS);
    expect(payload.product_acos_targets?.by_asin).toEqual({ B0TESTAAA1: 25, B0TESTAAA2: 40 });
    expect(payload.product_acos_targets?.by_sku).toEqual({ 'SKU-RED-01': 30 });

    expect(result.status).toBe('ok');
    // The brand target still resolves as before, in whole percents...
    expect(result.effective_config.acos_target).toBe(20);
    // ...and the product map rides beside it in the same unit.
    expect(result.product_acos_targets?.by_asin).toEqual({ B0TESTAAA1: 25, B0TESTAAA2: 40 });
    expect(result.product_acos_targets?.by_sku).toEqual({ 'SKU-RED-01': 30 });

    const card = renderConfirmationCard(payload, { skill_display_name: skillId });
    expect(card.fields).toContain('product targets from Brand Context apply first (2 per-ASIN, 1 per-SKU)');
  });

  it.each([
    ['no thresholds', BASE_CONTEXT],
    ['other thresholds only', WITH_OTHER_THRESHOLDS],
  ])('a brand without product targets is unchanged (%s)', async (_label, contextYaml) => {
    const { payload, result } = await runConfig(skillId, contextYaml);
    expect(payload).not.toHaveProperty('product_acos_targets');
    expect(result).not.toHaveProperty('product_acos_targets');
    expect(result.status).toBe('ok');
    expect(result.effective_config.acos_target).toBe(20);
    const card = renderConfirmationCard(payload, { skill_display_name: skillId });
    expect(card.fields).not.toContain('product targets');
  });

  it('a skill-level acos_target override still covers products without a product target', async () => {
    await writeFile(join(brandDir, 'context.yaml'), WITH_PRODUCT_TARGETS, 'utf-8');
    const manifest = await loadCalibration(skillId);
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId,
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      { action: 'edit', edits: { acos_target: '22' }, save: false },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.effective_config.acos_target).toBe(22);
    expect(result.product_acos_targets?.by_asin.B0TESTAAA1).toBe(25);
  });

  it('SKILL.md applies product_acos_targets with the brand target as fallback', async () => {
    const md = await readFile(join(skillsDir, skillId, 'SKILL.md'), 'utf-8');
    expect(md).toContain('product_acos_targets');
    expect(md).toContain('Product-level ACoS targets');
    // The fallback is stated, and mixed rows are flagged, never silently defaulted.
    expect(md).toMatch(/else[^.\n]*`acos_target`/);
    expect(md).toMatch(/brand target used/);
  });
});
