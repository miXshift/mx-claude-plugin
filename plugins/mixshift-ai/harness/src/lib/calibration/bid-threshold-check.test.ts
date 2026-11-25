/**
 * mx-ops#409 (D-401 option A): mx-keyword-bid-health reads scale/pullback as
 * ABSOLUTE ACoS levels. The brand template now says so and ships no 50/50
 * default; the confirm card warns when saved values read like offsets from
 * target and asks once (fix or keep); nothing is rewritten for the user.
 *
 * The integration blocks run against the REAL shipped manifests, template and
 * golden fixtures, so a regression in any of them fails here by name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { prepareConfirmation, applyConfirmation, type ConfirmationDecision } from './confirm-flow.js';
import { extractCalibration, type CalibrationManifest } from './manifest-schema.js';
import { renderConfirmationCard, joinCard, renderPersistenceFooter } from './render-chat.js';
import { checkBidThresholds, BID_THRESHOLD_ACK_KEY } from './bid-threshold-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..', '..', '..', '..');
const skillsDir = join(pluginDir, 'skills');
const templatePath = join(pluginDir, 'shared', 'clients', '_template', 'context.yaml');
const fixturesDir = join(pluginDir, 'harness', 'testdata', 'clients');

const KBH = 'mx-keyword-bid-health';

let testDir: string;
let brandDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-bid-threshold-${process.pid}-${Date.now()}-${Math.random()}`);
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

function ctx(target: number | null, scale?: number, pullback?: number): string {
  const lines = ['management:', '  primary_metric: ACOS'];
  if (target !== null) lines.push(`  acos_target_pct: ${target}`);
  if (scale !== undefined || pullback !== undefined) {
    lines.push('bid_health:');
    if (scale !== undefined) lines.push(`  scale_threshold_pct: ${scale}`);
    if (pullback !== undefined) lines.push(`  pullback_threshold_pct: ${pullback}`);
  }
  return lines.join('\n') + '\n';
}

async function prepare(skillId = KBH) {
  return prepareConfirmation({
    brandSlug: 'summit',
    brandName: 'Summit',
    skillId,
    manifest: await loadCalibration(skillId),
    dataDirOverride: testDir,
  });
}

async function apply(decision: ConfirmationDecision, skillId = KBH) {
  const payload = await prepare(skillId);
  const result = await applyConfirmation(payload, decision, { dataDirOverride: testDir });
  return { payload, result };
}

async function readConfig(): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    return parseYaml(await readFile(join(brandDir, 'config.yaml'), 'utf-8'));
  } catch {
    return null;
  }
}

describe('checkBidThresholds (pure)', () => {
  let fields: CalibrationManifest['fields'];
  beforeEach(async () => {
    fields = (await loadCalibration(KBH)).fields;
  });

  it('flags the old template default (50/50) as scale at or above pullback', () => {
    const c = checkBidThresholds(
      fields,
      { scale_threshold_pct: 0.5, pullback_threshold_pct: 0.5, acos_target: 0.3 },
      {},
    );
    expect(c?.warnings.map((w) => w.code)).toEqual(['scale_at_or_above_pullback']);
    expect(c?.reconfirm_required).toBe(true);
    expect(c?.warnings[0]!.message).toContain('21% and 45%');
  });

  it('flags a pullback offset (20 with a 30% target) as below target', () => {
    const c = checkBidThresholds(
      fields,
      { scale_threshold_pct: 0.1, pullback_threshold_pct: 0.2, acos_target: 0.3 },
      {},
    );
    expect(c?.warnings.map((w) => w.code)).toEqual(['pullback_below_target']);
    expect(c?.warnings[0]!.message).toContain('"20% above target" is 36%');
  });

  it('reports both when both trip', () => {
    const c = checkBidThresholds(
      fields,
      { scale_threshold_pct: 0.25, pullback_threshold_pct: 0.2, acos_target: 0.3 },
      {},
    );
    expect(c?.warnings.map((w) => w.code)).toEqual([
      'scale_at_or_above_pullback',
      'pullback_below_target',
    ]);
  });

  it.each([
    ['levels around a 30% target', { scale_threshold_pct: 0.21, pullback_threshold_pct: 0.45, acos_target: 0.3 }],
    ['pullback exactly at target', { scale_threshold_pct: 0.2, pullback_threshold_pct: 0.3, acos_target: 0.3 }],
    ['nothing set (the skill derives them)', { acos_target: 0.3 }],
    ['only pullback, no target', { pullback_threshold_pct: 0.2 }],
  ])('passes %s', (_label, effective) => {
    expect(checkBidThresholds(fields, effective, {})).toBeNull();
  });

  it('is acknowledged only for exactly the kept values', () => {
    const effective = { scale_threshold_pct: 0.5, pullback_threshold_pct: 0.5, acos_target: 0.3 };
    const ack = { scale_threshold_pct: 50, pullback_threshold_pct: 50, acos_target: 30, kept_at: 'x' };
    const kept = checkBidThresholds(fields, effective, { [BID_THRESHOLD_ACK_KEY]: ack });
    expect(kept?.acknowledged).toBe(true);
    expect(kept?.reconfirm_required).toBe(false);

    const moved = checkBidThresholds(
      fields,
      { ...effective, acos_target: 0.35 },
      { [BID_THRESHOLD_ACK_KEY]: ack },
    );
    expect(moved?.acknowledged).toBe(false);
    expect(moved?.reconfirm_required).toBe(true);
  });

  it('does not apply to a skill without both bid_health thresholds (runaway-spend-check)', async () => {
    const rsc = (await loadCalibration('mx-runaway-spend-check')).fields;
    expect(
      checkBidThresholds(rsc, { pullback_threshold_pct: 0.2, acos_target: 0.3 }, {}),
    ).toBeNull();
  });
});

describe('mx-keyword-bid-health confirm card: one-time re-confirm', () => {
  it('a brand on the old 50/50 template values is warned and a plain confirm is refused, nothing written', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 50), 'utf-8');
    const { payload, result } = await apply({ action: 'confirm' });

    expect(payload.threshold_check?.reconfirm_required).toBe(true);
    const card = joinCard(renderConfirmationCard(payload, { skill_display_name: 'Keyword Bid Health Review' }));
    expect(card).toContain('Check your bid thresholds before this run (asked once):');
    expect(card).toContain('Scale threshold (50%) is at or above the pullback threshold (50%)');
    expect(card).toContain('"keep"');

    expect(result.status).toBe('validation_failed');
    expect(result.effective_config).toEqual({});
    expect(result.threshold_check?.warnings[0]!.code).toBe('scale_at_or_above_pullback');
    expect(result.validation_issues[0]!.message).toContain('acknowledge_warnings');
    expect(await readConfig()).toBeNull();
  });

  it('keep: runs on the values as they are, records the ack once, never rewrites them', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 50), 'utf-8');
    const { result } = await apply({ action: 'confirm', acknowledge_warnings: true });

    expect(result.status).toBe('ok');
    expect(result.effective_config).toMatchObject({
      scale_threshold_pct: 50,
      pullback_threshold_pct: 50,
      acos_target: 30,
    });
    expect(result.did_persist).toBe(true);
    expect(result.threshold_ack_saved).toBe('confirm');
    expect(result.threshold_check?.reconfirm_required).toBe(false);

    // Only the ack was written: the seeded values stay seeds, the context is untouched.
    const cfg = await readConfig();
    expect(Object.keys(cfg![KBH]!)).toEqual([BID_THRESHOLD_ACK_KEY]);
    expect(cfg![KBH]![BID_THRESHOLD_ACK_KEY]).toMatchObject({
      scale_threshold_pct: 50,
      pullback_threshold_pct: 50,
      acos_target: 30,
    });
    expect(await readFile(join(brandDir, 'context.yaml'), 'utf-8')).toBe(ctx(30, 50, 50));

    const footer = renderPersistenceFooter(result, 'Summit', 'Keyword Bid Health Review');
    expect(footer).toContain('Kept your bid thresholds');
    expect(footer).not.toContain('Saved your edits');

    // Next run: not asked again; a plain confirm runs and writes nothing.
    const again = await apply({ action: 'confirm' });
    expect(again.payload.threshold_check?.acknowledged).toBe(true);
    expect(again.payload.threshold_check?.reconfirm_required).toBe(false);
    const card = joinCard(renderConfirmationCard(again.payload));
    expect(card).toContain('You chose to keep these bid thresholds earlier');
    expect(card).not.toContain('user-added field');
    expect(again.result.status).toBe('ok');
    expect(again.result.did_persist).toBe(false);
  });

  it('asks again when kept values change and still trip', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 50), 'utf-8');
    await apply({ action: 'confirm', acknowledge_warnings: true });
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 10, 20), 'utf-8');
    const { payload, result } = await apply({ action: 'confirm' });
    expect(payload.threshold_check?.warnings.map((w) => w.code)).toEqual(['pullback_below_target']);
    expect(result.status).toBe('validation_failed');
  });

  it('fix: editing to ACoS levels clears the warning and saves', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 20), 'utf-8');
    const { result } = await apply({
      action: 'edit',
      edits: { scale_threshold_pct: '21', pullback_threshold_pct: '45' },
      save: true,
    });
    expect(result.status).toBe('ok');
    expect(result.threshold_check).toBeUndefined();
    expect(result.effective_config).toMatchObject({ scale_threshold_pct: 21, pullback_threshold_pct: 45 });
    const cfg = await readConfig();
    expect(cfg![KBH]![BID_THRESHOLD_ACK_KEY]).toBeUndefined();
  });

  it('an edit that still trips is refused unless kept, and a kept save records the ack', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30), 'utf-8');
    const refused = await apply({
      action: 'edit',
      edits: { scale_threshold_pct: '10', pullback_threshold_pct: '20' },
      save: true,
    });
    expect(refused.result.status).toBe('validation_failed');
    expect(await readConfig()).toBeNull();

    const kept = await apply({
      action: 'edit',
      edits: { scale_threshold_pct: '10', pullback_threshold_pct: '20' },
      save: true,
      acknowledge_warnings: true,
    });
    expect(kept.result.status).toBe('ok');
    expect(kept.result.threshold_ack_saved).toBe('edit');
    const cfg = await readConfig();
    expect(cfg![KBH]).toMatchObject({ scale_threshold_pct: 0.1, pullback_threshold_pct: 0.2 });
    expect(cfg![KBH]![BID_THRESHOLD_ACK_KEY]).toMatchObject({ pullback_threshold_pct: 20, acos_target: 30 });
  });

  it('rejects a non-boolean acknowledge_warnings', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 50), 'utf-8');
    const { result } = await apply({
      action: 'confirm',
      acknowledge_warnings: 'yes',
    } as unknown as ConfirmationDecision);
    expect(result.status).toBe('validation_failed');
    expect(result.validation_issues[0]!.field).toBe('acknowledge_warnings');
    expect(await readConfig()).toBeNull();
  });

  it.each([
    ['ACoS levels', ctx(30, 21, 45)],
    ['no bid_health (derived from target)', ctx(30)],
    ['no target and no thresholds', ctx(null)],
  ])('%s: no warning, plain confirm runs, nothing written', async (_label, context) => {
    await writeFile(join(brandDir, 'context.yaml'), context, 'utf-8');
    const { payload, result } = await apply({ action: 'confirm' });
    expect(payload.threshold_check).toBeUndefined();
    expect(renderConfirmationCard(payload).threshold_note).toBeNull();
    expect(result.status).toBe('ok');
    expect(result.did_persist).toBe(false);
    expect(await readConfig()).toBeNull();
  });

  it('leaves mx-runaway-spend-check unchanged', async () => {
    await writeFile(join(brandDir, 'context.yaml'), ctx(30, 50, 20), 'utf-8');
    const { payload, result } = await apply({ action: 'confirm' }, 'mx-runaway-spend-check');
    expect(payload.threshold_check).toBeUndefined();
    expect(result.status).toBe('ok');
  });
});

describe('the brand template and golden fixtures read thresholds as ACoS levels', () => {
  it('the template ships no bid_health values (unset → target x 0.7 / x 1.5)', async () => {
    const raw = await readFile(templatePath, 'utf-8');
    const doc = parseYaml(raw) as Record<string, unknown>;
    expect(doc.bid_health).toBeUndefined();
    expect(raw).not.toMatch(/above target by|below target by/i);
    expect(raw).toMatch(/ACoS LEVEL/);
    expect(raw).toMatch(/x 0\.7 \(scale\) and x 1\.5 \(pullback\)/);
  });

  it('the skill derives target x 0.7 / x 1.5 when unset, and documents the re-confirm', async () => {
    const md = await readFile(join(skillsDir, KBH, 'SKILL.md'), 'utf-8');
    expect(md).toContain('else `acos_target × 1.5`');
    expect(md).toContain('else `acos_target × 0.7`');
    expect(md).toContain('"acknowledge_warnings":true');
    expect(md).toMatch(/never rewrite their values/);
  });

  it('every golden fixture with bid_health passes the check', async () => {
    const fields = (await loadCalibration(KBH)).fields;
    const dirs = (await readdir(fixturesDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    let checked = 0;
    for (const d of dirs) {
      let raw: string;
      try {
        raw = await readFile(join(fixturesDir, d.name, 'context.yaml'), 'utf-8');
      } catch {
        continue;
      }
      const doc = parseYaml(raw) as {
        management?: { acos_target_pct?: number };
        bid_health?: { scale_threshold_pct?: number; pullback_threshold_pct?: number };
      };
      if (!doc.bid_health) continue;
      const frac = (n: number | undefined) => (n === undefined ? undefined : n / 100);
      const effective: Record<string, unknown> = {
        scale_threshold_pct: frac(doc.bid_health.scale_threshold_pct),
        pullback_threshold_pct: frac(doc.bid_health.pullback_threshold_pct),
        acos_target: frac(doc.management?.acos_target_pct),
      };
      expect(checkBidThresholds(fields, effective, {}), `${d.name}/context.yaml`).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
