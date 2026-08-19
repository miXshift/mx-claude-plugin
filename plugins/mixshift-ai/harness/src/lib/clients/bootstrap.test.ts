import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { BrandSuggestion } from '../discovery/brand-grouping.js';
import type { SellerRow } from '../discovery/seller-query.js';

// pushAfterWrite is invoked unconditionally at the end of a non-deferred
// bootstrap. Under the real module it always short-circuits to
// {published:false, reason:'disabled'} here anyway (bootstrapBrand never
// threads a test `env` through, so pushAfterWrite's own VITEST guard wins) —
// stub it explicitly so bootstrap.test.ts doesn't depend on that as an
// implementation detail, and so BootstrapResult.push's attempted-success/
// attempted-failure cases (which the real short-circuit can never produce)
// are reachable below.
vi.mock('../context-sync/push-after-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context-sync/push-after-write.js')>();
  return { ...actual, pushAfterWrite: vi.fn() };
});

import { bootstrapBrand, sortAccountsForPrimary } from './bootstrap.js';
import { contextSchema } from '../context/schema.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';

const mockedPushAfterWrite = vi.mocked(pushAfterWrite);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-bootstrap-test-'));
  // Default: matches today's real behavior (VITEST-guarded kill switch) so
  // every EXISTING test below is unaffected; individual tests override this
  // to exercise an attempted success/failure.
  mockedPushAfterWrite.mockResolvedValue({ published: false, reason: 'disabled' });
});

afterEach(async () => {
  mockedPushAfterWrite.mockReset();
  await rm(testDir, { recursive: true, force: true });
});

function row(overrides: Partial<SellerRow>): SellerRow {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    amazon_seller_id: 'A1XXX',
    merchant_alias: 'acme storefront',
    account_type: 'SC',
    marketplace: 'United States',
    region: 'NA',
    agency_name: null,
    acos_target: 22,
    ads_active: true,
    retail_active: true,
    is_active: true,
    has_mws: true,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function suggestion(rows: SellerRow[]): BrandSuggestion {
  return {
    slug: 'acme',
    display_name: 'Acme Corp',
    accounts: rows,
    ads_active: rows.some((r) => r.ads_active),
    retail_active: rows.some((r) => r.retail_active),
  };
}

describe('bootstrapBrand', () => {
  it('writes a schema-valid context.yaml + narrative.md + README.md', async () => {
    const result = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      asOfDate: '2026-05-14',
    });

    expect(result.brand_dir).toContain('acme');
    expect(result.written_files.length).toBeGreaterThanOrEqual(3);

    // context.yaml validates against the schema
    const yamlRaw = await readFile(result.context_path, 'utf-8');
    const parsed = parseYaml(yamlRaw);
    const validated = contextSchema.safeParse(parsed);
    expect(validated.success).toBe(true);

    if (validated.success) {
      expect(validated.data.brand_slug).toBe('acme');
      expect(validated.data.brand_name).toBe('Acme Corp');
      expect(validated.data.accounts).toHaveLength(1);
      expect(validated.data.accounts[0]!.role).toBe('primary');
      expect(validated.data.accounts[0]!.merchant_type).toBe('seller');
      expect(validated.data.management.acos_target_pct).toBe(22); // from warehouse
      expect(validated.data.management.acos_target_source).toBe('warehouse');
      expect(validated.data.sources.ops_revenue).toBe('business_reports_dpst_date');
    }

    // narrative.md has the canonical headings
    const narrative = await readFile(result.narrative_path, 'utf-8');
    expect(narrative).toContain('## Brand Identity');
    expect(narrative).toContain('## Current Quarter Context');
    expect(narrative).toContain('## Historical Notes');
  });

  it('uses VC sources when primary account is VC', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ account_type: 'VC', merchant_alias: 'vc storefront' })]),
      { dataDirOverride: testDir },
    );
    const yamlRaw = await readFile(result.context_path, 'utf-8');
    const parsed = parseYaml(yamlRaw) as Record<string, unknown>;
    const sources = parsed.sources as Record<string, string>;
    expect(sources.ops_revenue).toBe('vendor_sales_manufacturing_asin');
    expect(sources.ops_revenue_field).toBe('OrderedRevenueAmount');
    expect(sources.ops_units_field).toBe('OrderedUnits');
  });

  it('marks first sorted account primary, rest secondary', async () => {
    const result = await bootstrapBrand(
      suggestion([
        row({ seller_id: 1, account_type: 'VC', marketplace: 'Germany' }),
        row({ seller_id: 2, account_type: 'SC', marketplace: 'United States' }),
        row({ seller_id: 3, account_type: 'SC', marketplace: 'Canada' }),
      ]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<{ seller_id: number; role: string }>;

    // SC US is the most-preferred primary
    expect(accounts[0]!.seller_id).toBe(2);
    expect(accounts[0]!.role).toBe('primary');
    expect(accounts.slice(1).every((a) => a.role === 'secondary')).toBe(true);
  });

  it('defaults acos_target_pct to 20 when no warehouse value', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ acos_target: null })]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const management = yaml.management as Record<string, unknown>;
    expect(management.acos_target_pct).toBe(20);
    // The fallback must be labeled as a placeholder, not brand-derived truth:
    // skills key off this to avoid steering bid direction from a guessed 20.
    expect(management.acos_target_source).toBe('default');
  });

  it('context.yaml without acos_target_source still validates (pre-provenance files)', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ acos_target: null })]),
      { dataDirOverride: testDir },
    );
    const parsed = parseYaml(await readFile(result.context_path, 'utf-8')) as {
      management: Record<string, unknown>;
    };
    // Simulate a context.yaml written before the provenance field existed.
    delete parsed.management.acos_target_source;
    const validated = contextSchema.safeParse(parsed);
    expect(validated.success).toBe(true);
  });

  it('throws when slug directory already exists and force is not set', async () => {
    const s = suggestion([row({})]);
    await bootstrapBrand(s, { dataDirOverride: testDir });
    await expect(
      bootstrapBrand(s, { dataDirOverride: testDir }),
    ).rejects.toThrow(/already exists/);
  });

  it('overwrites when force is true', async () => {
    const s = suggestion([row({})]);
    await bootstrapBrand(s, { dataDirOverride: testDir });
    const result = await bootstrapBrand(s, {
      dataDirOverride: testDir,
      force: true,
    });
    expect(result.brand_dir).toBeDefined();
  });

  it('throws when all accounts have account_type = unknown', async () => {
    const s = suggestion([
      row({ account_type: 'unknown' }),
      row({ account_type: 'unknown', seller_id: 2 }),
    ]);
    await expect(
      bootstrapBrand(s, { dataDirOverride: testDir }),
    ).rejects.toThrow(/none of the 2 accounts are SC or VC/);
  });

  it('throws for DSP-only brands (no seller catalog; not cold-startable yet)', async () => {
    const s = suggestion([row({ account_type: 'DSP' })]);
    await expect(
      bootstrapBrand(s, { dataDirOverride: testDir }),
    ).rejects.toThrow(/none of the 1 accounts are SC or VC/);
  });

  it('filters out unknown account_type rows but proceeds if at least one SC/VC remains', async () => {
    const s: BrandSuggestion = {
      slug: 'mixed',
      display_name: 'Mixed Brand',
      accounts: [
        row({ seller_id: 1, account_type: 'unknown' }),
        row({ seller_id: 2, account_type: 'SC' }),
      ],
      ads_active: true,
      retail_active: true,
    };
    const result = await bootstrapBrand(s, { dataDirOverride: testDir });
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<{ seller_id: number }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.seller_id).toBe(2);
  });

  it('preserves merchant_alias on each account for reference', async () => {
    const result = await bootstrapBrand(
      suggestion([row({ merchant_alias: 'original-storefront-name' })]),
      { dataDirOverride: testDir },
    );
    const yaml = parseYaml(await readFile(result.context_path, 'utf-8')) as Record<string, unknown>;
    const accounts = yaml.accounts as Array<Record<string, unknown>>;
    expect(accounts[0]!.merchant_alias).toBe('original-storefront-name');
  });
});

// FINDING 3, red team over PR #131: buildContext rebuilds context.yaml from
// scratch on every bootstrap and has no knowledge of the sub-brand `binding`
// block, so a `--force` re-bootstrap of an already-bound sub-brand used to
// silently erase it (and auto-push the stripped context to the org store).
describe('bootstrapBrand — preserves an existing binding across --force', () => {
  const BINDING = {
    kind: 'sub_brand',
    amazon_seller_id: 'A1EXAMPLE23456',
    seller_ids: [1],
    retail_label: { source: 'mws_items.Brand', value: 'Forager Pantry' },
    ads_label: { source: 'campaign.Brand', value: 'Forager Pantry' },
    scope_note: 'This brand is label-scoped to one sub-brand of a larger seller account.',
  };

  it('carries an existing binding forward verbatim into a --force rebuild', async () => {
    // 1. First-time bootstrap (no binding yet).
    const first = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    expect(first.binding_preserved).toBe(false);

    // 2. Simulate the brand having since been bound as a sub-brand — inject
    //    a binding block directly onto the on-disk context.yaml, the same
    //    way a promotion flow (Phase 2) would.
    const bound = parseYaml(await readFile(first.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    bound.binding = BINDING;
    await writeFile(first.context_path, stringifyYaml(bound, { lineWidth: 0 }), 'utf-8');

    // 3. Re-bootstrap with --force, exactly what a re-run of `mixshift brand
    //    add <slug> --force` does (e.g. after a warehouse account-shape
    //    change). Without the fix, this rebuild would drop `binding`.
    const second = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      force: true,
    });
    expect(second.binding_preserved).toBe(true);

    const rewritten = parseYaml(await readFile(second.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(rewritten.binding).toEqual(BINDING);

    // The rebuilt file is still schema-valid with the binding in place.
    const revalidated = contextSchema.safeParse(rewritten);
    expect(revalidated.success).toBe(true);
    if (revalidated.success) expect(revalidated.data.binding).toEqual(BINDING);
  });

  it('a --force rebuild with NO existing binding reports binding_preserved: false (no-op, no fabrication)', async () => {
    await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    const second = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      force: true,
    });
    expect(second.binding_preserved).toBe(false);
    const rewritten = parseYaml(await readFile(second.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(rewritten.binding).toBeUndefined();
  });

  it('a malformed existing binding is never carried forward as if it were valid', async () => {
    const first = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    const bound = parseYaml(await readFile(first.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    // kind must be a lowercase snake_case slug — this violates that.
    bound.binding = { kind: 'Not A Valid Slug' };
    await writeFile(first.context_path, stringifyYaml(bound, { lineWidth: 0 }), 'utf-8');

    const second = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      force: true,
    });
    expect(second.binding_preserved).toBe(false);
  });

  it('does not change no-force behavior: the existing-directory error still fires with a binding present', async () => {
    const first = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    const bound = parseYaml(await readFile(first.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    bound.binding = BINDING;
    await writeFile(first.context_path, stringifyYaml(bound, { lineWidth: 0 }), 'utf-8');

    await expect(
      bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir }),
    ).rejects.toThrow(/already exists/);

    // Untouched — the no-force path errors out before writing anything.
    const untouched = parseYaml(await readFile(first.context_path, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(untouched.binding).toEqual(BINDING);
  });
});

describe('sortAccountsForPrimary', () => {
  it('puts SC ahead of VC', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'VC', marketplace: 'United States' }),
      row({ account_type: 'SC', marketplace: 'United States' }),
    ]);
    expect(sorted[0]!.account_type).toBe('SC');
  });

  it('within same type, prefers full-access over partial', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'SC', ads_active: false, retail_active: true }),
      row({ account_type: 'SC', ads_active: true, retail_active: true }),
    ]);
    expect(sorted[0]!.ads_active).toBe(true);
    expect(sorted[0]!.retail_active).toBe(true);
  });

  it('within same type and access, prefers US over non-US', () => {
    const sorted = sortAccountsForPrimary([
      row({ account_type: 'SC', marketplace: 'Canada' }),
      row({ account_type: 'SC', marketplace: 'United States' }),
    ]);
    expect(sorted[0]!.marketplace).toBe('United States');
  });
});

describe('bootstrapBrand — BootstrapResult.push', () => {
  it('populated {attempted:true, published:true} on an attempted, successful push', async () => {
    mockedPushAfterWrite.mockResolvedValue({
      published: true,
      pushed: 0,
      created: 2,
      conflicts: 0,
      errors: 0,
      reports: [],
    });
    const result = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    expect(mockedPushAfterWrite).toHaveBeenCalledTimes(1);
    expect(result.push).toEqual({ attempted: true, published: true });
  });

  it('populated {attempted:true, published:false, reason, detail} on an attempted, failed push', async () => {
    mockedPushAfterWrite.mockResolvedValue({
      published: false,
      reason: 'failed',
      detail: 'the auth service is unreachable',
    });
    const result = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    expect(result.push).toEqual({
      attempted: true,
      published: false,
      reason: 'failed',
      detail: 'the auth service is unreachable',
    });
  });

  it('populated {attempted:true, published:false, reason, detail} on an attempted skip (e.g. no local dir)', async () => {
    mockedPushAfterWrite.mockResolvedValue({
      published: false,
      reason: 'skipped',
      detail: 'no local brand directory',
    });
    const result = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    expect(result.push).toEqual({
      attempted: true,
      published: false,
      reason: 'skipped',
      detail: 'no local brand directory',
    });
  });

  it('populated {attempted:false, published:false, reason:"disabled"} when the kill switch blocks the attempt', async () => {
    mockedPushAfterWrite.mockResolvedValue({ published: false, reason: 'disabled' });
    const result = await bootstrapBrand(suggestion([row({})]), { dataDirOverride: testDir });
    expect(result.push).toEqual({ attempted: false, published: false, reason: 'disabled' });
  });

  it('left undefined, and pushAfterWrite never called, when deferPush is true', async () => {
    const result = await bootstrapBrand(suggestion([row({})]), {
      dataDirOverride: testDir,
      deferPush: true,
    });
    expect(mockedPushAfterWrite).not.toHaveBeenCalled();
    expect(result.push).toBeUndefined();
  });
});
