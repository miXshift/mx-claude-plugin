import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  prepareBrandConfigEdit,
  applyBrandConfigEdit,
} from './flow.js';

let testDir: string;
let brandDir: string;

const baseContextYaml = `
schema_version: 1
brand_slug: summit
brand_name: Summit Labs
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
  acos_target_pct: 28
  attribution_window_days: 7
`;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-brandcfg-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  brandDir = join(testDir, 'clients', 'summit');
  await mkdir(brandDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('prepareBrandConfigEdit', () => {
  it('flags context_missing when no context.yaml exists', async () => {
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    expect(payload.context_missing).toBe(true);
    expect(payload.fields).toHaveLength(0);
  });

  it('reads stored values from context.yaml', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    expect(payload.context_missing).toBe(false);
    const primary = payload.fields.find((f) => f.field.id === 'primary_metric')!;
    expect(primary.stored_value).toBe('ACOS');
    expect(primary.source).toBe('stored');
    const acos = payload.fields.find((f) => f.field.id === 'acos_target_pct')!;
    expect(acos.stored_value).toBe(0.28);
  });

  it('marks unset optional fields as missing', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const tacos = payload.fields.find((f) => f.field.id === 'tacos_target_pct')!;
    expect(tacos.stored_value).toBeUndefined();
    expect(tacos.source).toBe('missing');
    expect(payload.blocking.has_missing_required).toBe(false); // optional
  });

  it('applies manifest defaults when no stored value', async () => {
    // attribution_window_days has default 7
    const yaml = baseContextYaml.replace('attribution_window_days: 7\n', '');
    await writeFile(join(brandDir, 'context.yaml'), yaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const attr = payload.fields.find(
      (f) => f.field.id === 'attribution_window_days',
    )!;
    expect(attr.source).toBe('default');
    expect(attr.effective_value).toBe(7);
  });
});

describe('percent unit bridging — whole-number context storage', () => {
  it('renders a whole-number stored percent correctly (28 -> "28%")', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const acos = payload.fields.find((f) => f.field.id === 'acos_target_pct')!;
    expect(acos.effective_value).toBe(0.28); // [0,1] internally
    expect(acos.display).toBe('28%'); // rendered as a whole percent
  });

  it('round-trips an edit: writes whole, reads back as the same percent', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    let payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '32' } },
      { dataDirOverride: testDir },
    );
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/acos_target_pct: 32\b/); // whole on disk
    payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const acos = payload.fields.find((f) => f.field.id === 'acos_target_pct')!;
    expect(acos.display).toBe('32%');
    expect(acos.effective_value).toBe(0.32);
  });
});

describe('applyBrandConfigEdit — confirm action', () => {
  it('returns ok without writing on confirm-as-is', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'confirm' },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(false);
  });
});

describe('applyBrandConfigEdit — edit action', () => {
  it('writes edits to context.yaml at the dotted paths', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      {
        action: 'edit',
        edits: { acos_target_pct: '32', tacos_target_pct: '18' },
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);
    expect(result.changed_field_count).toBe(2);

    // Verify on-disk — stored WHOLE (the context.yaml convention), not [0,1].
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/acos_target_pct: 32\b/);
    expect(raw).toMatch(/tacos_target_pct: 18\b/);
  });

  it('preserves untouched fields (accounts, sources)', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '32' } },
      { dataDirOverride: testDir },
    );
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/seller_id: 123/);
    expect(raw).toMatch(/ad_metrics: ads/);
  });

  it('bumps last_updated when a write happens', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '32' } },
      { dataDirOverride: testDir },
    );
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    expect(raw).toContain(`last_updated: ${today}`);
  });

  it('does NOT bump last_updated when no value actually changed', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    // "Edit" to the same value — should no-op
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '28' } },
      { dataDirOverride: testDir },
    );
    expect(result.did_write).toBe(false);
    expect(result.changed_field_count).toBe(0);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('last_updated: 2026-05-01'); // unchanged
  });

  it('returns validation_failed without writing on bad input', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      {
        action: 'edit',
        edits: { primary_metric: 'invalid', acos_target_pct: '32' },
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    // File should be unchanged
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('primary_metric: ACOS');
    expect(raw).toContain('acos_target_pct: 28');
  });

  it('rejects edits to unknown brand-config fields', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { not_a_field: 'whatever' } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(
      result.validation_issues.some((i) => i.field === 'not_a_field'),
    ).toBe(true);
  });
});

describe('applyBrandConfigEdit — cancel + context_missing', () => {
  it('returns cancelled without touching the file', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'cancel' },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('cancelled');
    expect(result.did_write).toBe(false);
  });

  it('returns context_missing when context.yaml does not exist', async () => {
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: '32' } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('context_missing');
    expect(result.did_write).toBe(false);
  });
});
