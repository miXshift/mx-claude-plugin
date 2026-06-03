import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readBrandConfig,
  saveSkillConfig,
  resetSkillConfig,
  buildSkillConfigView,
  composeSkillBlock,
  validateAgainstManifest,
} from './brand-config.js';
import type { CalibrationManifest } from './manifest-schema.js';

const sampleManifest: CalibrationManifest = {
  schema_version: 1,
  fields: [
    {
      id: 'objective',
      prompt: 'Posture?',
      type: 'enum',
      options: [
        { value: 'growth', label: 'Growth' },
        { value: 'profit', label: 'Profit' },
      ],
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
  testDir = join(tmpdir(), `mxtest-brandconfig-${process.pid}-${Date.now()}-${Math.random()}`);
  brandDir = join(testDir, 'clients', 'skratch');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('readBrandConfig', () => {
  it('returns empty config when file missing', async () => {
    const r = await readBrandConfig('skratch', testDir);
    expect(r.source).toBe('empty');
    expect(r.config).toEqual({});
  });

  it('returns empty config when file is empty', async () => {
    await writeFile(join(brandDir, 'config.yaml'), '', 'utf-8');
    const r = await readBrandConfig('skratch', testDir);
    expect(r.source).toBe('file');
    expect(r.config).toEqual({});
  });

  it('throws helpful error on malformed YAML', async () => {
    await writeFile(join(brandDir, 'config.yaml'), 'not: valid: yaml: [unclosed', 'utf-8');
    await expect(readBrandConfig('skratch', testDir)).rejects.toThrow(/malformed YAML/);
  });

  it('preserves user-added passthrough fields', async () => {
    const yaml = `
mx-daily-health-check:
  objective: growth
  dampening: 0.6
  custom_field: "user-added value"
  another: { nested: true }
`;
    await writeFile(join(brandDir, 'config.yaml'), yaml, 'utf-8');
    const r = await readBrandConfig('skratch', testDir);
    expect(r.config['mx-daily-health-check']).toMatchObject({
      objective: 'growth',
      dampening: 0.6,
      custom_field: 'user-added value',
      another: { nested: true },
    });
  });
});

describe('buildSkillConfigView', () => {
  it('returns first_run true when no stored block', () => {
    const view = buildSkillConfigView(undefined, sampleManifest);
    expect(view.is_first_run).toBe(true);
    expect(view.user_set_keys).toEqual([]);
  });

  it('applies defaults for missing-but-defaulted fields', () => {
    const view = buildSkillConfigView({ objective: 'growth' }, sampleManifest);
    expect(view.effective).toMatchObject({
      objective: 'growth',
      dampening: 0.6, // from default
      hero_skus: [], // from default
    });
    expect(view.user_set_keys).toEqual(['objective']);
  });

  it('flags required fields with no value AND no default as missing', () => {
    // objective has no default
    const view = buildSkillConfigView({}, sampleManifest);
    expect(view.missing_required_keys).toEqual(['objective']);
  });

  it('partitions extras (user-added) from manifest fields', () => {
    const stored = {
      objective: 'growth',
      dampening: 0.5,
      custom_field: 'user thing',
      another: 42,
    };
    const view = buildSkillConfigView(stored, sampleManifest);
    expect(view.extras).toEqual({
      custom_field: 'user thing',
      another: 42,
    });
    expect(view.effective).not.toHaveProperty('custom_field');
  });

  it('treats every stored key as extras when manifest is null', () => {
    const view = buildSkillConfigView({ anything: 'goes' }, null);
    expect(view.extras).toEqual({ anything: 'goes' });
    expect(view.missing_required_keys).toEqual([]);
  });
});

describe('saveSkillConfig + resetSkillConfig', () => {
  it('writes a new skill block', async () => {
    await saveSkillConfig(
      'skratch',
      'mx-daily-health-check',
      { objective: 'growth', dampening: 0.6 },
      testDir,
    );
    const { config } = await readBrandConfig('skratch', testDir);
    expect(config['mx-daily-health-check']).toEqual({
      objective: 'growth',
      dampening: 0.6,
    });
  });

  it('round-trips other skill blocks', async () => {
    await saveSkillConfig('skratch', 'skill-a', { a: 1 }, testDir);
    await saveSkillConfig('skratch', 'skill-b', { b: 2 }, testDir);
    const { config } = await readBrandConfig('skratch', testDir);
    expect(config).toEqual({
      'skill-a': { a: 1 },
      'skill-b': { b: 2 },
    });
  });

  it('replaces (not merges) when re-saving a skill block', async () => {
    await saveSkillConfig(
      'skratch',
      'dhc',
      { objective: 'growth', dampening: 0.6 },
      testDir,
    );
    await saveSkillConfig('skratch', 'dhc', { objective: 'profit' }, testDir);
    const { config } = await readBrandConfig('skratch', testDir);
    expect(config['dhc']).toEqual({ objective: 'profit' });
  });

  it('preserves extras via composeSkillBlock', async () => {
    await saveSkillConfig(
      'skratch',
      'dhc',
      { objective: 'growth', custom: 'preserved' },
      testDir,
    );
    const { config: before } = await readBrandConfig('skratch', testDir);
    const view = buildSkillConfigView(before['dhc'], sampleManifest);
    // Compose new manifest values with preserved extras
    const composed = composeSkillBlock({ objective: 'profit', dampening: 0.5 }, view.extras);
    await saveSkillConfig('skratch', 'dhc', composed, testDir);
    const { config: after } = await readBrandConfig('skratch', testDir);
    expect(after['dhc']).toEqual({
      objective: 'profit',
      dampening: 0.5,
      custom: 'preserved',
    });
  });

  it('reset removes the skill block but leaves others alone', async () => {
    await saveSkillConfig('skratch', 'skill-a', { a: 1 }, testDir);
    await saveSkillConfig('skratch', 'skill-b', { b: 2 }, testDir);
    const result = await resetSkillConfig('skratch', 'skill-a', testDir);
    expect(result.existed).toBe(true);
    const { config } = await readBrandConfig('skratch', testDir);
    expect(config).toEqual({ 'skill-b': { b: 2 } });
  });

  it('reset is idempotent (no-op when block absent)', async () => {
    const result = await resetSkillConfig('skratch', 'nope', testDir);
    expect(result.existed).toBe(false);
  });

  it('deletes file when last skill block is reset', async () => {
    await saveSkillConfig('skratch', 'only-skill', { x: 1 }, testDir);
    await resetSkillConfig('skratch', 'only-skill', testDir);
    const r = await readBrandConfig('skratch', testDir);
    expect(r.source).toBe('empty');
  });
});

describe('validateAgainstManifest', () => {
  it('accepts complete valid values', () => {
    const r = validateAgainstManifest(
      {
        objective: 'growth',
        dampening: 0.5,
        hero_skus: ['B07XYZ1234'],
      },
      sampleManifest,
    );
    expect(r.ok).toBe(true);
  });

  it('flags required missing (no default)', () => {
    const r = validateAgainstManifest({ dampening: 0.5 }, sampleManifest);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'objective')).toBe(true);
  });

  it('flags out-of-range float', () => {
    const r = validateAgainstManifest(
      { objective: 'growth', dampening: 2.0 },
      sampleManifest,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'dampening')).toBe(true);
  });

  it('flags malformed ASIN', () => {
    const r = validateAgainstManifest(
      {
        objective: 'growth',
        dampening: 0.5,
        hero_skus: ['notvalid'],
      },
      sampleManifest,
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === 'hero_skus')).toBe(true);
  });
});
