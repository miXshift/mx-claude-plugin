import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import { brandBrainSchema } from './schema.js';
import {
  assembleBrain,
  assembleSellerSection,
  assembleCatalogSection,
  assembleCampaignSection,
  assembleRecentActivity,
  hashRows,
} from './assemble.js';
import {
  loadBrain,
  saveBrain,
  resolveAcosTargetPct,
  getBrandField,
  resolveBrandFields,
} from './read.js';
import { applyObservations, recordObservations } from './observe.js';
import { pickPrimarySeat, pickPrimarySeatByMetrics } from './fetch.js';
import type { IndexAccount } from '../clients/index-schema.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');

/** Build an IndexAccount with sensible defaults; override the fields a test
 *  cares about. Keeps the seat fixtures readable. */
function seat(over: Partial<IndexAccount> & { seller_id: number }): IndexAccount {
  return {
    seller_id: over.seller_id,
    seller_name: over.seller_name ?? `seat-${over.seller_id}`,
    merchant_alias: over.merchant_alias ?? null,
    account_type: over.account_type ?? 'SC',
    marketplace: over.marketplace ?? null,
    region: over.region ?? null,
    is_active: over.is_active ?? true,
    is_mws_user: over.is_mws_user ?? true,
    ads_active: over.ads_active ?? true,
    retail_active: over.retail_active ?? true,
  };
}

const pantryRow = {
  ID: 320,
  MerchantAlias: "Forager's Pantry",
  Name: 'Aspen Outdoor Provisions',
  ACOSTarget: '25.0',
  MonthlyBudget: 18000,
  MarketPlaceName: 'Amazon.com',
  MerchantRegion: 'NA',
  AgencyName: 'Aspen Outdoor Provisions',
  DefaultCurrencyCode: 'USD',
  iBrandReportEnabled: 1,
  iRunningInitialPull: 0,
  dtLatestRecordDate: '2026-06-08T00:00:00.000Z',
  dtMWSLatestRecordDate: new Date('2026-06-08T00:00:00.000Z'),
  dtActivatedOn: '2024-08-15T00:00:00.000Z',
  dtMwsActivatedOn: '2024-08-22T00:00:00.000Z',
};

function assembledPantry() {
  return assembleBrain({
    brandSlug: 'foragers-pantry',
    sellerRows: [pantryRow],
    sellerSproc: 'sp_brain_seller_fetch',
    generator: 'plugin@0.5.21-test',
    now: NOW,
  });
}

describe('assembleBrain', () => {
  it('produces a schema-valid document with provenance', () => {
    const brain = assembledPantry();
    const parsed = brandBrainSchema.parse(brain);
    expect(parsed.brand_slug).toBe('foragers-pantry');
    expect(parsed.generated_at).toBe(NOW.toISOString());
    expect(parsed.generator).toBe('plugin@0.5.21-test');
    expect(parsed.sources.seller).toMatchObject({
      sproc: 'sp_brain_seller_fetch',
      fetched_at: NOW.toISOString(),
      row_count: 1,
    });
    expect(parsed.sources.seller!.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lifts seller fields with defensive coercion (strings, tinyints, Dates)', () => {
    const brain = assembledPantry();
    expect(brain.seller).toMatchObject({
      merchant_alias: "Forager's Pantry",
      storefront_name: 'Aspen Outdoor Provisions',
      acos_target_pct: 25.0,
      monthly_budget: 18000,
      marketplace: 'Amazon.com',
      default_currency_code: 'USD',
      i_brand_report_enabled: true,
      i_running_initial_pull: false,
      primary_seller_id: 320,
    });
    expect(brain.seller!.data_freshness.ads_latest).toBe('2026-06-08T00:00:00.000Z');
    expect(brain.seller!.data_freshness.retail_latest).toBe('2026-06-08T00:00:00.000Z');
  });

  it('picks the first row with a non-null ACOSTarget as primary', () => {
    const seller = assembleSellerSection([
      { ID: 1, ACOSTarget: null, MerchantAlias: 'NoTarget' },
      { ID: 2, ACOSTarget: '30', MerchantAlias: 'HasTarget' },
      { ID: 3, ACOSTarget: '40', MerchantAlias: 'AlsoHasTarget' },
    ]);
    expect(seller.primary_seller_id).toBe(2);
    expect(seller.acos_target_pct).toBe(30);
    expect(seller.merchant_alias).toBe('HasTarget');
  });

  it('falls back to the first row when no row carries a target', () => {
    const seller = assembleSellerSection([
      { ID: 7, ACOSTarget: null, MerchantAlias: 'OnlyRow' },
    ]);
    expect(seller.primary_seller_id).toBe(7);
    expect(seller.acos_target_pct).toBeNull();
  });

  it('tolerates empty row sets without throwing', () => {
    const seller = assembleSellerSection([]);
    expect(seller.acos_target_pct).toBeNull();
    expect(seller.primary_seller_id).toBeNull();
  });

  it('carries previous observations forward through re-assembly', () => {
    const withObs = applyObservations(assembledPantry(), [
      {
        field: 'buy_box_health.chronic_losers',
        value: ['B00TEST'],
        confidence: 0.8,
        observed_by: 'mx-featured-offer-watch@1.0.0',
        observed_at: NOW.toISOString(),
      },
    ]);
    const reassembled = assembleBrain({
      brandSlug: 'foragers-pantry',
      sellerRows: [pantryRow],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@0.5.21-test',
      now: NOW,
      previousObservations: withObs.observations,
    });
    expect(reassembled.observations['buy_box_health.chronic_losers']).toMatchObject({
      value: ['B00TEST'],
      count: 1,
    });
  });
});

describe('pickPrimarySeat', () => {
  it("picks the pantry brand's active US Seller-Central seat (320) over its VC + non-US seats", () => {
    // A representative VC + SC fleet (synthetic values). Row order deliberately puts the VC seat (310) first to
    // prove the pick is by metadata, not array position.
    const accounts = [
      seat({ seller_id: 310, account_type: 'VC', marketplace: 'United States' }),
      seat({ seller_id: 311, account_type: 'SC', marketplace: 'Canada' }),
      seat({ seller_id: 312, account_type: 'SC', marketplace: 'Mexico' }),
      seat({ seller_id: 320, account_type: 'SC', marketplace: 'United States' }),
    ];
    expect(pickPrimarySeat(accounts)).toBe(320);
  });

  it("picks ZenithCo's US Seller-Central seat (220) across a wide VC + SC fleet", () => {
    const accounts = [
      seat({ seller_id: 210, account_type: 'VC', marketplace: 'United States' }),
      seat({ seller_id: 211, account_type: 'VC', marketplace: 'Canada' }),
      seat({ seller_id: 212, account_type: 'VC', marketplace: 'Germany' }),
      seat({ seller_id: 213, account_type: 'VC', marketplace: 'France' }),
      seat({ seller_id: 214, account_type: 'VC', marketplace: 'Italy' }),
      seat({ seller_id: 215, account_type: 'SC', marketplace: 'Canada' }),
      seat({ seller_id: 216, account_type: 'SC', marketplace: 'Mexico', is_active: false, ads_active: false }),
      seat({ seller_id: 220, account_type: 'SC', marketplace: 'United States' }),
    ];
    expect(pickPrimarySeat(accounts)).toBe(220);
  });

  it('returns the best VC seat for a VC-only brand (not hardcoded to SC)', () => {
    // No SC seat exists — the US VC seat wins over the non-US VC seats. Proves
    // SC is a PREFERENCE, applied only when present.
    const accounts = [
      seat({ seller_id: 900, account_type: 'VC', marketplace: 'Germany' }),
      seat({ seller_id: 901, account_type: 'VC', marketplace: 'United States' }),
      seat({ seller_id: 902, account_type: 'VC', marketplace: 'Canada' }),
    ];
    expect(pickPrimarySeat(accounts)).toBe(901);
  });

  it('falls back to is_active seats when none are ads_active, then to all', () => {
    // No ads_active seat → consider is_active. The active US SC seat (20) wins
    // over the active VC seat (10); the inactive US SC seat (30) is excluded.
    const someActive = [
      seat({ seller_id: 10, account_type: 'VC', marketplace: 'United States', ads_active: false, is_active: true }),
      seat({ seller_id: 30, account_type: 'SC', marketplace: 'United States', ads_active: false, is_active: false }),
      seat({ seller_id: 20, account_type: 'SC', marketplace: 'United States', ads_active: false, is_active: true }),
    ];
    expect(pickPrimarySeat(someActive)).toBe(20);

    // Nothing active at all → all accounts are candidates; SC + US still wins.
    const noneActive = [
      seat({ seller_id: 41, account_type: 'VC', marketplace: 'United States', ads_active: false, is_active: false }),
      seat({ seller_id: 40, account_type: 'SC', marketplace: 'United States', ads_active: false, is_active: false }),
    ];
    expect(pickPrimarySeat(noneActive)).toBe(40);
  });

  it('returns null when the brand has no accounts', () => {
    expect(pickPrimarySeat([])).toBeNull();
  });
});

describe('pickPrimarySeatByMetrics', () => {
  // A representative VC + SC fleet (synthetic values). The per-seat USD revenue+spend values below are the
  // synthetic trailing-30d numbers: seat 320 leads on
  // economic activity, which is what we want — same answer as the heuristic
  // here, but for the RIGHT reason (it's the economic leader, not just US-SC).
  const pantryAccounts = [
    seat({ seller_id: 310, account_type: 'VC', marketplace: 'United States' }),
    seat({ seller_id: 311, account_type: 'SC', marketplace: 'Canada' }),
    seat({ seller_id: 312, account_type: 'SC', marketplace: 'Mexico' }),
    seat({ seller_id: 320, account_type: 'SC', marketplace: 'United States' }),
  ];
  const pantryMetrics = [
    { seller_id: 310, usd_revenue: '1500.00', usd_spend: '0.00' },
    { seller_id: 311, usd_revenue: '0.00', usd_spend: '0.00' },
    { seller_id: 312, usd_revenue: '0.00', usd_spend: '0.00' },
    { seller_id: 320, usd_revenue: '200000.00', usd_spend: '30000.00' },
  ];

  it('picks the seat with the highest (usd_revenue + usd_spend): the pantry brand -> 320', () => {
    expect(pickPrimarySeatByMetrics(pantryMetrics, pantryAccounts)).toBe(320);
  });

  it('picks the economic leader even when it disagrees with the heuristic: ZenithCo -> 210 (US VC), NOT the dormant US-SC seat 220', () => {
    // A 1P-heavy
    // brand: its US Vendor seat (210) does ~$1.35M revenue+spend/30d while its
    // US Seller-Central seat (220) is dormant ($0/$0). The heuristic would
    // pick 220 (SC>VC, US-first); the metrics pick is 210, which is correct.
    const zenithcoAccounts = [
      seat({ seller_id: 210, account_type: 'VC', marketplace: 'United States' }),
      seat({ seller_id: 211, account_type: 'VC', marketplace: 'Canada' }),
      seat({ seller_id: 212, account_type: 'VC', marketplace: 'Germany' }),
      seat({ seller_id: 213, account_type: 'VC', marketplace: 'France' }),
      seat({ seller_id: 214, account_type: 'VC', marketplace: 'Italy' }),
      seat({ seller_id: 215, account_type: 'SC', marketplace: 'Canada' }),
      seat({ seller_id: 216, account_type: 'SC', marketplace: 'Mexico', is_active: false, ads_active: false }),
      seat({ seller_id: 220, account_type: 'SC', marketplace: 'United States' }),
    ];
    const zenithcoMetrics = [
      { seller_id: 210, usd_revenue: 1200000, usd_spend: 150000 },
      { seller_id: 211, usd_revenue: 100000, usd_spend: 3300 },
      { seller_id: 212, usd_revenue: 29000, usd_spend: 3000 },
      { seller_id: 213, usd_revenue: 17000, usd_spend: 900 },
      { seller_id: 214, usd_revenue: 16000, usd_spend: 1300 },
      { seller_id: 215, usd_revenue: 0, usd_spend: 0 },
      { seller_id: 216, usd_revenue: 0, usd_spend: 0 },
      { seller_id: 220, usd_revenue: 0, usd_spend: 0 },
    ];
    // Verify it really diverges from the heuristic on this fleet.
    expect(pickPrimarySeat(zenithcoAccounts)).toBe(220);
    expect(pickPrimarySeatByMetrics(zenithcoMetrics, zenithcoAccounts)).toBe(210);
  });

  it('coerces numeric-string wire values when ranking', () => {
    const accounts = [seat({ seller_id: 10 }), seat({ seller_id: 20 })];
    const rows = [
      { seller_id: '10', usd_revenue: '100.00', usd_spend: '5.00' },
      { seller_id: '20', usd_revenue: '90.00', usd_spend: '50.00' }, // 140 > 105
    ];
    expect(pickPrimarySeatByMetrics(rows, accounts)).toBe(20);
  });

  it('breaks exact ties deterministically by ascending seller_id', () => {
    const accounts = [seat({ seller_id: 30 }), seat({ seller_id: 20 }), seat({ seller_id: 40 })];
    const rows = [
      { seller_id: 30, usd_revenue: 500, usd_spend: 0 },
      { seller_id: 20, usd_revenue: 200, usd_spend: 300 }, // also 500
      { seller_id: 40, usd_revenue: 500, usd_spend: 0 }, // also 500
    ];
    // Row order deliberately not ascending; the lowest tied id (20) wins.
    expect(pickPrimarySeatByMetrics(rows, accounts)).toBe(20);
  });

  it('ignores metric rows for seats not in the brand registry (defensive)', () => {
    const accounts = [seat({ seller_id: 320 })];
    const rows = [
      { seller_id: 999, usd_revenue: 9_999_999, usd_spend: 0 }, // not a known seat
      { seller_id: 320, usd_revenue: 10, usd_spend: 0 },
    ];
    expect(pickPrimarySeatByMetrics(rows, accounts)).toBe(320);
  });

  it('returns null on empty rows so the caller falls back to the heuristic', () => {
    expect(pickPrimarySeatByMetrics([], pantryAccounts)).toBeNull();
  });

  it('returns null when every eligible seat scores zero (no economic signal)', () => {
    // A quiet brand: all seats present but zero revenue+spend. No economic
    // signal -> defer to the heuristic rather than pick an arbitrary zero row.
    const rows = [
      { seller_id: 320, usd_revenue: 0, usd_spend: 0 },
      { seller_id: 311, usd_revenue: '0.00', usd_spend: null },
    ];
    expect(pickPrimarySeatByMetrics(rows, pantryAccounts)).toBeNull();
  });

  it('returns null when no row matches a registry seat', () => {
    const rows = [{ seller_id: 12345, usd_revenue: 100, usd_spend: 100 }];
    expect(pickPrimarySeatByMetrics(rows, pantryAccounts)).toBeNull();
  });
});

describe('assembleSellerSection with a primary seat id', () => {
  // Rows where an EARLIER row carries a non-null ACOSTarget (the old heuristic
  // would lift it), but the registry-chosen primary is a LATER row. The fix
  // must lift the later row's scalars.
  const multiSeatRows = [
    {
      ID: 310,
      ACOSTarget: '40', // non-null → old heuristic would pick this row
      MerchantAlias: "Backpacker's Pantry",
      MonthlyBudget: 2000,
      MarketPlaceName: 'Amazon.com (VC)',
    },
    {
      ID: 320,
      ACOSTarget: '25',
      MerchantAlias: 'Aspen Outdoor Provisions',
      MonthlyBudget: 30000,
      MarketPlaceName: 'Amazon.com',
    },
  ];

  it('lifts scalars from the row whose ID matches primarySellerId (not the earlier ACOSTarget row)', () => {
    const seller = assembleSellerSection(multiSeatRows, 320);
    expect(seller.primary_seller_id).toBe(320);
    expect(seller.acos_target_pct).toBe(25);
    expect(seller.merchant_alias).toBe('Aspen Outdoor Provisions');
    expect(seller.monthly_budget).toBe(30000);
    expect(seller.marketplace).toBe('Amazon.com');
  });

  it('falls back to the legacy heuristic when the primary id matches no row', () => {
    const seller = assembleSellerSection(multiSeatRows, 999);
    // 999 not found → first row with a non-null ACOSTarget (310).
    expect(seller.primary_seller_id).toBe(310);
    expect(seller.acos_target_pct).toBe(40);
  });

  it('is backward-compatible: no primarySellerId uses the legacy heuristic', () => {
    const seller = assembleSellerSection(multiSeatRows);
    expect(seller.primary_seller_id).toBe(310);
    expect(seller.acos_target_pct).toBe(40);
  });
});

describe('assembleCatalogSection', () => {
  it('merges SC and VC channels: distinct ASINs, SC Brand + VC CustomBrand fallback', () => {
    const sc = [
      { ASIN: 'B001', SKU: 'SKU-1', Brand: "Forager's Pantry", ItemGroup: 'Chews' },
      { ASIN: 'B001', SKU: 'SKU-1B', Brand: "Forager's Pantry", ItemGroup: 'Chews' },
      { ASIN: 'B002', SKU: 'SKU-2', Brand: "Forager's Pantry", ItemGroup: 'Hydration' },
    ];
    const vc = [
      { Asin: 'B003', CustomBrand: 'Astronaut Foods', Brand: 'AmazonDerived', ItemGroup: 'Freeze Dried' },
      { Asin: 'B004', CustomBrand: null, Brand: 'AmazonDerived', ItemGroup: 'Freeze Dried' },
    ];
    const section = assembleCatalogSection(sc, vc);
    expect(section.asin_count).toBe(4); // B001 deduped across its 2 SKUs
    expect(section.sku_count).toBe(3);
    expect(section.sub_brands).toEqual([
      'AmazonDerived', // VC fallback when CustomBrand is null
      'Astronaut Foods',
      "Forager's Pantry",
    ]);
    expect(section.item_groups).toEqual(['Chews', 'Freeze Dried', 'Hydration']);
    // No hero rows passed -> no top_asins, and the legacy deferred marker
    // is no longer emitted.
    expect(section.top_asins).toBeUndefined();
    expect(section.hero_asins_deferred).toBeUndefined();
  });

  it('sku_count is null when the SC source did not run, 0 when it ran empty', () => {
    expect(assembleCatalogSection(null, [{ Asin: 'B1' }]).sku_count).toBeNull();
    expect(assembleCatalogSection([], [{ Asin: 'B1' }]).sku_count).toBe(0);
  });

  it('tolerates empty inputs', () => {
    const section = assembleCatalogSection([], []);
    expect(section.asin_count).toBe(0);
    expect(section.sub_brands).toEqual([]);
  });

  it('folds hero rows into top_asins per channel, preserving rank order', () => {
    const heroSc = [
      { asin: 'B001', title: 'Top SC', ordered_revenue_365d: 254334.1, units_365d: 8891, sellable_qty: '2370', days_of_supply: 73 },
      { asin: 'B002', title: 'Second SC', ordered_revenue_365d: 106929.2, units_365d: 1810, sellable_qty: '170', days_of_supply: 47 },
    ];
    const heroVc = [
      // VC hero rows carry no stock columns -> sellable_qty/days_of_supply null.
      { asin: 'B003', title: 'Top VC', ordered_revenue_365d: 20164.96, units_365d: 1358 },
    ];
    const section = assembleCatalogSection([], [], heroSc, heroVc);
    expect(section.top_asins?.sc?.map((h) => h.asin)).toEqual(['B001', 'B002']);
    expect(section.top_asins?.sc?.[0]).toEqual({
      asin: 'B001',
      title: 'Top SC',
      ordered_revenue_365d: 254334.1,
      units_365d: 8891,
      sellable_qty: 2370, // varchar Available coerced to int
      days_of_supply: 73,
    });
    expect(section.top_asins?.vc?.[0]?.sellable_qty).toBeNull();
    expect(section.top_asins?.vc?.map((h) => h.asin)).toEqual(['B003']);
  });

  it('omits a hero channel that did not run; drops rows with no asin', () => {
    const section = assembleCatalogSection(
      [],
      [],
      [
        { asin: 'B001', title: 'ok', ordered_revenue_365d: 10, units_365d: 1 },
        { asin: '', title: 'no asin', ordered_revenue_365d: 5, units_365d: 1 },
      ],
      null,
    );
    expect(section.top_asins?.sc?.map((h) => h.asin)).toEqual(['B001']);
    expect(section.top_asins?.vc).toBeUndefined();
  });
});

describe('assembleRecentActivity', () => {
  it('derives ACoS from the rolled-up spend + ad sales', () => {
    const ra = assembleRecentActivity(
      { spend_30d: 30184.12, ad_sales_30d: 145539.37, ad_orders_30d: 6112 },
      NOW,
    );
    expect(ra.spend_30d).toBe(30184.12);
    expect(ra.ad_sales_30d).toBe(145539.37);
    expect(ra.acos_30d).toBe(20.74); // 30184.12 / 145539.37 * 100, 2dp
    expect(ra.as_of).toBe(NOW.toISOString());
  });

  it('nulls ACoS when ad sales are zero or the row is empty', () => {
    expect(assembleRecentActivity({ spend_30d: 100, ad_sales_30d: 0 }, NOW).acos_30d).toBeNull();
    const empty = assembleRecentActivity(undefined, NOW);
    expect(empty.spend_30d).toBeNull();
    expect(empty.acos_30d).toBeNull();
  });
});

describe('assembleCampaignSection', () => {
  it('aggregates counts, distincts, and percentages', () => {
    const rows = [
      { Objective: 'defend', ItemGroup: 'Chews', Brand: 'BP', State: 'enabled', BidOptimization: 'smart', BrandEntityId: 'E1' },
      { Objective: 'harvest', ItemGroup: 'Chews', Brand: 'BP', State: 'paused', BidOptimization: 'manual', BrandEntityId: 'E1' },
      { Objective: 'defend', ItemGroup: 'Hydration', Brand: 'AF', State: 'enabled', BidOptimization: 'smart', BrandEntityId: null },
    ];
    const section = assembleCampaignSection(rows);
    expect(section.campaign_count).toBe(3);
    expect(section.paused_campaign_count).toBe(1);
    expect(section.distinct_objectives).toEqual(['defend', 'harvest']);
    expect(section.distinct_item_groups).toEqual(['Chews', 'Hydration']);
    expect(section.distinct_brands).toEqual(['AF', 'BP']);
    expect(section.smart_default_adoption_pct).toBe(67); // 2 of 3 known
    expect(section.brand_entity_id_presence_pct).toBe(67); // 2 of 3 rows
    expect(section.objective_tag_completeness_pct).toBe(100); // all 3 rows tagged
  });

  it('computes objective_tag_completeness_pct (CS-27 substitute) as the non-empty-Objective share', () => {
    // 2 of 4 campaigns carry a non-empty Objective (NULL/'' = untagged), so
    // completeness is 50%. distinct_objectives dedups; this counts rows.
    const section = assembleCampaignSection([
      { Objective: 'defend', State: 'enabled' },
      { Objective: 'defend', State: 'enabled' }, // same objective, still a tagged row
      { Objective: '', State: 'enabled' },
      { Objective: null, State: 'paused' },
    ]);
    expect(section.objective_tag_completeness_pct).toBe(50);
    expect(section.distinct_objectives).toEqual(['defend']);
  });

  it('treats the BidOptimization flag as off when NULL or empty (verified warehouse convention)', () => {
    // Real column values 2026-06-12: NULL / '' = off, '1' = smart on.
    const section = assembleCampaignSection([
      { State: 'enabled', BidOptimization: '1' },
      { State: 'enabled', BidOptimization: null },
      { State: 'enabled', BidOptimization: '' },
      { State: 'enabled' },
    ]);
    expect(section.smart_default_adoption_pct).toBe(25); // 1 of 4 campaigns
  });

  it('returns null percentages only when there are no campaigns at all', () => {
    expect(assembleCampaignSection([]).smart_default_adoption_pct).toBeNull();
    expect(assembleCampaignSection([]).brand_entity_id_presence_pct).toBeNull();
    expect(assembleCampaignSection([]).objective_tag_completeness_pct).toBeNull();
    const noBidColumn = assembleCampaignSection([
      { Objective: 'defend', State: 'enabled' },
    ]);
    expect(noBidColumn.smart_default_adoption_pct).toBe(0);
    expect(noBidColumn.brand_entity_id_presence_pct).toBe(0);
    expect(noBidColumn.objective_tag_completeness_pct).toBe(100); // the 1 row is tagged
  });
});

describe('assembleBrain with slice-2 sources', () => {
  it('renders sections + source metas only for provided sources, schema-valid', () => {
    const brain = assembleBrain({
      brandSlug: 'foragers-pantry',
      sellerRows: [pantryRow],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@test',
      now: NOW,
      catalogSc: {
        rows: [{ ASIN: 'B001', SKU: 'S1', Brand: 'BP', ItemGroup: 'Chews' }],
        sproc: 'sp_brain_catalog_fetch_sc',
      },
      campaign: {
        rows: [{ Objective: 'defend', State: 'enabled' }],
        sproc: 'sp_brain_campaign_fetch',
      },
    });
    const parsed = brandBrainSchema.parse(brain);
    expect(parsed.catalog?.asin_count).toBe(1);
    expect(parsed.campaign_structure?.campaign_count).toBe(1);
    expect(parsed.sources.catalog_sc?.sproc).toBe('sp_brain_catalog_fetch_sc');
    expect(parsed.sources.campaign?.row_count).toBe(1);
    expect(parsed.sources.catalog_vc).toBeUndefined();
    expect(parsed.catalog?.sku_count).toBe(1);
  });
});

describe('hashRows', () => {
  it('is stable across key order and Date/string equivalence', () => {
    const a = hashRows([{ x: 1, y: 'a', d: new Date('2026-01-01T00:00:00.000Z') }]);
    const b = hashRows([{ d: '2026-01-01T00:00:00.000Z', y: 'a', x: 1 }]);
    expect(a).toBe(b);
  });

  it('changes when values change', () => {
    expect(hashRows([{ x: 1 }])).not.toBe(hashRows([{ x: 2 }]));
  });
});

describe('saveBrain + loadBrain round-trip', () => {
  it('round-trips through yaml atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const brain = assembledPantry();
      const { path } = await saveBrain(brain, dir);
      expect(path).toContain(join('clients', 'foragers-pantry'));
      const loaded = await loadBrain('foragers-pantry', dir);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.brain).toEqual(brain);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file_missing (not throw) for un-fetched brands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const loaded = await loadBrain('never-fetched', dir);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.kind).toBe('file_missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns schema_violation for documents from a different shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const brandDir = join(dir, 'clients', 'bad-brand');
      await mkdir(brandDir, { recursive: true });
      await writeFile(
        join(brandDir, 'brand-brain.yaml'),
        stringifyYaml({ schema_version: 99, nonsense: true }),
        'utf-8',
      );
      const loaded = await loadBrain('bad-brand', dir);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.kind).toBe('schema_violation');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still loads an OLD brain whose stockouts carry the removed impacted_revenue_usd key', async () => {
    // Persisted brand-brain.yaml files written before the field's removal
    // (fb 37350) carry impacted_revenue_usd on every stockout window, both
    // locally and in org-store copies. z.object strips unknown keys by
    // default (no .strict() on this path), so those documents must keep
    // loading, with the stale key silently dropped.
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const brandDir = join(dir, 'clients', 'foragers-pantry');
      await mkdir(brandDir, { recursive: true });
      const oldBrain = {
        ...assembledPantry(),
        sources: {
          ...assembledPantry().sources,
          stockout: {
            sproc: 'CS-29',
            fetched_at: NOW.toISOString(),
            row_count: 3,
            source_hash: 'a'.repeat(64),
          },
        },
        stockouts: [
          {
            asin: 'B07X',
            item_name: 'Widget',
            started: '2026-05-01',
            ended: '2026-05-03',
            days_in_window: 3,
            days_at_zero: 3,
            impacted_revenue_usd: 12345.67, // removed field, still on disk
            signal_source: 'sellable_zero',
          },
        ],
      };
      await writeFile(
        join(brandDir, 'brand-brain.yaml'),
        stringifyYaml(oldBrain),
        'utf-8',
      );
      const loaded = await loadBrain('foragers-pantry', dir);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.brain.stockouts).toHaveLength(1);
        expect(loaded.brain.stockouts![0]).toMatchObject({
          asin: 'B07X',
          days_in_window: 3,
        });
        expect(loaded.brain.stockouts![0]).not.toHaveProperty(
          'impacted_revenue_usd',
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes brains whose stockouts still satisfy the pre-0.8.8 REQUIRED-field schema', () => {
    // Reverse-direction compat guard (fb 37350 red team): brand-brain.yaml
    // is a two-way synced doc and the sync engine validates pulled brain
    // docs as YAML only, so a brain written by THIS build gets auto-pulled
    // by teammates on shipped builds 0.6.0-0.8.7, whose brainStockoutSchema
    // declares impacted_revenue_usd as a REQUIRED z.number(). Without the
    // assemble-side compat shim (literal 0), their ENTIRE brain document
    // would fail safeParse and every consumer would silently degrade to
    // "no brain". This reconstruction of the OLD stockout schema exists
    // solely to pin that wire contract; delete it together with the shim.
    const preRemovalStockoutSchema = z.object({
      asin: z.string(),
      item_name: z.string(),
      started: z.string(),
      ended: z.string(),
      days_in_window: z.number().int(),
      days_at_zero: z.number().int(),
      impacted_revenue_usd: z.number(),
      signal_source: z.enum([
        'sellable_zero',
        'alert_active',
        'days_of_supply_low',
        'multi',
      ]),
    });

    const brain = assembleBrain({
      brandSlug: 'foragers-pantry',
      sellerRows: [pantryRow],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@0.5.21-test',
      now: NOW,
      stockout: {
        sproc: 'CS-29',
        rows: [
          { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-01', SellableQuantity: 0 },
          { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-02', SellableQuantity: 0 },
          { ASIN: 'B07X', ItemName: 'Widget', snapshot_date: '2026-05-03', SellableQuantity: 0 },
        ],
      },
    });

    // Round-trip through the wire format old builds actually read.
    const serialized = parseYaml(stringifyYaml(brain)) as {
      stockouts?: Array<Record<string, unknown>>;
    };
    expect(serialized.stockouts).toBeDefined();
    expect(serialized.stockouts!.length).toBeGreaterThan(0);
    for (const w of serialized.stockouts!) {
      expect(w.impacted_revenue_usd).toBe(0);
      const parsed = preRemovalStockoutSchema.safeParse(w);
      expect(parsed.success).toBe(true);
    }
    // And this build's own schema still accepts (and strips) what it wrote.
    const reparsed = brandBrainSchema.safeParse(serialized);
    expect(reparsed.success).toBe(true);
    if (reparsed.success) {
      expect(reparsed.data.stockouts![0]).not.toHaveProperty(
        'impacted_revenue_usd',
      );
    }
  });
});

describe('getBrandField / resolveBrandFields (accessor seam)', () => {
  const validContext = {
    schema_version: 1,
    brand_slug: 'foragers-pantry',
    brand_name: "Forager's Pantry",
    last_updated: '2026-06-10',
    accounts: [
      {
        seller_id: 320,
        seller_name: 'Aspen Outdoor Provisions',
        account_type: 'SC',
        status: 'active',
        role: 'primary',
        marketplace: 'Amazon.com',
      },
    ],
    sources: {
      ad_metrics: 'campaignmetric',
      ops_revenue: 'business_reports_dpst_date',
      ops_revenue_field: 'SalesAmount',
      ops_units_field: 'UnitsOrdered',
      ops_date_field: 'DateTime',
    },
    management: { primary_metric: 'ACOS', acos_target_pct: 22, attribution_window_days: 14 },
    posture: { stance: 'scale', multiplier: 0.5 },
  };

  async function withFixtures(
    withContext: boolean,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      // brain: acos 25, marketplace Amazon.com, monthly_budget 18000
      await saveBrain(assembledPantry(), dir);
      if (withContext) {
        const brandDir = join(dir, 'clients', 'foragers-pantry');
        await mkdir(brandDir, { recursive: true });
        await writeFile(
          join(brandDir, 'context.yaml'),
          stringifyYaml(validContext),
          'utf-8',
        );
      }
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it('Tier 3 wins for a both-tiers field (context 22 beats brain 25)', async () => {
    await withFixtures(true, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'acos_target_pct', dir);
      expect(r).toMatchObject({ value: 22, source: 'context' });
    });
  });

  it('falls back to the brain for a both-tiers field when context is absent', async () => {
    await withFixtures(false, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'acos_target_pct', dir);
      expect(r).toMatchObject({
        value: 25,
        source: 'brain',
        fetched_at: NOW.toISOString(),
      });
    });
  });

  it('resolves a Tier-2-only field from the brain (monthly_budget)', async () => {
    await withFixtures(true, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'monthly_budget', dir);
      expect(r).toMatchObject({ value: 18000, source: 'brain' });
    });
  });

  it('resolves a Tier-3-only field from context, null when absent', async () => {
    await withFixtures(true, async (dir) => {
      expect(
        await getBrandField('foragers-pantry', 'posture_stance', dir),
      ).toMatchObject({ value: 'scale', source: 'context' });
    });
    await withFixtures(false, async (dir) => {
      // posture is Tier-3-only; no context => null (caller defaults to 'scale')
      expect(
        await getBrandField('foragers-pantry', 'posture_stance', dir),
      ).toBeNull();
    });
  });

  it('resolveBrandFields returns the full map with per-field source labels', async () => {
    await withFixtures(true, async (dir) => {
      const all = await resolveBrandFields('foragers-pantry', dir);
      expect(all.acos_target_pct).toMatchObject({ value: 22, source: 'context' });
      expect(all.monthly_budget).toMatchObject({ source: 'brain' });
      expect(all.primary_metric).toMatchObject({ value: 'ACOS', source: 'context' });
      // a Tier-3-only field not set in this context => gap (null)
      expect(all.protected_terms).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // F2 (red-team review): ResolvedField's account_wide scope flag.
  // A bound brand's Tier-2 pre-fill must be distinguishable from "this
  // sub-brand's own value" when the underlying source has no proven
  // label-scoped result for it. Byte-identical for an unbound brand.
  // -------------------------------------------------------------------------

  const boundContext = {
    ...validContext,
    binding: {
      kind: 'sub_brand',
      amazon_seller_id: 'A1EXAMPLE23456',
      retail_label: { source: 'mws_items.Brand', value: "Forager's Pantry" },
      ads_label: { source: 'campaign.Brand', value: "Forager's Pantry" },
    },
  };

  /** A brain with a populated catalog section (so sub_brands/item_groups
   *  actually resolve), optionally carrying a `label_lens` record. */
  function boundBrain(labelLens?: Record<string, unknown>) {
    const brain = assembleBrain({
      brandSlug: 'foragers-pantry',
      sellerRows: [aopRow],
      sellerSproc: 'sp_brain_seller_fetch',
      generator: 'plugin@0.5.21-test',
      now: NOW,
      catalogSc: {
        rows: [{ ASIN: 'B001', SKU: 'S1', Brand: "Forager's Pantry", ItemGroup: 'Chews' }],
        sproc: 'sp_brain_catalog_fetch_sc',
      },
    });
    return labelLens ? { ...brain, label_lens: labelLens } : brain;
  }

  /** Write a bound brand's context.yaml plus the given brain. */
  async function withBoundFixtures(
    brain: unknown,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(brain as never, dir);
      const brandDir = join(dir, 'clients', 'foragers-pantry');
      await mkdir(brandDir, { recursive: true });
      await writeFile(
        join(brandDir, 'context.yaml'),
        stringifyYaml(boundContext),
        'utf-8',
      );
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("flags a bound brand's account-wide-only brain field (monthly_budget: seller source, never label-aware)", async () => {
    await withBoundFixtures(boundBrain(), async (dir) => {
      const r = await getBrandField('foragers-pantry', 'monthly_budget', dir);
      expect(r).toMatchObject({ value: 18000, source: 'brain', account_wide: true });
    });
  });

  it('does NOT flag the same field for an UNBOUND brand (byte-identical to before F2)', async () => {
    await withFixtures(true, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'monthly_budget', dir);
      expect(r).toMatchObject({ value: 18000, source: 'brain' });
      expect(r).not.toHaveProperty('account_wide');
      // The whole resolveBrandFields payload must carry the key nowhere.
      const all = await resolveBrandFields('foragers-pantry', dir);
      expect(JSON.stringify(all)).not.toContain('account_wide');
    });
  });

  it('never flags a Tier-3 context value as account-wide, even when bound', async () => {
    await withBoundFixtures(boundBrain(), async (dir) => {
      const r = await getBrandField('foragers-pantry', 'acos_target_pct', dir);
      expect(r).toMatchObject({ value: 22, source: 'context' });
      expect(r).not.toHaveProperty('account_wide');
    });
  });

  it('a label-aware brain field (sub_brands via BRAIN-CATALOG-SC) is account-wide when the lens did NOT resolve to applied', async () => {
    const brain = boundBrain({
      bound: true,
      applied: [],
      dropped: ['BRAIN-CATALOG-SC'],
      unverified: [],
      account_wide: [],
      missing_label_value: [],
      query_failed: [],
    });
    await withBoundFixtures(brain, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'sub_brands', dir);
      expect(r).not.toBeNull();
      expect(r?.account_wide).toBe(true);
    });
  });

  it('the SAME label-aware brain field is NOT account-wide once its query resolved to applied', async () => {
    const brain = boundBrain({
      bound: true,
      applied: ['BRAIN-CATALOG-SC'],
      dropped: [],
      unverified: [],
      account_wide: [],
      missing_label_value: [],
      query_failed: [],
    });
    await withBoundFixtures(brain, async (dir) => {
      const r = await getBrandField('foragers-pantry', 'sub_brands', dir);
      expect(r).not.toBeNull();
      expect(r).not.toHaveProperty('account_wide');
    });
  });
});

describe('resolveAcosTargetPct precedence', () => {
  it('prefers Tier 3: a schema-valid context.yaml beats the brain value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledPantry(), dir); // brain says 25
      const brandDir = join(dir, 'clients', 'foragers-pantry');
      await mkdir(brandDir, { recursive: true });
      const validContext = {
        schema_version: 1,
        brand_slug: 'foragers-pantry',
        brand_name: "Forager's Pantry",
        last_updated: '2026-06-10',
        accounts: [
          {
            seller_id: 320,
            seller_name: 'Aspen Outdoor Provisions',
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
          acos_target_pct: 22,
          attribution_window_days: 14,
        },
      };
      await writeFile(
        join(brandDir, 'context.yaml'),
        stringifyYaml(validContext),
        'utf-8',
      );
      const resolved = await resolveAcosTargetPct('foragers-pantry', dir);
      expect(resolved).toMatchObject({ value: 22, source: 'context' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls through to the brain when context.yaml exists but fails schema validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledPantry(), dir); // brain says 25
      const brandDir = join(dir, 'clients', 'foragers-pantry');
      await writeFile(
        join(brandDir, 'context.yaml'),
        // Minimal context that satisfies just the fields we read; the
        // resolver uses validateBrandContext, so a schema-invalid file
        // falls through to the brain rather than throwing.
        stringifyYaml({ management: { acos_target_pct: 22 } }),
        'utf-8',
      );
      const resolved = await resolveAcosTargetPct('foragers-pantry', dir);
      // context.yaml here is schema-incomplete, so validation fails and
      // the brain value is the correct outcome. This asserts the
      // fall-through behavior is graceful.
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe('brain');
      expect(resolved!.value).toBe(25);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves the brain value with fetched_at when no context exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledPantry(), dir);
      const resolved = await resolveAcosTargetPct('foragers-pantry', dir);
      expect(resolved).toMatchObject({
        value: 25,
        source: 'brain',
        fetched_at: NOW.toISOString(),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when neither tier has the field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const noTarget = assembleBrain({
        brandSlug: 'no-target',
        sellerRows: [{ ID: 1, ACOSTarget: null }],
        sellerSproc: 'sp_brain_seller_fetch',
        generator: 'plugin@test',
        now: NOW,
      });
      await saveBrain(noTarget, dir);
      expect(await resolveAcosTargetPct('no-target', dir)).toBeNull();
      expect(await resolveAcosTargetPct('never-fetched', dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('observations', () => {
  it('applyObservations bumps count on repeat and keeps latest value', () => {
    const base = assembledPantry();
    const obs = (value: unknown) => ({
      field: 'buy_box_health.chronic_losers',
      value,
      confidence: 0.7,
      observed_by: 'mx-featured-offer-watch@1.0.0',
      observed_at: NOW.toISOString(),
    });
    const once = applyObservations(base, [obs(['A'])]);
    const twice = applyObservations(once, [obs(['A', 'B'])]);
    const agg = twice.observations['buy_box_health.chronic_losers']!;
    expect(agg.count).toBe(2);
    expect(agg.value).toEqual(['A', 'B']);
    // Pure: the base document is untouched.
    expect(base.observations['buy_box_health.chronic_losers']).toBeUndefined();
  });

  it('recordObservations persists through the local transport', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      await saveBrain(assembledPantry(), dir);
      const result = await recordObservations(
        'foragers-pantry',
        [
          {
            field: 'buy_box_health.rolling_lost_rev_usd',
            value: 612.5,
            confidence: 0.6,
            observed_by: 'mx-featured-offer-watch@1.0.0',
            observed_at: NOW.toISOString(),
          },
        ],
        dir,
      );
      expect(result.ok).toBe(true);
      const loaded = await loadBrain('foragers-pantry', dir);
      if (loaded.ok) {
        expect(
          loaded.brain.observations['buy_box_health.rolling_lost_rev_usd'],
        ).toMatchObject({ value: 612.5, count: 1 });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordObservations no-ops gracefully when no brain exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-brain-'));
    try {
      const result = await recordObservations(
        'never-fetched',
        [
          {
            field: 'x.y',
            value: 1,
            confidence: 0.5,
            observed_by: 'test@0',
            observed_at: NOW.toISOString(),
          },
        ],
        dir,
      );
      expect(result.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
