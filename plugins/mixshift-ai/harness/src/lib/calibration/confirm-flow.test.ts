import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareConfirmation,
  applyConfirmation,
  writeRunOclSnapshot,
} from './confirm-flow.js';
import type { CalibrationManifest } from './manifest-schema.js';
import { assembleBrain } from '../brain/assemble.js';
import { saveBrain } from '../brain/read.js';

const manifest: CalibrationManifest = {
  schema_version: 1,
  fields: [
    {
      id: 'objective',
      prompt: 'Posture?',
      type: 'enum',
      options: [
        { value: 'growth', label: 'Growth' },
        { value: 'profit', label: 'Profit' },
        { value: 'defend', label: 'Defend' },
      ],
      seed_from: 'context.posture.stance',
      required: true,
      deprecated: false,
    },
    {
      id: 'dampening',
      prompt: 'Dampening?',
      type: 'float',
      default: 0.6,
      decimals: 2,
      range: { min: 0, max: 1 },
      required: true,
      deprecated: false,
    },
    {
      id: 'hero_skus',
      prompt: 'Hero SKUs?',
      type: 'asin_list',
      default: [],
      max_items: 200,
      required: false,
      deprecated: false,
    },
  ],
};

let testDir: string;
let brandDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-confirm-${process.pid}-${Date.now()}-${Math.random()}`);
  brandDir = join(testDir, 'clients', 'summit');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('prepareConfirmation — Tier-2 brain seed fallback', () => {
  const NOW = new Date('2026-06-10T12:00:00.000Z');

  it('seeds a both-tiers field from the brain when context.yaml is absent', async () => {
    // Brain present (seller.marketplace), no context.yaml written.
    const brain = assembleBrain({
      brandSlug: 'summit',
      sellerRows: [
        { ID: 7, MerchantAlias: 'Summit', MarketPlaceName: 'Amazon.com', ACOSTarget: '25.0' },
      ],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@test',
      now: NOW,
    });
    await saveBrain(brain, testDir);

    const m: CalibrationManifest = {
      schema_version: 1,
      fields: [
        {
          id: 'marketplace',
          prompt: 'Marketplace?',
          type: 'string',
          max_length: 280,
          seed_from: 'context.accounts.0.marketplace',
          required: false,
          deprecated: false,
        },
      ],
    };
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'mx-keyword-bid-health',
      manifest: m,
      dataDirOverride: testDir,
    });
    expect(payload.fields[0]!.seed_value).toBe('Amazon.com');
    expect(payload.fields[0]!.source).toBe('seed');
  });

  it('does NOT brain-seed a Tier-3-only field (no brain path)', async () => {
    const brain = assembleBrain({
      brandSlug: 'summit',
      sellerRows: [{ ID: 7, MerchantAlias: 'Summit', ACOSTarget: '25.0' }],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@test',
      now: NOW,
    });
    await saveBrain(brain, testDir);

    const m: CalibrationManifest = {
      schema_version: 1,
      fields: [
        {
          id: 'objective',
          prompt: 'Posture?',
          type: 'enum',
          options: [
            { value: 'scale', label: 'Scale' },
            { value: 'defend', label: 'Defend' },
          ],
          seed_from: 'context.posture.stance',
          required: false,
          deprecated: false,
        },
      ],
    };
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'x',
      manifest: m,
      dataDirOverride: testDir,
    });
    // posture.stance is Tier-3-only — brain carries no value, so the seed stays unset.
    expect(payload.fields[0]!.seed_value).toBeUndefined();
    expect(payload.fields[0]!.source).toBe('missing');
  });
});

describe('prepareConfirmation', () => {
  it('flags first run when no config.yaml exists', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    expect(payload.is_first_run).toBe(true);
    expect(payload.fields).toHaveLength(3);
  });

  it('resolves seed_from from context.yaml on first run', async () => {
    const ctxYaml = `
schema_version: 1
brand_slug: summit
brand_name: Summit
last_updated: 2026-05-01
accounts:
  - seller_id: 123
    seller_name: Test
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
  acos_target_pct: 30
  attribution_window_days: 7
posture:
  stance: defend
  multiplier: 0.5
`;
    await writeFile(join(brandDir, 'context.yaml'), ctxYaml, 'utf-8');
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const objective = payload.fields.find((f) => f.field.id === 'objective')!;
    expect(objective.source).toBe('seed');
    expect(objective.effective_value).toBe('defend');
  });

  it('uses default when no seed and no stored', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const dampening = payload.fields.find((f) => f.field.id === 'dampening')!;
    expect(dampening.source).toBe('default');
    expect(dampening.effective_value).toBe(0.6);
  });

  it('uses stored value over seed', async () => {
    const ctxYaml = `posture: { stance: defend, multiplier: 0.5 }`;
    await writeFile(join(brandDir, 'context.yaml'), ctxYaml, 'utf-8');
    await writeFile(
      join(brandDir, 'config.yaml'),
      `dhc:\n  objective: growth\n`,
      'utf-8',
    );
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const objective = payload.fields.find((f) => f.field.id === 'objective')!;
    expect(objective.source).toBe('stored');
    expect(objective.effective_value).toBe('growth');
    expect(objective.seed_value).toBe('defend'); // seed still surfaced for context
  });

  it('flags missing required when no seed, no default', async () => {
    // No context, no stored — objective has no default so it's missing.
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    expect(payload.blocking.has_missing_required).toBe(true);
    expect(payload.blocking.missing_keys).toEqual(['objective']);
  });

  it('surfaces user-added extras', async () => {
    await writeFile(
      join(brandDir, 'config.yaml'),
      `dhc:\n  objective: growth\n  custom_field: hello\n`,
      'utf-8',
    );
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    expect(payload.extras).toEqual({ custom_field: 'hello' });
  });
});

describe('applyConfirmation — confirm action', () => {
  it('returns effective config without persisting on confirm-as-is', async () => {
    await writeFile(
      join(brandDir, 'config.yaml'),
      `dhc:\n  objective: growth\n`,
      'utf-8',
    );
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      { action: 'confirm' },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_persist).toBe(false);
    expect(result.effective_config).toMatchObject({
      objective: 'growth',
      dampening: 0.6,
    });
  });

  it('blocks confirm when required fields are missing', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      { action: 'confirm' },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(result.validation_issues.some((i) => i.field === 'objective')).toBe(true);
  });
});

describe('applyConfirmation — edit action', () => {
  it('parses edits and persists when save=true', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      {
        action: 'edit',
        edits: { objective: 'growth', dampening: '0.4' },
        save: true,
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_persist).toBe(true);
    expect(result.effective_config).toMatchObject({
      objective: 'growth',
      dampening: 0.4,
    });
    // Verify it actually persisted
    const raw = await readFile(join(brandDir, 'config.yaml'), 'utf-8');
    expect(raw).toMatch(/objective: growth/);
    expect(raw).toMatch(/dampening: 0\.4/);
  });

  it('does not persist when save=false', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      {
        action: 'edit',
        edits: { objective: 'growth' },
        save: false,
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_persist).toBe(false);
    expect(result.effective_config).toMatchObject({ objective: 'growth' });
    // File should not exist
    await expect(readFile(join(brandDir, 'config.yaml'), 'utf-8')).rejects.toThrow();
  });

  it('preserves extras through edit + save', async () => {
    await writeFile(
      join(brandDir, 'config.yaml'),
      `dhc:\n  objective: growth\n  custom: preserved\n`,
      'utf-8',
    );
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      {
        action: 'edit',
        edits: { objective: 'profit' },
        save: true,
      },
      { dataDirOverride: testDir },
    );
    expect(result.did_persist).toBe(true);
    const raw = await readFile(join(brandDir, 'config.yaml'), 'utf-8');
    expect(raw).toMatch(/objective: profit/);
    expect(raw).toMatch(/custom: preserved/);
  });

  it('returns validation_failed without persisting on bad input', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      {
        action: 'edit',
        edits: { objective: 'invalid-value', dampening: '0.4' },
        save: true,
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_persist).toBe(false);
    expect(result.validation_issues.some((i) => i.field === 'objective')).toBe(true);
  });

  it('rejects edits to unknown fields', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      {
        action: 'edit',
        edits: { not_a_field: 'whatever' },
        save: true,
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(result.validation_issues.some((i) => i.field === 'not_a_field')).toBe(true);
  });
});

describe('applyConfirmation — cancel', () => {
  it('returns cancelled status without persisting', async () => {
    const payload = await prepareConfirmation({
      brandSlug: 'summit',
      brandName: 'Summit',
      skillId: 'dhc',
      manifest,
      dataDirOverride: testDir,
    });
    const result = await applyConfirmation(
      payload,
      { action: 'cancel' },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('cancelled');
    expect(result.did_persist).toBe(false);
  });
});

describe('writeRunOclSnapshot', () => {
  it('writes the snapshot under runs/<skill>/<date>/ocl.yaml', async () => {
    const result = await writeRunOclSnapshot({
      brandSlug: 'summit',
      skillId: 'dhc',
      runDate: '2026-05-18',
      effective: { objective: 'growth', dampening: 0.6 },
      dataDirOverride: testDir,
    });
    expect('path' in result).toBe(true);
    if ('path' in result) {
      const raw = await readFile(result.path, 'utf-8');
      expect(raw).toMatch(/skill_id: dhc/);
      expect(raw).toMatch(/objective: growth/);
    }
  });
});
