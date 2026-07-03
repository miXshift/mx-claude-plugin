import { describe, it, expect, afterEach } from 'vitest';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  contextSchema,
  normalizeLegacyTacosFields,
  REQUIRED_TOP_LEVEL_FIELDS,
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
});

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
