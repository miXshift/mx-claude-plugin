import { describe, it, expect } from 'vitest';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import {
  clientsIndexSchema,
  indexBrandSchema,
  indexAccountSchema,
  emptyIndex,
  type ClientsIndex,
} from './index-schema.js';

function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    seller_id: 1,
    seller_name: 'Acme Corp',
    merchant_alias: 'Old Trailhead Supply',
    account_type: 'SC',
    marketplace: 'United States',
    region: 'NA',
    is_active: true,
    is_mws_user: true,
    ads_active: true,
    retail_active: true,
    ...overrides,
  };
}

function fullIndex(overrides: Partial<ClientsIndex> = {}): ClientsIndex {
  return {
    schema_version: 1,
    discovered_at: '2026-08-06T12:00:00.000Z',
    brands: [
      {
        slug: 'acme-corp',
        display_name: 'Acme Corp',
        ads_active: true,
        retail_active: true,
        is_dormant: false,
        cold_started: true,
        cold_started_at: '2026-05-01T00:00:00.000Z',
        accounts: [account() as never],
        aliases: ['old-trailhead-supply'],
      },
      {
        slug: 'dormant-co',
        display_name: 'Dormant Co',
        ads_active: false,
        retail_active: false,
        is_dormant: true,
        cold_started: false,
        cold_started_at: null,
        accounts: [
          account({
            seller_id: 2,
            seller_name: 'Dormant Co',
            merchant_alias: null,
            marketplace: null,
            region: null,
            ads_active: false,
            retail_active: false,
          }) as never,
        ],
        // aliases deliberately omitted — the common case.
      },
    ],
    ...overrides,
  };
}

describe('indexAccountSchema', () => {
  it('accepts a fully-populated account row', () => {
    const result = indexAccountSchema.safeParse(account());
    expect(result.success).toBe(true);
  });

  it('accepts null marketplace/region/merchant_alias (nullable, not optional)', () => {
    const result = indexAccountSchema.safeParse(
      account({ merchant_alias: null, marketplace: null, region: null }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an unknown account_type', () => {
    const result = indexAccountSchema.safeParse(account({ account_type: 'XX' }));
    expect(result.success).toBe(false);
  });
});

describe('indexBrandSchema — aliases field (feedback #37278)', () => {
  it('parses a brand with a populated aliases array', () => {
    const result = indexBrandSchema.safeParse({
      slug: 'acme-corp',
      display_name: 'Acme Corp',
      ads_active: true,
      retail_active: true,
      is_dormant: false,
      cold_started: false,
      cold_started_at: null,
      accounts: [account()],
      aliases: ['old-name', 'older-name'],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.aliases).toEqual(['old-name', 'older-name']);
  });

  it('parses a brand with aliases entirely omitted — comes back undefined, not []', () => {
    const result = indexBrandSchema.safeParse({
      slug: 'acme-corp',
      display_name: 'Acme Corp',
      ads_active: true,
      retail_active: true,
      is_dormant: false,
      cold_started: false,
      cold_started_at: null,
      accounts: [account()],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.aliases).toBeUndefined();
  });

  it('rejects an aliases entry that is not slug-shaped', () => {
    const result = indexBrandSchema.safeParse({
      slug: 'acme-corp',
      display_name: 'Acme Corp',
      ads_active: true,
      retail_active: true,
      is_dormant: false,
      cold_started: false,
      cold_started_at: null,
      accounts: [account()],
      aliases: ["Not Slug Shaped!"],
    });
    expect(result.success).toBe(false);
  });

  it('requires at least one account', () => {
    const result = indexBrandSchema.safeParse({
      slug: 'acme-corp',
      display_name: 'Acme Corp',
      ads_active: false,
      retail_active: false,
      is_dormant: true,
      cold_started: false,
      cold_started_at: null,
      accounts: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('clientsIndexSchema — parse round trip', () => {
  it('round-trips a full index through the schema unchanged (parse . serialize == identity)', () => {
    const original = fullIndex();
    const parsed = clientsIndexSchema.parse(original);
    // Re-parsing the already-validated data must be idempotent.
    const reparsed = clientsIndexSchema.parse(parsed);
    expect(reparsed).toEqual(original);
  });

  it('round-trips through YAML stringify/parse exactly like saveIndex/readIndex do', () => {
    const original = fullIndex();
    const yaml = stringifyYaml(original, { lineWidth: 0 });
    const rehydrated = parseYaml(yaml);
    const result = clientsIndexSchema.safeParse(rehydrated);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(original);
      // Specifically confirm the two things a YAML round trip can silently
      // mangle: the optional aliases array on one brand, and its complete
      // absence (not []) on the other.
      expect(result.data.brands[0]!.aliases).toEqual(['old-trailhead-supply']);
      expect(result.data.brands[1]!.aliases).toBeUndefined();
    }
  });

  it('accepts emptyIndex() (first-run state)', () => {
    const result = clientsIndexSchema.safeParse(emptyIndex());
    expect(result.success).toBe(true);
  });

  it('rejects schema_version values other than 1 (legacy/future file guard)', () => {
    const result = clientsIndexSchema.safeParse({ ...fullIndex(), schema_version: 2 });
    expect(result.success).toBe(false);
  });
});

describe('clientsIndexSchema — forward/backward compatibility', () => {
  it('strips an unrecognized top-level brand key instead of failing (forward-compat guarantee)', () => {
    // Simulates an OLDER harness reading a NEWER index.yaml that has grown
    // a field this schema doesn't know about yet. zod's default z.object
    // behavior strips unknown keys rather than rejecting the document —
    // this is the guarantee the aliases field's own doc comment relies on
    // for the reverse case (new harness, old file).
    const withUnknownField = fullIndex();
    (withUnknownField.brands[0] as unknown as Record<string, unknown>).future_field =
      'something-not-yet-invented';
    const result = clientsIndexSchema.safeParse(withUnknownField);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.brands[0] as unknown as Record<string, unknown>).future_field,
      ).toBeUndefined();
    }
  });

  it('parses a pre-#37278 index file with no aliases field anywhere (old on-disk registries)', () => {
    // A literal pre-flip on-disk shape: no brand in the whole file carries
    // `aliases`. Existing registries must keep loading unmodified.
    const legacyShapeYaml = stringifyYaml({
      schema_version: 1,
      discovered_at: '2026-05-01T00:00:00.000Z',
      brands: [
        {
          slug: 'foragers-pantry',
          display_name: "Forager's Pantry",
          ads_active: true,
          retail_active: true,
          is_dormant: false,
          cold_started: true,
          cold_started_at: '2026-05-01T00:00:00.000Z',
          accounts: [account({ seller_id: 1 })],
        },
      ],
    });
    const result = clientsIndexSchema.safeParse(parseYaml(legacyShapeYaml));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.brands[0]!.aliases).toBeUndefined();
  });
});
