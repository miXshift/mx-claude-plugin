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
    const tacos = payload.fields.find((f) => f.field.id === 'tacos_goal_pct')!;
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

  it('editing acos_target_pct stamps acos_target_source: user (provenance supersedes bootstrap)', async () => {
    // A brand bootstrapped with the placeholder default must not keep looking
    // like a placeholder after the user explicitly sets the real target.
    await writeFile(
      join(brandDir, 'context.yaml'),
      baseContextYaml.replace(
        /acos_target_pct: 28/,
        'acos_target_pct: 20\n  acos_target_source: default',
      ),
      'utf-8',
    );
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
    expect(raw).toMatch(/acos_target_pct: 32\b/);
    expect(raw).toMatch(/acos_target_source: user\b/);
    expect(raw).not.toMatch(/acos_target_source: default\b/);
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

describe('applyBrandConfigEdit — malformed decisions fail closed (backlog #24)', () => {
  // `decision` arrives from `JSON.parse(...) as BrandConfigDecision` in
  // commands/brand-config.ts, an unchecked cast, so the compile-time union is
  // not a runtime guarantee. These drive the shapes that cast lets through.

  it('does NOT take the write path for an unknown action', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const before = await readFile(join(brandDir, 'context.yaml'), 'utf-8');

    const result = await applyBrandConfigEdit(
      payload,
      // A plausible typo. This used to fall through to the edit path, which
      // persists AND calls pushAfterWrite(), publishing unconfirmed edits to
      // the shared org store.
      { action: 'edt', edits: { acos_target_pct: '32' } } as never,
      { dataDirOverride: testDir },
    );

    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    expect(result.written_to).toBeNull();
    expect(result.changed_field_count).toBe(0);
    expect(result.validation_issues[0]?.field).toBe('action');
    // Names what was received and what is allowed, rather than failing mutely.
    expect(result.validation_issues[0]?.message).toContain('edt');
    expect(result.validation_issues[0]?.message).toContain('edit');

    // The strongest assertion: disk is byte-identical, so nothing was written
    // and therefore nothing could have been published.
    expect(await readFile(join(brandDir, 'context.yaml'), 'utf-8')).toBe(before);
  });

  it('does not crash when edits is missing entirely', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    // `{"action":"edit"}` used to reach Object.entries(undefined) and throw a
    // bare TypeError. #125 hardened the VALUES; this is the CONTAINER.
    const result = await applyBrandConfigEdit(payload, { action: 'edit' } as never, {
      dataDirOverride: testDir,
    });
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    expect(result.validation_issues[0]?.field).toBe('edits');
    expect(result.validation_issues[0]?.message).toContain('undefined');
  });

  it('rejects non-object edits containers by type, naming what arrived', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    for (const [edits, described] of [
      [null, 'null'],
      ['acos_target_pct=32', 'string'],
      [42, 'number'],
      // An array would "work" in Object.entries and silently treat indices as
      // field names, so it is rejected rather than half-accepted.
      [[{ acos_target_pct: '32' }], 'array'],
    ] as Array<[unknown, string]>) {
      const result = await applyBrandConfigEdit(payload, { action: 'edit', edits } as never, {
        dataDirOverride: testDir,
      });
      expect(result.status, `edits=${described}`).toBe('validation_failed');
      expect(result.did_write, `edits=${described}`).toBe(false);
      expect(result.validation_issues[0]?.message, `edits=${described}`).toContain(described);
    }
  });

  it('still accepts an empty edits object as a valid no-op', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    // The guard must reject malformed containers without also rejecting a
    // legitimately empty one.
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: {} },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.changed_field_count).toBe(0);
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
        edits: { acos_target_pct: '32', tacos_goal_pct: '18' },
      },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);
    expect(result.changed_field_count).toBe(2);

    // Verify on-disk — stored WHOLE (the context.yaml convention), not [0,1].
    // Edits always write the canonical field, never the deprecated alias.
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/acos_target_pct: 32\b/);
    expect(raw).toMatch(/tacos_goal_pct: 18\b/);
    expect(raw).not.toMatch(/tacos_target_pct/);
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

describe('applyBrandConfigEdit — JSON-typed edit values (feedback 47801)', () => {
  // `--apply` decodes the decision from JSON, so an edit value can arrive
  // as any JSON type. Repro from the report:
  //   mixshift brand config <slug> --apply
  //     '{"action":"edit","edits":{"acos_target_pct":20}}'
  // used to throw "raw.trim is not a function" from deep inside
  // parseFieldInput, because that function assumes chat-style string input
  // and calls raw.trim() unconditionally.

  it('accepts a JSON number edit value instead of crashing', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      // Simulates --apply '{"action":"edit","edits":{"acos_target_pct":20}}'
      // — JSON.parse hands us a real number here, not a string.
      { action: 'edit', edits: { acos_target_pct: 20 } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toMatch(/acos_target_pct: 20\b/);
  });

  it('a numeric edit value behaves identically to the equivalent string', async () => {
    // Two independent brands so the number-vs-string calls don't observe
    // each other's write (a second identical edit is correctly a no-op).
    const brandDirB = join(testDir, 'clients', 'summit-b');
    await mkdir(brandDirB, { recursive: true });
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    await writeFile(join(brandDirB, 'context.yaml'), baseContextYaml, 'utf-8');

    const payloadA = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const payloadB = await prepareBrandConfigEdit({
      brandSlug: 'summit-b',
      brandName: 'Summit Labs B',
      dataDirOverride: testDir,
    });

    const numberResult = await applyBrandConfigEdit(
      payloadA,
      { action: 'edit', edits: { attribution_window_days: 14 } },
      { dataDirOverride: testDir },
    );
    const stringResult = await applyBrandConfigEdit(
      payloadB,
      { action: 'edit', edits: { attribution_window_days: '14' } },
      { dataDirOverride: testDir },
    );

    expect(numberResult.status).toBe('ok');
    expect(numberResult.changed_field_count).toBe(1);
    expect(numberResult.changed_field_count).toBe(
      stringResult.changed_field_count,
    );
    const rawA = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    const rawB = await readFile(join(brandDirB, 'context.yaml'), 'utf-8');
    expect(rawA).toMatch(/attribution_window_days: 14\b/);
    expect(rawB).toMatch(/attribution_window_days: 14\b/);
  });

  it('names the failing field when a value cannot be accepted at all', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      // An object has no unambiguous string reading — must fail with a
      // field-scoped message, never a bare runtime crash.
      { action: 'edit', edits: { acos_target_pct: { nested: true } } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    const issue = result.validation_issues.find(
      (i) => i.field === 'acos_target_pct',
    );
    expect(issue?.message).toBe('Expected a string or number, got object');
  });

  it('names the field for a null edit value', async () => {
    await writeFile(join(brandDir, 'context.yaml'), baseContextYaml, 'utf-8');
    const payload = await prepareBrandConfigEdit({
      brandSlug: 'summit',
      brandName: 'Summit Labs',
      dataDirOverride: testDir,
    });
    const result = await applyBrandConfigEdit(
      payload,
      { action: 'edit', edits: { acos_target_pct: null } },
      { dataDirOverride: testDir },
    );
    expect(result.status).toBe('validation_failed');
    const issue = result.validation_issues.find(
      (i) => i.field === 'acos_target_pct',
    );
    expect(issue?.message).toBe('Expected a string or number, got null');
  });

  it('does not corrupt other valid edits when one field in the same call is rejected', async () => {
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
        edits: { acos_target_pct: 32, tacos_goal_pct: ['not', 'valid'] },
      },
      { dataDirOverride: testDir },
    );
    // Whole-call validate-then-write: one bad field fails the batch and
    // nothing is written, same as the existing mixed-validity behavior.
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    const raw = await readFile(join(brandDir, 'context.yaml'), 'utf-8');
    expect(raw).toContain('acos_target_pct: 28');
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
