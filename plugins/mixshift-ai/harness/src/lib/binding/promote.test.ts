import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// discoverSellers hits the warehouse in real life; promoteLabelItem calls it
// to build the fresh sub-brand's account rows, so it must be stubbed for
// these tests to stay local and offline (same rationale as
// brand-subbrand-discover.test.ts stubbing fetchLabelDiscovery).
vi.mock('../discovery/seller-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery/seller-query.js')>();
  return { ...actual, discoverSellers: vi.fn() };
});

// Capture what the org-store publish would have seen, and WHEN. Promotion
// bootstraps a brand and then writes its binding; if the publish fires between
// those two steps, an unbound brand named after a sub-brand label reaches the
// shared org store fleet-wide. These tests assert it never does.
export const pushSnapshots: Array<{ slug: string; hadBinding: boolean }> = [];
vi.mock('../context-sync/push-after-write.js', () => ({
  pushAfterWrite: vi.fn(async (slug: string, opts?: { dataDirOverride?: string }) => {
    const { readFile: rf } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    let hadBinding = false;
    try {
      const raw = await rf(j(opts?.dataDirOverride ?? '', 'clients', slug, 'context.yaml'), 'utf-8');
      hadBinding = /^binding:/m.test(raw);
    } catch {
      hadBinding = false;
    }
    pushSnapshots.push({ slug, hadBinding });
    return { ok: true } as unknown as never;
  }),
}));

import { discoverSellers } from '../discovery/seller-query.js';
import { assembleCoverageReport } from './discovery.js';
import {
  buildPromotionPlan,
  buildTriageProposals,
  applyPromotionDecision,
  buildScopeNote,
  meaningfulRetailLabels,
  DOMINANT_LABEL_SHARE_THRESHOLD,
  FIRST_LIVE_PROMOTION_NOTICE,
  type PromotionPlan,
  type PromotionPlanItem,
  type PromotionDecision,
} from './promote.js';
import { assembleEconomics } from './economics.js';
import type { BrandContext } from '../context/schema.js';

const mockedDiscoverSellers = discoverSellers as unknown as ReturnType<typeof vi.fn>;

const SELLER_ID = 'A1EXAMPLE23456';

let testDir: string;
let clientsDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `mxtest-binding-promote-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  clientsDir = join(testDir, 'clients');
  await mkdir(clientsDir, { recursive: true });
  mockedDiscoverSellers.mockReset();
  pushSnapshots.length = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleReport() {
  return assembleCoverageReport({
    sellerId: SELLER_ID,
    now: new Date('2026-08-12T00:00:00.000Z'),
    retailRows: [
      { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 70, row_count: 70 },
      { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 30, row_count: 30 },
    ],
    vendorRows: [],
    adsRows: [
      { SellerID: 1, source: 'campaign.Brand', label: 'Forager Pantry', campaign_count: 5 },
    ],
    matchRows: [
      { label: 'Forager Pantry', retail_asins: 70, ads_campaigns: 5, has_retail: true, has_ads: true },
      { label: 'Alpine Trail', retail_asins: 30, ads_campaigns: 0, has_retail: true, has_ads: false },
    ],
  });
}

const OLD_BRAND_SLUG = 'acme-house';

const oldBrandContextYaml = `
schema_version: 1
brand_slug: ${OLD_BRAND_SLUG}
brand_name: Acme House
last_updated: 2026-08-01
accounts:
  - seller_id: 1
    seller_name: Acme Agency
    account_type: SC
    status: active
    role: primary
    amazon_seller_id: ${SELLER_ID}
sources:
  ad_metrics: campaignmetric
  ops_revenue: business_reports_dpst_date
  ops_revenue_field: SalesAmount
  ops_units_field: UnitsOrdered
  ops_date_field: DateTime
management:
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 14
posture:
  stance: scale
  multiplier: 1
goals:
  monthly_total_sales_target: 100000
structural_events:
  - id: ev1
    type: promotional_window
    interpretation: "Forager Pantry ran a launch promo in March."
    affects: []
  - id: ev2
    type: media_spike
    interpretation: "Account-wide Prime Day spike across the whole catalog."
    affects: []
sub_brands:
  - slug: forager-pantry-ref
    name: Forager Pantry
negation:
  protected_terms:
    - "forager pantry organic"
    - "generic term"
  lane_rules: {}
brand_terms:
  canonical:
    - Forager Pantry
    - Alpine Trail
`;

async function writeBrandContext(slug: string, yaml: string): Promise<void> {
  const dir = join(clientsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'context.yaml'), yaml, 'utf-8');
}

async function writeIndex(
  brands: Array<{ slug: string; display_name: string; sellerIds: number[] }>,
): Promise<void> {
  const yaml =
    'schema_version: 1\n' +
    `discovered_at: "2026-08-12T00:00:00.000Z"\n` +
    'brands:\n' +
    brands
      .map(
        (b) =>
          `  - slug: ${b.slug}\n` +
          `    display_name: ${b.display_name}\n` +
          `    ads_active: true\n` +
          `    retail_active: true\n` +
          `    is_dormant: false\n` +
          `    cold_started: true\n` +
          `    cold_started_at: "2026-08-01T00:00:00.000Z"\n` +
          `    accounts:\n` +
          b.sellerIds
            .map(
              (id) =>
                `      - seller_id: ${id}\n` +
                `        seller_name: Acme Agency\n` +
                `        merchant_alias: null\n` +
                `        account_type: SC\n` +
                `        marketplace: US\n` +
                `        region: NA\n` +
                `        is_active: true\n` +
                `        is_mws_user: true\n` +
                `        ads_active: true\n` +
                `        retail_active: true\n`,
            )
            .join(''),
      )
      .join('');
  await writeFile(join(clientsDir, 'index.yaml'), yaml, 'utf-8');
}

const bindingYamlFor = (label: string) => `
binding:
  kind: sub_brand
  amazon_seller_id: ${SELLER_ID}
  seller_ids: [1]
  retail_label:
    source: mws_items.Brand
    value: "${label}"
  scope_note: "This brand is a sub-brand."
`;

// ---------------------------------------------------------------------------
// meaningfulRetailLabels
// ---------------------------------------------------------------------------

describe('meaningfulRetailLabels', () => {
  it('excludes the unclassified bucket and sliver labels under the shared gate', () => {
    const report = sampleReport();
    const labels = meaningfulRetailLabels(report.retail).map((l) => l.label);
    expect(labels).toEqual(['Forager Pantry', 'Alpine Trail']);
  });

  it('returns empty when total_units is 0 (nothing to divide)', () => {
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      retailRows: [],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    expect(meaningfulRetailLabels(report.retail)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildScopeNote
// ---------------------------------------------------------------------------

describe('buildScopeNote', () => {
  it('names the label and the account, and carries no em dash', () => {
    const note = buildScopeNote('Forager Pantry', SELLER_ID);
    expect(note).toContain('Forager Pantry');
    expect(note).toContain(SELLER_ID);
    expect(note).not.toContain('—'); // em dash
  });
});

// ---------------------------------------------------------------------------
// buildPromotionPlan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Economics-driven candidacy and ranking (mx-ops#6)
//
// Reproduces the reported account shape directly: a label with a large
// catalog footprint but almost no money, and a label carrying most of the
// account's revenue and ad spend on comparatively few items. Ranking on item
// count proposed the first and omitted the second.
// ---------------------------------------------------------------------------

describe('buildPromotionPlan — economics', () => {
  /** Big catalog, tiny money, nothing recent — the wound-down brand. */
  const DEAD = 'Wound Down';
  /** Small catalog, most of the account's money — the one that was missing. */
  const BIG = 'Big Earner';

  function econReport() {
    return assembleCoverageReport({
      sellerId: SELLER_ID,
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: DEAD, asin_count: 127, row_count: 127 },
        { SellerID: 1, source: 'mws_items.Brand', label: BIG, asin_count: 9, row_count: 9 },
      ],
      vendorRows: [],
      adsRows: [{ SellerID: 1, source: 'campaign.Brand', label: BIG, campaign_count: 41 }],
      matchRows: [],
    });
  }

  function econMap() {
    return assembleEconomics({
      retailEconRows: [
        {
          SellerID: 1, source: 'mws_items.Brand', label: DEAD,
          revenue_365d: 695, revenue_90d: 0, units_365d: 11,
          last_order_at: '2025-11-02 00:00:00', sku_count: 127,
        },
        {
          SellerID: 1, source: 'mws_items.Brand', label: BIG,
          revenue_365d: 6_400_000, revenue_90d: 1_700_000, units_365d: 90_000,
          last_order_at: '2026-08-11 00:00:00', sku_count: 9,
        },
      ],
      adsEconRows: [
        {
          SellerID: 1, source: 'campaign.Brand', label: BIG,
          spend_365d: 980_000, spend_90d: 260_000, ad_sales_365d: 4_100_000,
          last_spend_at: '2026-08-11 00:00:00', campaigns_with_spend: 41,
        },
      ],
      vendorEconRows: [],
    });
  }

  it('ranks by dollars, not item count', async () => {
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    // 127 items vs 9, but $695 vs $7.38M. Dollars win.
    expect(plan.items[0]!.label).toBe(BIG);
    expect(plan.items[0]!.economic_weight).toBe(7_380_000);
  });

  it('flags the wound-down label instead of proposing it', async () => {
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    const dead = plan.items.find((i) => i.label === DEAD)!;
    expect(dead.status).toBe('flagged');
    // $695 against a ~$7.4M account. Below the floor where a recent-share
    // ratio means anything, so lifecycle is honestly 'unknown' — but the
    // label is still held back, as NEGLIGIBLE rather than as dead. Reporting
    // it as dormant would be claiming evidence we do not have.
    expect(dead.flag_reason).toBe('negligible');
    expect(dead.lifecycle).toBe('unknown');
    expect(dead.flag_detail).toBeTruthy();
  });

  it('KEEPS the wound-down label in the plan — flagged, never dropped', async () => {
    // Silently removing it would break the plan's totals against Seller
    // Central and hide a brand someone may be looking for. Suppression is
    // the operator's explicit call, not a default buried here.
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    expect(plan.items.map((i) => i.label)).toContain(DEAD);
    expect(plan.items).toHaveLength(2);
  });

  it('sorts flagged items last so the actionable candidates lead', async () => {
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    expect(plan.items.at(-1)!.status).toBe('flagged');
  });

  // mx-ops#6 red team, P2. unknownEconomics' zeros are PLACEHOLDERS. Reading
  // them as a share computed 0/total = 0 < 2%, so a label the economics
  // queries simply never returned was told it was "too small to be worth its
  // own brand — 0.00% of this account". That is the same false-confidence
  // failure this change exists to remove: absent data stated as measurement.
  it('does NOT flag a label the economics queries never returned', async () => {
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: BIG, asin_count: 60, row_count: 60 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'No Econ Row', asin_count: 55, row_count: 55 },
      ],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    // Economics covers BIG only; 'No Econ Row' is absent from the map, so it
    // falls back to unknownEconomics with weight 0 against a $7.38M account.
    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    const orphan = plan.items.find((i) => i.label === 'No Econ Row')!;
    expect(orphan.status).toBe('would_create');
    expect(orphan.flag_reason).toBeUndefined();
    expect(orphan.lifecycle).toBe('unknown');
    // The genuinely-measured comparison still works on the same plan.
    expect(plan.items.find((i) => i.label === BIG)!.status).toBe('would_create');
  });

  // mx-ops#6 red team, P2. The old-brand rebind picked the top label by ITEM
  // COUNT and never read `status`, so on an account whose largest stale
  // catalog is also its wound-down brand, the plan proposed re-binding the
  // historical brand onto a label the SAME plan flagged as held back.
  it('never proposes rebinding the old brand onto a flagged label', async () => {
    await writeBrandContext(OLD_BRAND_SLUG, oldBrandContextYaml);
    await writeIndex([{ slug: OLD_BRAND_SLUG, display_name: 'Acme House', sellerIds: [1] }]);

    // DEAD carries 127 of 136 units (93%) — it wins on count by a landslide,
    // and is exactly the label flagged negligible.
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    expect(plan.items.find((i) => i.label === DEAD)!.status).toBe('flagged');
    expect(plan.old_brand!.dominant_label).not.toBe(DEAD);
    // BIG holds only 9 of 136 units, far under the 50% dominance gate, so
    // with the flagged label excluded nothing dominates and we retire.
    expect(plan.old_brand!.proposed_disposition).toBe('retire');
    expect(plan.old_brand!.dominant_label).toBeUndefined();
  });

  it('still rebinds onto an unflagged label that genuinely dominates', async () => {
    await writeBrandContext(OLD_BRAND_SLUG, oldBrandContextYaml);
    await writeIndex([{ slug: OLD_BRAND_SLUG, display_name: 'Acme House', sellerIds: [1] }]);

    // Same shape, but the big earner also carries the catalog.
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: BIG, asin_count: 120, row_count: 120 },
        { SellerID: 1, source: 'mws_items.Brand', label: DEAD, asin_count: 16, row_count: 16 },
      ],
      vendorRows: [],
      adsRows: [{ SellerID: 1, source: 'campaign.Brand', label: BIG, campaign_count: 41 }],
      matchRows: [],
    });
    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: econMap(),
    });
    expect(plan.old_brand!.proposed_disposition).toBe('rebind_as_dominant');
    expect(plan.old_brand!.dominant_label).toBe(BIG);
    // The share the operator reads is still measured against EVERY label's
    // units, flagged included, so it reconciles against the account.
    expect(plan.old_brand!.rationale).toContain('88%');
  });

  it('promotes an economically significant label that misses the catalog-mass gate', async () => {
    // The other half of the reported defect: the account's largest brand by
    // money was absent from the plan entirely because it sat on few items.
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Bulk', asin_count: 5_000, row_count: 5_000 },
        { SellerID: 1, source: 'mws_items.Brand', label: BIG, asin_count: 3, row_count: 3 },
      ],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    // 3 of 5003 items is far below the catalog-mass gate.
    expect(meaningfulRetailLabels(report.retail).map((l) => l.label)).not.toContain(BIG);

    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: assembleEconomics({
        retailEconRows: [
          {
            SellerID: 1, source: 'mws_items.Brand', label: BIG,
            revenue_365d: 6_400_000, revenue_90d: 1_700_000, units_365d: 90_000,
            last_order_at: '2026-08-11 00:00:00', sku_count: 3,
          },
          {
            SellerID: 1, source: 'mws_items.Brand', label: 'Bulk',
            revenue_365d: 40_000, revenue_90d: 12_000, units_365d: 900,
            last_order_at: '2026-08-11 00:00:00', sku_count: 5_000,
          },
        ],
        adsEconRows: [],
        vendorEconRows: [],
      }),
    });
    expect(plan.items.map((i) => i.label)).toContain(BIG);
    expect(plan.items[0]!.label).toBe(BIG);
  });

  it('distinguishes a big brand that STOPPED from a brand that was never big', async () => {
    // Both get held back, but for different reasons, and an operator acts on
    // them differently: one is a wind-down to confirm, the other was never
    // worth its own brand. Collapsing them into one flag would lose that.
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      now: new Date('2026-08-12T00:00:00.000Z'),
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Stopped', asin_count: 50, row_count: 50 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Tiny', asin_count: 50, row_count: 50 },
        { SellerID: 1, source: 'mws_items.Brand', label: BIG, asin_count: 50, row_count: 50 },
      ],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', {
      dataDirOverride: testDir,
      economics: assembleEconomics({
        retailEconRows: [
          // Real money last year, silence since — evidence of a wind-down.
          { SellerID: 1, source: 'mws_items.Brand', label: 'Stopped',
            revenue_365d: 842_000, revenue_90d: 0, units_365d: 900,
            last_order_at: '2026-01-14 00:00:00', sku_count: 50 },
          // Currently trading, just trivial.
          { SellerID: 1, source: 'mws_items.Brand', label: 'Tiny',
            revenue_365d: 4_000, revenue_90d: 1_200, units_365d: 40,
            last_order_at: '2026-08-11 00:00:00', sku_count: 50 },
          { SellerID: 1, source: 'mws_items.Brand', label: BIG,
            revenue_365d: 6_400_000, revenue_90d: 1_700_000, units_365d: 90_000,
            last_order_at: '2026-08-11 00:00:00', sku_count: 50 },
        ],
        adsEconRows: [],
        vendorEconRows: [],
      }),
    });

    const stopped = plan.items.find((i) => i.label === 'Stopped')!;
    expect(stopped.status).toBe('flagged');
    expect(stopped.flag_reason).toBe('dormant');
    expect(stopped.lifecycle).toBe('dormant');

    const tiny = plan.items.find((i) => i.label === 'Tiny')!;
    expect(tiny.status).toBe('flagged');
    expect(tiny.flag_reason).toBe('negligible');
    expect(tiny.lifecycle).toBe('active'); // still trading, just small

    expect(plan.items.find((i) => i.label === BIG)!.status).toBe('would_create');
  });

  it('falls back to catalog-mass ordering when no economics are supplied', async () => {
    // A caller that cannot reach the economics queries still gets a usable
    // plan rather than an empty one, and nothing is flagged on no evidence.
    const plan = await buildPromotionPlan(econReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
    });
    expect(plan.items[0]!.label).toBe(DEAD); // 127 items
    for (const item of plan.items) {
      expect(item.status).toBe('would_create');
      expect(item.lifecycle).toBe('unknown');
    }
  });
});

describe('buildPromotionPlan', () => {
  it('proposes would_create for every meaningful label with no existing brands', async () => {
    const plan = await buildPromotionPlan(sampleReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
    });
    expect(plan.seller_id).toBe(SELLER_ID);
    expect(plan.notice).toBe(FIRST_LIVE_PROMOTION_NOTICE);
    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((i) => i.label)).toEqual(['Forager Pantry', 'Alpine Trail']);
    for (const item of plan.items) {
      expect(item.status).toBe('would_create');
      expect(item.proposed_slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
    expect(plan.items[0]!.proposed_slug).toBe('forager-pantry');
    expect(plan.items[1]!.proposed_slug).toBe('alpine-trail');
    expect(plan.old_brand).toBeNull();
    expect(plan.additional_unbound_brands).toEqual([]);
  });

  it('mints distinct slugs within the same run even under label collisions', async () => {
    // Two labels that would slugify identically absent the running reservation.
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 60, row_count: 60 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager  Pantry', asin_count: 40, row_count: 40 },
      ],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', { dataDirOverride: testDir });
    const slugs = plan.items.map((i) => i.proposed_slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('detects a pre-existing whole-account brand and proposes rebind_as_dominant for the majority label', async () => {
    await writeBrandContext(OLD_BRAND_SLUG, oldBrandContextYaml);
    await writeIndex([{ slug: OLD_BRAND_SLUG, display_name: 'Acme House', sellerIds: [1] }]);

    const plan = await buildPromotionPlan(sampleReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
    });

    expect(plan.old_brand).not.toBeNull();
    expect(plan.old_brand!.slug).toBe(OLD_BRAND_SLUG);
    expect(plan.old_brand!.proposed_disposition).toBe('rebind_as_dominant');
    expect(plan.old_brand!.dominant_label).toBe('Forager Pantry');
    expect(plan.old_brand!.triage.length).toBeGreaterThan(0);
  });

  it('proposes retire when no single label dominates', async () => {
    await writeBrandContext(OLD_BRAND_SLUG, oldBrandContextYaml);
    await writeIndex([{ slug: OLD_BRAND_SLUG, display_name: 'Acme House', sellerIds: [1] }]);

    // No label reaches DOMINANT_LABEL_SHARE_THRESHOLD (top label is 40%).
    const report = assembleCoverageReport({
      sellerId: SELLER_ID,
      retailRows: [
        { SellerID: 1, source: 'mws_items.Brand', label: 'Forager Pantry', asin_count: 40, row_count: 40 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Alpine Trail', asin_count: 35, row_count: 35 },
        { SellerID: 1, source: 'mws_items.Brand', label: 'Cedar Ridge', asin_count: 25, row_count: 25 },
      ],
      vendorRows: [],
      adsRows: [],
      matchRows: [],
    });
    const plan = await buildPromotionPlan(report, [1], 'Acme Agency', { dataDirOverride: testDir });
    expect(plan.old_brand!.proposed_disposition).toBe('retire');
    expect(plan.old_brand!.dominant_label).toBeUndefined();
  });

  it('idempotency: an already-bound label reports already_bound with its real slug, not a re-proposal', async () => {
    const boundSlug = 'forager-pantry';
    await writeBrandContext(boundSlug, `
schema_version: 1
brand_slug: ${boundSlug}
brand_name: Forager Pantry
last_updated: 2026-08-12
accounts:
  - seller_id: 1
    seller_name: Acme Agency
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
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 14
` + bindingYamlFor('Forager Pantry'));
    await writeIndex([{ slug: boundSlug, display_name: 'Forager Pantry', sellerIds: [1] }]);

    const plan = await buildPromotionPlan(sampleReport(), [1], 'Acme Agency', {
      dataDirOverride: testDir,
    });

    const foragerItem = plan.items.find((i) => i.label === 'Forager Pantry')!;
    expect(foragerItem.status).toBe('already_bound');
    expect(foragerItem.existing_slug).toBe(boundSlug);

    const alpineItem = plan.items.find((i) => i.label === 'Alpine Trail')!;
    expect(alpineItem.status).toBe('would_create');

    // A bound brand must never be treated as the old whole-account brand.
    expect(plan.old_brand).toBeNull();
  });

  it('DOMINANT_LABEL_SHARE_THRESHOLD is documented at 50%', () => {
    expect(DOMINANT_LABEL_SHARE_THRESHOLD).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// buildTriageProposals
// ---------------------------------------------------------------------------

describe('buildTriageProposals', () => {
  /** Economics fields are irrelevant to triage (which matches on labels),
   *  so these fixtures carry a neutral, live-looking set rather than
   *  restating numbers each case would then ignore. */
  const liveEcon = {
    revenue_365d: 100_000,
    spend_365d: 10_000,
    economic_weight: 110_000,
    lifecycle: 'active' as const,
    lifecycle_reason: 'fixture',
  };
  const items = [
    { label: 'Forager Pantry', retail_source: 'mws_items.Brand', retail_units: 70, ads_campaign_count: 5, has_ads: true, ads_source: null, ...liveEcon, proposed_slug: 'forager-pantry', status: 'would_create' as const },
    { label: 'Alpine Trail', retail_source: 'mws_items.Brand', retail_units: 30, ads_campaign_count: 0, has_ads: false, ads_source: null, ...liveEcon, proposed_slug: 'alpine-trail', status: 'would_create' as const },
  ];

  function loadContext(): BrandContext {
    return parseYaml(oldBrandContextYaml) as BrandContext;
  }

  it('proposes move_to for a structural event that names a label', () => {
    const triage = buildTriageProposals(loadContext(), items);
    const ev1 = triage.find((t) => t.section === 'structural_events[0]')!;
    expect(ev1.proposed_disposition).toBe('move_to');
    expect(ev1.proposed_target_slug).toBe('forager-pantry');
  });

  it('proposes copy_into_all for an account-wide structural event with no label match', () => {
    const triage = buildTriageProposals(loadContext(), items);
    const ev2 = triage.find((t) => t.section === 'structural_events[1]')!;
    expect(ev2.proposed_disposition).toBe('copy_into_all');
    expect(ev2.proposed_target_slug).toBeUndefined();
  });

  it('retires a sub_brands[] row that names a label being promoted', () => {
    const triage = buildTriageProposals(loadContext(), items);
    const sb = triage.find((t) => t.section === 'sub_brands[0]')!;
    expect(sb.proposed_disposition).toBe('retire');
    expect(sb.proposed_target_slug).toBe('forager-pantry');
  });

  it('splits negation.protected_terms by label mention', () => {
    const triage = buildTriageProposals(loadContext(), items);
    const terms = triage.filter((t) => t.section === 'negation.protected_terms');
    expect(terms).toHaveLength(2);
    expect(terms[0]!.proposed_disposition).toBe('move_to');
    expect(terms[1]!.proposed_disposition).toBe('copy_into_all');
  });

  it('proposes copy_into_all for shared account-level sections present in context', () => {
    const triage = buildTriageProposals(loadContext(), items);
    for (const section of ['management', 'posture', 'goals']) {
      const entry = triage.find((t) => t.section === section);
      expect(entry, `missing triage item for ${section}`).toBeDefined();
      expect(entry!.proposed_disposition).toBe('copy_into_all');
    }
  });

  it('flags brand_terms for human review as copy_into_all', () => {
    const triage = buildTriageProposals(loadContext(), items);
    const bt = triage.find((t) => t.section === 'brand_terms')!;
    expect(bt.proposed_disposition).toBe('copy_into_all');
  });

  it('never emits a disposition outside move_to/copy_into_all/retire', () => {
    const triage = buildTriageProposals(loadContext(), items);
    for (const t of triage) {
      expect(['move_to', 'copy_into_all', 'retire']).toContain(t.proposed_disposition);
    }
  });
});

// ---------------------------------------------------------------------------
// applyPromotionDecision — fail-closed contract
// ---------------------------------------------------------------------------

describe('applyPromotionDecision — fail-closed on malformed/unknown decisions', () => {
  function samplePlan(overrides: Partial<PromotionPlan> = {}): PromotionPlan {
    return {
      seller_id: SELLER_ID,
      generated_at: '2026-08-12T00:00:00.000Z',
      items: [
        { label: 'Forager Pantry', retail_source: 'mws_items.Brand', retail_units: 70, ads_campaign_count: 5, has_ads: true, ads_source: null, revenue_365d: 100_000, spend_365d: 10_000, economic_weight: 110_000, lifecycle: 'active', lifecycle_reason: 'fixture', proposed_slug: 'forager-pantry', status: 'would_create' },
      ],
      old_brand: null,
      additional_unbound_brands: [],
      notice: FIRST_LIVE_PROMOTION_NOTICE,
      ...overrides,
    };
  }

  const opts = { dataDirOverride: testDir, sellerName: 'Acme Agency', resolvedSellerIds: [1] };

  it('rejects a null decision', async () => {
    const result = await applyPromotionDecision(samplePlan(), null as unknown as PromotionDecision, opts);
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects an array decision (a container-shape guard, not just a field check)', async () => {
    const result = await applyPromotionDecision(samplePlan(), [] as unknown as PromotionDecision, opts);
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects an unknown action instead of falling through to a write path', async () => {
    const result = await applyPromotionDecision(
      samplePlan(),
      { action: 'promote_labl' } as unknown as PromotionDecision,
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
    expect(result.validation_issues[0]!.field).toBe('action');
  });

  it('rejects promote_label with a missing label', async () => {
    const result = await applyPromotionDecision(
      samplePlan(),
      { action: 'promote_label' } as unknown as PromotionDecision,
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects promote_label with a non-string label', async () => {
    const result = await applyPromotionDecision(
      samplePlan(),
      { action: 'promote_label', label: 42 } as unknown as PromotionDecision,
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects promote_label for a label not present in the plan', async () => {
    const result = await applyPromotionDecision(
      samplePlan(),
      { action: 'promote_label', label: 'Not In Plan' },
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects retire_old_brand when the plan has no old brand', async () => {
    const result = await applyPromotionDecision(samplePlan(), { action: 'retire_old_brand' }, opts);
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('rejects rebind_old_brand when the plan has no old brand', async () => {
    const result = await applyPromotionDecision(
      samplePlan(),
      { action: 'rebind_old_brand', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });

  it('honors cancel with no write', async () => {
    const result = await applyPromotionDecision(samplePlan(), { action: 'cancel' }, opts);
    expect(result.status).toBe('cancelled');
    expect(result.did_write).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyPromotionDecision — real writes (promote_label / retire / rebind)
// ---------------------------------------------------------------------------

describe('applyPromotionDecision — promote_label (real filesystem writes)', () => {
  const opts = { dataDirOverride: '', sellerName: 'Acme Agency', resolvedSellerIds: [1] };

  beforeEach(() => {
    opts.dataDirOverride = testDir;
    mockedDiscoverSellers.mockResolvedValue([
      {
        seller_id: 1,
        seller_name: 'Acme Agency',
        amazon_seller_id: SELLER_ID,
        merchant_alias: null,
        account_type: 'SC' as const,
        marketplace: 'United States',
        region: 'NA',
        agency_name: null,
        acos_target: null,
        ads_active: true,
        retail_active: true,
        is_active: true,
        has_mws: true,
      },
    ]);
  });

  function planWithForagerItem(): PromotionPlan {
    return {
      seller_id: SELLER_ID,
      generated_at: '2026-08-12T00:00:00.000Z',
      items: [
        { label: 'Forager Pantry', retail_source: 'mws_items.Brand', retail_units: 70, ads_campaign_count: 5, has_ads: true, ads_source: null, revenue_365d: 100_000, spend_365d: 10_000, economic_weight: 110_000, lifecycle: 'active', lifecycle_reason: 'fixture', proposed_slug: 'forager-pantry', status: 'would_create' },
      ],
      old_brand: null,
      additional_unbound_brands: [],
      notice: FIRST_LIVE_PROMOTION_NOTICE,
    };
  }

  it('bootstraps the sub-brand directory and writes a valid binding block', async () => {
    const result = await applyPromotionDecision(
      planWithForagerItem(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);
    expect(result.slug).toBe('forager-pantry');

    const raw = await readFile(join(clientsDir, 'forager-pantry', 'context.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as { binding?: { kind?: string; retail_label?: { value?: string }; ads_label?: { value?: string }; scope_note?: string } };
    expect(parsed.binding?.kind).toBe('sub_brand');
    expect(parsed.binding?.retail_label?.value).toBe('Forager Pantry');
    expect(parsed.binding?.ads_label?.value).toBe('Forager Pantry');
    expect(parsed.binding?.scope_note).toBeTruthy();
  });

  it('upserts a registry row so slug-based lookups can find the new sub-brand', async () => {
    await applyPromotionDecision(
      planWithForagerItem(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    const indexRaw = await readFile(join(clientsDir, 'index.yaml'), 'utf-8');
    const index = parseYaml(indexRaw) as { brands: Array<{ slug: string }> };
    expect(index.brands.some((b) => b.slug === 'forager-pantry')).toBe(true);
  });

  it('is idempotent: applying the same decision twice does not double-write or error', async () => {
    const first = await applyPromotionDecision(
      planWithForagerItem(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(first.did_write).toBe(true);

    const second = await applyPromotionDecision(
      planWithForagerItem(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(second.status).toBe('ok');
    expect(second.did_write).toBe(false);
    expect(second.detail).toContain('already bound');
  });

  it('refuses to overwrite a same-slug directory bound to a DIFFERENT label', async () => {
    // Simulate a slug collision with an unrelated existing brand.
    await mkdir(join(clientsDir, 'forager-pantry'), { recursive: true });
    await writeFile(
      join(clientsDir, 'forager-pantry', 'context.yaml'),
      `
schema_version: 1
brand_slug: forager-pantry
brand_name: Something Else
last_updated: 2026-08-01
accounts:
  - seller_id: 99
    seller_name: Unrelated Seller
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
  primary_metric: ACOS
  acos_target_pct: 20
  attribution_window_days: 14
`,
      'utf-8',
    );
    const result = await applyPromotionDecision(
      planWithForagerItem(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('validation_failed');
  });
});

describe('applyPromotionDecision — retire_old_brand / rebind_old_brand', () => {
  const opts = { dataDirOverride: '', sellerName: 'Acme Agency', resolvedSellerIds: [1] };

  beforeEach(async () => {
    opts.dataDirOverride = testDir;
    await writeBrandContext(OLD_BRAND_SLUG, oldBrandContextYaml);
    await writeIndex([{ slug: OLD_BRAND_SLUG, display_name: 'Acme House', sellerIds: [1] }]);
  });

  function planWithOldBrand(disposition: 'retire' | 'rebind_as_dominant'): PromotionPlan {
    return {
      seller_id: SELLER_ID,
      generated_at: '2026-08-12T00:00:00.000Z',
      items: [
        { label: 'Forager Pantry', retail_source: 'mws_items.Brand', retail_units: 70, ads_campaign_count: 5, has_ads: true, ads_source: null, revenue_365d: 100_000, spend_365d: 10_000, economic_weight: 110_000, lifecycle: 'active', lifecycle_reason: 'fixture', proposed_slug: 'forager-pantry', status: 'would_create' },
      ],
      old_brand: {
        slug: OLD_BRAND_SLUG,
        display_name: 'Acme House',
        proposed_disposition: disposition,
        ...(disposition === 'rebind_as_dominant' ? { dominant_label: 'Forager Pantry' } : {}),
        rationale: 'test fixture',
        triage: [],
      },
      additional_unbound_brands: [],
      notice: FIRST_LIVE_PROMOTION_NOTICE,
    };
  }

  it('retire_old_brand parks the directory without deleting anything', async () => {
    const result = await applyPromotionDecision(planWithOldBrand('retire'), { action: 'retire_old_brand' }, opts);
    expect(result.status).toBe('ok');
    expect(result.did_write).toBe(true);

    await expect(access(join(clientsDir, OLD_BRAND_SLUG))).rejects.toThrow();
    const parkedContext = await readFile(join(clientsDir, `${OLD_BRAND_SLUG}.parked`, 'context.yaml'), 'utf-8');
    expect(parkedContext).toContain('brand_slug: acme-house');
  });

  it('retire_old_brand is idempotent: a second call reports nothing-to-do, never an error', async () => {
    await applyPromotionDecision(planWithOldBrand('retire'), { action: 'retire_old_brand' }, opts);
    const second = await applyPromotionDecision(planWithOldBrand('retire'), { action: 'retire_old_brand' }, opts);
    expect(second.status).toBe('ok');
    expect(second.did_write).toBe(false);
  });

  it('rebind_old_brand writes the binding directly onto the existing slug (no directory move)', async () => {
    const result = await applyPromotionDecision(
      planWithOldBrand('rebind_as_dominant'),
      { action: 'rebind_old_brand', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('ok');
    expect(result.slug).toBe(OLD_BRAND_SLUG);

    // Directory never moved.
    await expect(access(join(clientsDir, OLD_BRAND_SLUG))).resolves.toBeUndefined();
    const raw = await readFile(join(clientsDir, OLD_BRAND_SLUG, 'context.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as { binding?: { retail_label?: { value?: string } } };
    expect(parsed.binding?.retail_label?.value).toBe('Forager Pantry');
  });

  it('rebind_old_brand refuses to overwrite a brand that already has a binding', async () => {
    await applyPromotionDecision(
      planWithOldBrand('rebind_as_dominant'),
      { action: 'rebind_old_brand', label: 'Forager Pantry' },
      opts,
    );
    const second = await applyPromotionDecision(
      planWithOldBrand('rebind_as_dominant'),
      { action: 'rebind_old_brand', label: 'Forager Pantry' },
      opts,
    );
    expect(second.status).toBe('validation_failed');
  });
});

// ---------------------------------------------------------------------------
// Review round 2 regression guards (P1 findings, 2026-08-13)
// ---------------------------------------------------------------------------

describe('promotion write path — org-store safety regressions', () => {
  const opts = { dataDirOverride: '', sellerName: 'Acme Agency', resolvedSellerIds: [1] };

  beforeEach(() => {
    opts.dataDirOverride = testDir;
    mockedDiscoverSellers.mockResolvedValue([
      {
        seller_id: 1,
        seller_name: 'Acme Agency',
        amazon_seller_id: SELLER_ID,
        merchant_alias: null,
        account_type: 'SC' as const,
        marketplace: 'United States',
        region: 'NA',
        agency_name: null,
        acos_target: null,
        ads_active: true,
        retail_active: true,
        is_active: true,
        has_mws: true,
      },
    ]);
  });

  function foragerPlan(): PromotionPlan {
    return {
      seller_id: SELLER_ID,
      generated_at: '2026-08-12T00:00:00.000Z',
      items: [
        {
          label: 'Forager Pantry',
          retail_source: 'mws_items.Brand',
          retail_units: 70,
          ads_campaign_count: 5,
          has_ads: true, ads_source: null,
          revenue_365d: 100_000,
          spend_365d: 10_000,
          economic_weight: 110_000,
          lifecycle: 'active',
          lifecycle_reason: 'fixture',
          proposed_slug: 'forager-pantry',
          status: 'would_create',
        },
      ],
      old_brand: null,
      additional_unbound_brands: [],
      notice: FIRST_LIVE_PROMOTION_NOTICE,
    };
  }

  const ctxPathFor = (slug: string) => join(clientsDir, slug, 'context.yaml');

  /** Remove the binding block deterministically, and PROVE it was removed.
   *  (A first pass at these guards stripped it with a regex anchored on \Z,
   *  which JavaScript does not support — the match silently failed, the
   *  binding survived, and two of these tests passed while exercising
   *  nothing.) */
  async function stripBinding(slug: string, extra?: Record<string, unknown>): Promise<void> {
    const path = ctxPathFor(slug);
    const doc = parseYaml(await readFile(path, 'utf-8')) as Record<string, unknown>;
    delete doc.binding;
    await writeFile(path, stringifyYaml({ ...doc, ...(extra ?? {}) }, { indent: 2, lineWidth: 0 }), 'utf-8');
    const check = parseYaml(await readFile(path, 'utf-8')) as Record<string, unknown>;
    if (check.binding !== undefined) throw new Error('test setup failed: binding was not stripped');
  }

  // mx-ops#6 red team, P2 — the write-path hazard, and the reason this pass
  // gates the first live promotion.
  //
  // Both label filters are individually optional in the schema, so an
  // economics-only candidate (admitted by the new economic-share gate, but
  // returned by NO coverage query) reached the write path with an empty
  // retail source and has_ads false, and the binding came out carrying
  // amazon_seller_id and nothing else. That is a "sub-brand" scoped to the
  // ENTIRE account, published org-wide, and indistinguishable downstream
  // from a legitimately account-wide brand — while its own scope_note
  // asserted a label filter it did not contain.
  function unfilterableItem(): PromotionPlanItem {
    return {
      label: 'Econ Only',
      retail_source: null,
      retail_units: 0,
      ads_campaign_count: 0,
      has_ads: false,
      ads_source: null,
      revenue_365d: 500_000,
      spend_365d: 0,
      economic_weight: 500_000,
      lifecycle: 'active',
      lifecycle_reason: 'fixture',
      proposed_slug: 'econ-only',
      status: 'would_create',
    };
  }

  function econOnlyPlan(item: PromotionPlanItem): PromotionPlan {
    return {
      seller_id: SELLER_ID,
      generated_at: '2026-08-12T00:00:00.000Z',
      items: [item],
      old_brand: null,
      additional_unbound_brands: [],
      notice: FIRST_LIVE_PROMOTION_NOTICE,
    };
  }

  it('REFUSES to write a sub-brand binding that would carry no label filter', async () => {
    const result = await applyPromotionDecision(
      econOnlyPlan(unfilterableItem()),
      { action: 'promote_label', label: 'Econ Only' },
      opts,
    );
    expect(result.status).not.toBe('ok');
    expect(result.did_write).toBe(false);
    expect(result.detail).toMatch(/no label filter|Refusing to bind/i);
  });

  it('leaves nothing behind on disk or in the org store when it refuses', async () => {
    await applyPromotionDecision(
      econOnlyPlan(unfilterableItem()),
      { action: 'promote_label', label: 'Econ Only' },
      opts,
    );
    // Refusing after bootstrap but before the binding write would strand an
    // unbound, sub-brand-named brand — the exact state the deferPush guard
    // above exists to prevent, so the refusal must land before any publish.
    expect(pushSnapshots).toHaveLength(0);
    await expect(access(ctxPathFor('econ-only'))).rejects.toThrow();
  });

  it('binds on the ads column when only economics saw the label', async () => {
    // The same candidate becomes promotable once economics reports WHICH
    // column it read the label from. Failing closed is the floor, not the
    // goal: the operator should get the brand, correctly scoped.
    const item = { ...unfilterableItem(), ads_source: 'campaign.Brand' };
    const result = await applyPromotionDecision(
      econOnlyPlan(item),
      { action: 'promote_label', label: 'Econ Only' },
      opts,
    );
    expect(result.status).toBe('ok');
    const parsed = parseYaml(await readFile(ctxPathFor('econ-only'), 'utf-8')) as {
      binding?: { retail_label?: unknown; ads_label?: { source?: string; value?: string } };
    };
    expect(parsed.binding?.ads_label).toEqual({ source: 'campaign.Brand', value: 'Econ Only' });
    expect(parsed.binding?.retail_label).toBeUndefined();
  });

  it('never publishes an UNBOUND brand: every push during promotion sees the binding already written', async () => {
    const result = await applyPromotionDecision(
      foragerPlan(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('ok');
    expect(pushSnapshots.length).toBeGreaterThan(0);
    // Pre-fix, bootstrap published first and this snapshot was `false`: a brand
    // named after a sub-brand label, carrying no binding, in the shared store.
    for (const snap of pushSnapshots) {
      expect({ slug: snap.slug, hadBinding: snap.hadBinding }).toEqual({
        slug: 'forager-pantry',
        hadBinding: true,
      });
    }
  });

  it('preserves unknown context keys when writing a binding (forward tolerance, design §2.2)', async () => {
    await applyPromotionDecision(foragerPlan(), { action: 'promote_label', label: 'Forager Pantry' }, opts);

    // Simulate an interrupted promotion whose context ALSO carries a key this
    // plugin version does not know about (written by a newer client, or by hand).
    const path = ctxPathFor('forager-pantry');
    await stripBinding('forager-pantry', { future_field: { written_by: 'a-newer-client' } });

    const recovered = await applyPromotionDecision(
      foragerPlan(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(recovered.status).toBe('ok');

    const after = parseYaml(await readFile(path, 'utf-8')) as Record<string, unknown>;
    expect((after.binding as { kind?: string } | undefined)?.kind).toBe('sub_brand');
    // Pre-fix this wrote contextSchema.safeParse().data, which STRIPS unknown
    // keys, and then published the loss to the org store.
    expect(after.future_field).toEqual({ written_by: 'a-newer-client' });
  });

  it('recovers an interrupted promotion instead of refusing it forever', async () => {
    await applyPromotionDecision(foragerPlan(), { action: 'promote_label', label: 'Forager Pantry' }, opts);
    await stripBinding('forager-pantry');

    const recovered = await applyPromotionDecision(
      foragerPlan(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    // Pre-fix: validation_failed, "Refusing to overwrite it; investigate by hand".
    expect(recovered.status).toBe('ok');
    expect(recovered.did_write).toBe(true);
    expect(recovered.detail).toContain('interrupted');
  });

  it('still refuses a slug occupied by an unrelated brand', async () => {
    await mkdir(join(clientsDir, 'forager-pantry'), { recursive: true });
    await writeFile(
      ctxPathFor('forager-pantry'),
      'schema_version: 1\nbrand_slug: forager-pantry\nbrand_name: Someone Else Entirely\nlast_updated: "2026-08-12"\naccounts: []\n',
      'utf-8',
    );
    const result = await applyPromotionDecision(
      foragerPlan(),
      { action: 'promote_label', label: 'Forager Pantry' },
      opts,
    );
    expect(result.status).toBe('validation_failed');
    expect(result.did_write).toBe(false);
  });
});
