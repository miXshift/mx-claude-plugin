import { describe, it, expect, afterEach } from 'vitest';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  contextSchema,
  normalizeLegacyTacosFields,
  REQUIRED_TOP_LEVEL_FIELDS,
  RESERVED_EVENT_KINDS,
  STRUCTURAL_EVENT_TYPES,
} from './schema.js';
import { validateBrandContext } from './load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up to plugin root: src/lib/context/ → src/lib/ → src/ → harness/ → plugin/
const pluginRoot = join(__dirname, '..', '..', '..', '..');
const yamlSchemaPath = join(
  pluginRoot,
  'shared',
  'clients',
  '_schema',
  'context.schema.yaml',
);
const templatePath = join(
  pluginRoot,
  'shared',
  'clients',
  '_template',
  'context.yaml',
);

describe('contextSchema — basic shape', () => {
  it('accepts a minimal valid context', () => {
    const minimal = {
      schema_version: 1,
      brand_slug: 'acme-corp',
      brand_name: 'Acme Corp',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 12345,
          seller_name: 'Acme Corp Seller',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'campaignmetric',
        ops_revenue: 'business_reports_dpst_date',
        ops_revenue_field: 'SalesAmount',
        ops_units_field: 'UnitsOrdered',
        ops_date_field: 'DateTime',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 20.0,
        attribution_window_days: 14,
      },
    };

    const result = contextSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('rejects missing required top-level field', () => {
    const broken = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      // missing last_updated
      accounts: [],
      sources: {
        ad_metrics: 'campaignmetric',
        ops_revenue: 'br',
        ops_revenue_field: 'x',
        ops_units_field: 'y',
        ops_date_field: 'z',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
    };
    const result = contextSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it('rejects bad slug (uppercase / starts with digit)', () => {
    const bad = (slug: string) => ({
      schema_version: 1,
      brand_slug: slug,
      brand_name: 'X',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 1,
          seller_name: 'X',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
    });

    expect(contextSchema.safeParse(bad('Acme')).success).toBe(false);
    expect(contextSchema.safeParse(bad('123brand')).success).toBe(false);
    expect(contextSchema.safeParse(bad('acme-corp')).success).toBe(true);
  });

  it('rejects bad account enums', () => {
    const ctx = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 1,
          seller_name: 'X',
          account_type: 'WRONG', // bad enum
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
    };
    const result = contextSchema.safeParse(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('account_type'))).toBe(true);
    }
  });

  it('requires TACOS-primary accounts to define a TACOS goal', () => {
    const ctx = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 1,
          seller_name: 'X',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'TACOS', // missing tacos_goal_pct / tacos_target_pct
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
    };
    const result = contextSchema.safeParse(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.message.toLowerCase().includes('tacos'),
        ),
      ).toBe(true);
    }
  });

  it('accepts a TACOS-primary account whose only TACOS field is the deprecated tacos_target_pct alias', () => {
    // Pre-normalization Zod parse (no loader in the middle) — the alias must
    // still satisfy the refinement on its own, for callers that parse raw
    // objects directly (e.g. this test file, or any future direct caller).
    const ctx = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 1,
          seller_name: 'X',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'TACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
        tacos_target_pct: 12.5, // deprecated alias only
      },
    };
    const result = contextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
  });

  it('requires at least one account', () => {
    const ctx = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      last_updated: '2026-05-13',
      accounts: [],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
    };
    const result = contextSchema.safeParse(ctx);
    expect(result.success).toBe(false);
  });
});

describe('contextSchema — drift check against canonical YAML schema', () => {
  it('top-level required fields match the canonical YAML schema', async () => {
    const raw = await readFile(yamlSchemaPath, 'utf-8');
    const yamlSchema = parseYaml(raw) as {
      required_top_level: string[];
    };
    expect(yamlSchema.required_top_level).toBeDefined();

    // Both lists, sorted, must match exactly. This catches drift in either
    // direction — if the YAML adds a required field we forget to encode in
    // Zod, or vice versa, the test fails.
    const yamlSorted = [...yamlSchema.required_top_level].sort();
    const zodSorted = [...REQUIRED_TOP_LEVEL_FIELDS].sort();
    expect(zodSorted).toEqual(yamlSorted);
  });

  it('the known structural_event types match the canonical YAML schema (#37499)', async () => {
    const raw = await readFile(yamlSchemaPath, 'utf-8');
    const yamlSchema = parseYaml(raw) as {
      shapes: { structural_event: { enums: { type: string[] } } };
    };
    const yamlTypes = [...yamlSchema.shapes.structural_event.enums.type].sort();
    // The documented/known set must match in BOTH directions.
    expect([...STRUCTURAL_EVENT_TYPES].sort()).toEqual(yamlTypes);
    // Pin the count so an addition on either side forces this test open.
    expect(yamlTypes).toHaveLength(12);
    for (const t of yamlTypes) {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e', type: t, interpretation: 'x', kind: 'probe' }),
      );
      expect(r.success, `type '${t}' should validate`).toBe(true);
    }
  });
});

// A minimal valid context wrapping one structural event (shared by the
// #37499 taxonomy tests below).
function contextWithEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    brand_slug: 'acme',
    brand_name: 'Acme',
    last_updated: '2026-08-03',
    accounts: [
      {
        seller_id: 1,
        seller_name: 'Acme Seller',
        account_type: 'SC',
        status: 'active',
        role: 'primary',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    },
    management: {
      primary_metric: 'ACOS',
      acos_target_pct: 20.0,
      attribution_window_days: 14,
    },
    structural_events: [event],
  };
}

describe('structural_events — #37499 taxonomy flexibility', () => {
  it.each(['off_amazon_media', 'assortment_change'])(
    'accepts the new type %s without a kind',
    (type) => {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e1', type, interpretation: 'why it matters' }),
      );
      expect(r.success).toBe(true);
    },
  );

  it("type 'other' REQUIRES a kind (the escape must not lose specificity)", () => {
    const without = contextSchema.safeParse(
      contextWithEvent({ id: 'e1', type: 'other', interpretation: 'x' }),
    );
    expect(without.success).toBe(false);
    if (!without.success) {
      expect(JSON.stringify(without.error.issues)).toContain('requires a kind');
    }
    const withKind = contextSchema.safeParse(
      contextWithEvent({
        id: 'e1',
        type: 'other',
        kind: 'retail_media_network_test',
        interpretation: 'x',
      }),
    );
    expect(withKind.success).toBe(true);
  });

  it('an UNKNOWN type slug is tolerated, not rejected (forward compatibility)', () => {
    // A newer plugin may add a type this build has never heard of, and
    // context.yaml travels between machines via the org store. Hard-failing
    // would take the whole brand down for every skill on the older client
    // (exactly what the 0.8.7 enum did when this release added three values).
    const r = contextSchema.safeParse(
      contextWithEvent({ id: 'e1', type: 'some_future_type', interpretation: 'x' }),
    );
    expect(r.success).toBe(true);
  });

  it('a non-slug type is still rejected (typo protection survives)', () => {
    for (const bad of ['Promotional Window', 'promo-window', '2026_promo', '']) {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e1', type: bad, interpretation: 'x' }),
      );
      expect(r.success, `type '${bad}' should be rejected`).toBe(false);
    }
  });

  it.each([...RESERVED_EVENT_KINDS])(
    'kind cannot be the server-reserved slug %s',
    (reserved) => {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e1', type: 'launch', kind: reserved, interpretation: 'x' }),
      );
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(JSON.stringify(r.error.issues)).toContain('reserves those');
      }
    },
  );

  it('kind must be a lowercase snake_case slug', () => {
    for (const bad of ['Has Caps', 'kebab-case', '1leading', 'a'.repeat(65)]) {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e1', type: 'launch', kind: bad, interpretation: 'x' }),
      );
      expect(r.success, `kind '${bad}' should be rejected`).toBe(false);
    }
  });

  it('tags accept lowercase slugs and reject shape violations', () => {
    const ok = contextSchema.safeParse(
      contextWithEvent({
        id: 'e1',
        type: 'launch',
        interpretation: 'x',
        tags: ['mmm', 'backbone-media', 'q3_2026'],
      }),
    );
    expect(ok.success).toBe(true);
    for (const bad of [['UPPER'], ['has space'], ['x'.repeat(65)], Array.from({ length: 17 }, (_v, i) => `t${i}`)]) {
      const r = contextSchema.safeParse(
        contextWithEvent({ id: 'e1', type: 'launch', interpretation: 'x', tags: bad }),
      );
      expect(r.success, `tags ${JSON.stringify(bad).slice(0, 40)} should be rejected`).toBe(false);
    }
  });
});

describe('binding — sub-brand context block (mx-ops#6 P1)', () => {
  it('a context with no binding key still validates (old files, byte-for-byte)', () => {
    const r = contextSchema.safeParse(baseContext({}));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.binding).toBeUndefined();
  });

  it('accepts a fully-populated binding block', () => {
    const r = contextSchema.safeParse(
      baseContext({
        binding: {
          kind: 'sub_brand',
          amazon_seller_id: 'A1EXAMPLE23456',
          seller_ids: [123, 456],
          retail_label: { source: 'mws_items.Brand', value: 'Forager Pantry' },
          ads_label: { source: 'campaign.Brand', value: 'Forager Pantry' },
          scope_note:
            'This brand is label-scoped to one sub-brand of a larger seller account.',
        },
      }),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.binding?.kind).toBe('sub_brand');
      expect(r.data.binding?.retail_label?.source).toBe('mws_items.Brand');
    }
  });

  it('every field of binding is independently optional', () => {
    for (const partial of [
      {},
      { kind: 'sub_brand' },
      { amazon_seller_id: 'A1EXAMPLE23456' },
      { seller_ids: [1] },
      { retail_label: { source: 'vendor_items.CustomBrand', value: 'X' } },
      { scope_note: 'note only' },
    ]) {
      const r = contextSchema.safeParse(baseContext({ binding: partial }));
      expect(r.success, `binding ${JSON.stringify(partial)} should validate`).toBe(true);
    }
  });

  it('an UNKNOWN binding.kind is tolerated, not rejected (forward compatibility)', () => {
    // Same lesson as structural_events[].type (#37499): a future binding
    // kind (e.g. a joint-venture binding) must not hard-fail a context on an
    // older client just because this build has never heard of it.
    const r = contextSchema.safeParse(
      baseContext({ binding: { kind: 'joint_venture_binding' } }),
    );
    expect(r.success).toBe(true);
  });

  it('binding.kind must still be a lowercase snake_case slug', () => {
    for (const bad of ['Sub Brand', 'sub-brand', '1sub', 'a'.repeat(65)]) {
      const r = contextSchema.safeParse(baseContext({ binding: { kind: bad } }));
      expect(r.success, `binding.kind '${bad}' should be rejected`).toBe(false);
    }
  });

  it('a label source is NOT restricted to a closed enum (forward tolerance)', () => {
    // mws_items.Brand and vendor_items.CustomBrand are the two known retail
    // sources today, but the schema must not hard-enum them: a future third
    // source must not break an older client. Any non-empty short string
    // validates; typo protection is out of scope for this field on purpose.
    const r = contextSchema.safeParse(
      baseContext({
        binding: { retail_label: { source: 'some_future_table.Brand', value: 'X' } },
      }),
    );
    expect(r.success).toBe(true);
  });

  it('a label sub-object still requires a non-empty value when present', () => {
    const r = contextSchema.safeParse(
      baseContext({ binding: { retail_label: { source: 'mws_items.Brand', value: '' } } }),
    );
    expect(r.success).toBe(false);
  });

  it('scope_note is capped at 2000 characters', () => {
    const ok = contextSchema.safeParse(
      baseContext({ binding: { scope_note: 'x'.repeat(2000) } }),
    );
    expect(ok.success).toBe(true);
    const tooLong = contextSchema.safeParse(
      baseContext({ binding: { scope_note: 'x'.repeat(2001) } }),
    );
    expect(tooLong.success).toBe(false);
  });

  it('round-trips through YAML stringify/parse without loss', () => {
    // A cheap proxy for "the writer preserves the block": the context
    // editor and delta-merge both go through the `yaml` package, never
    // through this zod schema, for writes (see context-editor/flow.test.ts
    // and enrichment/delta-merge.test.ts for the full round-trip proof).
    const binding = {
      kind: 'sub_brand',
      amazon_seller_id: 'A1EXAMPLE23456',
      seller_ids: [123, 456],
      retail_label: { source: 'mws_items.Brand', value: 'Forager Pantry' },
      ads_label: { source: 'campaign.Brand', value: 'Forager Pantry' },
      scope_note: 'label-scoped sub-brand',
    };
    const yamlText = stringifyYaml(baseContext({ binding }));
    const roundTripped = parseYaml(yamlText);
    const r = contextSchema.safeParse(roundTripped);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.binding).toEqual(binding);
  });
});

/** A minimal valid context with no structural_events, for binding tests. */
function baseContext(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    brand_slug: 'acme',
    brand_name: 'Acme',
    last_updated: '2026-08-12',
    accounts: [
      {
        seller_id: 1,
        seller_name: 'Acme Seller',
        account_type: 'SC',
        status: 'active',
        role: 'primary',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    },
    management: {
      primary_metric: 'ACOS',
      acos_target_pct: 20.0,
      attribution_window_days: 14,
    },
    ...extra,
  };
}

describe('contextSchema — template is structurally valid', () => {
  it('the shipped _template/context.yaml does NOT validate as a real context (placeholders)', async () => {
    // The template uses <placeholder> strings for unknown values. It is
    // intentionally NOT valid as a real context — it must be populated by
    // cold-start or the user before validation. This test pins that
    // expectation so we don't accidentally ship a "valid" template that
    // looks like a real brand.
    const raw = await readFile(templatePath, 'utf-8');
    const parsed = parseYaml(raw);
    const result = contextSchema.safeParse(parsed);
    expect(result.success).toBe(false);
  });
});

describe('normalizeLegacyTacosFields — deprecated tacos_target_pct alias', () => {
  it('maps management.tacos_target_pct onto management.tacos_goal_pct', () => {
    const raw = {
      management: {
        primary_metric: 'TACOS',
        tacos_target_pct: 12.5,
      },
    };
    const normalized = normalizeLegacyTacosFields(raw) as {
      management: Record<string, unknown>;
    };
    expect(normalized.management.tacos_goal_pct).toBe(12.5);
    expect(normalized.management.tacos_target_pct).toBeUndefined();
  });

  it('a full context using only the deprecated alias loads and validates as tacos_goal_pct', () => {
    // End-to-end proof (schema-level, no filesystem): a customer
    // context.yaml written before the consolidation, using only the legacy
    // field, still validates after normalization — and the canonical field
    // is what comes out the other side.
    const legacyContext = {
      schema_version: 1,
      brand_slug: 'acme',
      brand_name: 'Acme',
      last_updated: '2026-05-13',
      accounts: [
        {
          seller_id: 1,
          seller_name: 'X',
          account_type: 'SC',
          status: 'active',
          role: 'primary',
        },
      ],
      sources: {
        ad_metrics: 'a',
        ops_revenue: 'b',
        ops_revenue_field: 'c',
        ops_units_field: 'd',
        ops_date_field: 'e',
      },
      management: {
        primary_metric: 'TACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
        tacos_target_pct: 8.25, // deprecated alias, no tacos_goal_pct set
      },
    };

    const normalized = normalizeLegacyTacosFields(legacyContext);
    const result = contextSchema.safeParse(normalized);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.management.tacos_goal_pct).toBe(8.25);
      expect(result.data.management.tacos_target_pct).toBeUndefined();
    }
  });

  it('prefers the canonical tacos_goal_pct when both fields are present', () => {
    const raw = {
      management: {
        tacos_goal_pct: 7,
        tacos_target_pct: 9,
      },
    };
    const normalized = normalizeLegacyTacosFields(raw) as {
      management: Record<string, unknown>;
    };
    expect(normalized.management.tacos_goal_pct).toBe(7);
    expect(normalized.management.tacos_target_pct).toBeUndefined();
  });

  it('is a no-op when tacos_target_pct is absent', () => {
    const raw = {
      management: { primary_metric: 'ACOS', tacos_goal_pct: 5 },
    };
    const normalized = normalizeLegacyTacosFields(raw);
    expect(normalized).toEqual(raw);
  });

  it('is a no-op for non-object input (defensive)', () => {
    expect(normalizeLegacyTacosFields(null)).toBeNull();
    expect(normalizeLegacyTacosFields(undefined)).toBeUndefined();
    expect(normalizeLegacyTacosFields('not an object')).toBe('not an object');
    expect(normalizeLegacyTacosFields([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('is a no-op when management is missing or malformed', () => {
    const raw = { brand_slug: 'acme' };
    expect(normalizeLegacyTacosFields(raw)).toEqual(raw);
  });
});

describe('validateBrandContext — deprecated tacos_target_pct alias on disk', () => {
  let testDir: string;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('loads a real context.yaml written with only the legacy alias and normalizes it', async () => {
    testDir = await mkdtemp(join(tmpdir(), 'mx-tacos-alias-'));
    const brandDir = join(testDir, 'clients', 'legacy-tacos-brand');
    await mkdir(brandDir, { recursive: true });
    await writeFile(
      join(brandDir, 'context.yaml'),
      `
schema_version: 1
brand_slug: legacy-tacos-brand
brand_name: Legacy Tacos Brand
last_updated: 2026-05-13
accounts:
  - seller_id: 42
    seller_name: Legacy Tacos Brand
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
  primary_metric: TACOS
  acos_target_pct: 22
  attribution_window_days: 14
  tacos_target_pct: 11.5
`,
      'utf-8',
    );

    const result = await validateBrandContext('legacy-tacos-brand', testDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Normalized onto the canonical field; the alias key is gone.
      expect(result.context.management.tacos_goal_pct).toBe(11.5);
      expect(
        (result.context.management as Record<string, unknown>).tacos_target_pct,
      ).toBeUndefined();
    }
  });
});
