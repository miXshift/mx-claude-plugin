import { describe, it, expect } from 'vitest';
import {
  checkDspReadiness,
  renderReadiness,
  type ReadinessCall,
  type ReadinessCheck,
  type ReadinessReport,
} from './dsp-readiness.js';
import { isReportFailure, type ReportFailure } from '../amazon/reports.js';
import {
  buildEntriesFromCreate,
  loadCreativeMap,
  recordCreativeMappings,
  type CreativeMapInput,
  type CreativeMappingEntry,
} from './dsp-creative-map.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADV = '1000000000000000001';
const CAMP = '2000000000000000002';
const AG = '3000000000000000003';
const CREATIVE = '4000000000000000004';

type Handler = (input: Parameters<ReadinessCall>[0]) => unknown;

function ok(payload: unknown) {
  return {
    ok: true as const,
    operation: 'x',
    profileId: 'p',
    legacySellerId: 574,
    marketplaceId: null,
    payload,
  };
}

function failure(kind: ReportFailure['kind'] = 'bad_request'): ReportFailure {
  return { ok: false, kind, friendly: `read refused (${kind})`, message: 'detail' } as ReportFailure;
}

/** Shapes measured on the test advertiser 2026-11-05. */
function baseHandlers(): Record<string, Handler> {
  return {
    'dsp.query_campaigns': () => ({
      campaigns: [
        {
          campaignId: CAMP,
          name: 'Campaign2',
          state: 'PAUSED',
          optimizations: {
            goalSettings: { goal: 'CONVERSIONS', kpi: 'ROAS_PROMOTED', kpiValue: 4 },
            primaryInventoryTypes: ['DISPLAY'],
          },
        },
      ],
    }),
    'dsp.query_ad_groups': () => ({
      adGroups: [{ adGroupId: AG, campaignId: CAMP, name: 'PV', state: 'PAUSED', inventoryType: 'DISPLAY' }],
    }),
    'dsp.list_conversion_tracking_products': () => ({
      nextToken: null,
      productTrackingList: [{ productId: 'B000TEST01', productAssociation: 'FEATURED', domain: 'AMAZON_US' }],
    }),
    'dsp.query_targets': () => ({
      targets: [
        target('AUDIENCE'),
        target('DAYPART'),
        target('DEVICE'),
        inv('AMAZON'),
        inv('APD'),
        inv('THIRD_PARTY_EXCHANGE'),
        inv('THIRD_PARTY_EXCHANGE'),
        { ...target('AUDIENCE'), negative: true },
      ],
    }),
    'dsp.list_creative_associations': () => ({
      totalResults: 1,
      associations: [
        {
          adCreativeId: CREATIVE,
          adGroupId: AG,
          state: 'ACTIVE',
          creativeAssociationStatus: 'APPROVED',
          adExperiences: [{ adExperience: 'RESPONSIVE_ECOMMERCE', associationModerationStatus: 'APPROVED' }],
        },
      ],
    }),
    'dsp.list_association_moderations': () => ({
      totalResults: 1,
      associationStatuses: [
        {
          adCreativeId: CREATIVE,
          adGroupId: AG,
          adExperiences: [
            {
              adExperience: 'RESPONSIVE_ECOMMERCE',
              associationModerationStatus: 'APPROVED',
              associationModerationReasons: [],
            },
          ],
        },
      ],
    }),
    'dsp.list_eligible_creatives': () => ({
      totalResults: 1,
      adCreatives: [{ adCreativeId: CREATIVE, eligibleAdGroupIds: [AG] }],
    }),
    'dsp.query_ads': adsFrom([{ adId: CREATIVE, name: 'Responsive ad', products: ['B000TEST01'] }]),
  };
}

/** A dsp.query_ads handler answering only the ids asked for (adIdFilter), like Amazon. */
function adsFrom(
  ads: Array<{ adId: string; name?: string; products?: string[]; responsive?: boolean }>,
): Handler {
  return (input) => {
    const want = ((input.body as Record<string, unknown>).adIdFilter as { include: string[] }).include;
    return {
      ads: ads
        .filter((a) => want.includes(a.adId))
        .map((a) => ({
          adId: a.adId,
          adProduct: 'AMAZON_DSP',
          adType: a.responsive === false ? 'DISPLAY' : 'COMPONENT',
          ...(a.name ? { name: a.name } : {}),
          creative:
            a.responsive === false
              ? { displayCreative: {} }
              : {
                  componentCreative: {
                    responsiveEcommerceSettings: {
                      products: (a.products ?? []).map((productId) => ({ productId, productIdType: 'ASIN' })),
                    },
                  },
                },
        })),
    };
  };
}

function target(type: string, adGroupId = AG): Record<string, unknown> {
  return { adGroupId, campaignId: CAMP, negative: false, targetType: type, targetId: `${type}-${Math.random()}` };
}

function inv(kind: string, adGroupId = AG): Record<string, unknown> {
  return {
    ...target('INVENTORY_SOURCE', adGroupId),
    targetDetails: { inventorySourceTarget: { inventorySourceId: { defaultValue: '1' }, inventorySourceType: kind } },
  };
}

function fakeCall(overrides: Record<string, Handler> = {}) {
  const handlers = { ...baseHandlers(), ...overrides };
  const calls: Array<Parameters<ReadinessCall>[0]> = [];
  const call: ReadinessCall = async (input) => {
    calls.push(input);
    const h = handlers[input.operation];
    if (!h) throw new Error(`unexpected operation ${input.operation}`);
    const out = h(input);
    return isReportFailure(out as never) ? (out as ReportFailure) : ok(out);
  };
  return { call, calls };
}

async function run(overrides: Record<string, Handler> = {}): Promise<ReadinessReport> {
  const { call } = fakeCall(overrides);
  const r = await checkDspReadiness(call, ADV, CAMP);
  if (isReportFailure(r)) throw new Error(`unexpected failure ${r.kind}`);
  return r;
}

const byId = (r: ReadinessReport, id: string): ReadinessCheck[] => r.checks.filter((c) => c.id === id);
const one = (r: ReadinessReport, id: string): ReadinessCheck => {
  const cs = byId(r, id);
  expect(cs).toHaveLength(1);
  return cs[0] as ReadinessCheck;
};

describe('checkDspReadiness: a ready order', () => {
  it('passes every check and leaves only the console confirmation', async () => {
    const r = await run();
    expect(r.ready).toBe(true);
    expect(r.counts.fail).toBe(0);
    expect(r.counts.unchecked).toBe(0);
    expect(one(r, 'media_type').level).toBe('pass');
    expect(one(r, 'goal_kpi').detail).toBe('ROAS_PROMOTED');
    expect(one(r, 'tracked_products').level).toBe('pass');
    expect(one(r, 'targeting').detail).toContain('intended: AUDIENCE 1');
    expect(one(r, 'targeting').detail).toContain('1 exclusion(s)');
    expect(one(r, 'targeting').detail).toContain(
      'supply: Amazon 1, Publisher Direct 1, third-party exchanges 2',
    );
    expect(one(r, 'creative').level).toBe('pass');
    expect(one(r, 'automated_rec').level).toBe('confirm');
    expect(one(r, 'automated_rec').detail).toContain(CREATIVE);
    // No creative map given: the responsive creative is unverified, never a pass.
    expect(one(r, 'responsive_creative_identity').level).toBe('confirm');
    expect(renderReadiness(r)).toContain('Ready to switch on');
  });

  it('sends the advertiser as the account and the CM product filter on every Campaign Management read', async () => {
    const { call, calls } = fakeCall();
    await checkDspReadiness(call, ADV, CAMP);
    for (const c of calls) expect(c.pathParams?.advertiserId).toBe(ADV);
    const cm = calls.filter((c) => c.operation.startsWith('dsp.query_'));
    // campaigns, ad groups, targets, and the attached creatives' details
    expect(cm.length).toBe(4);
    for (const c of cm) expect((c.body as Record<string, unknown>).adProductFilter).toEqual({ include: ['AMAZON_DSP'] });
    const tp = calls.find((c) => c.operation === 'dsp.list_conversion_tracking_products');
    expect(tp?.pathParams?.campaignId).toBe(CAMP);
    // Nothing attached is missing, so the eligible-creatives fix read is skipped.
    expect(calls.some((c) => c.operation === 'dsp.list_eligible_creatives')).toBe(false);
  });
});

describe('checkDspReadiness: the order itself', () => {
  it('returns the failure when the order cannot be read at all', async () => {
    const { call } = fakeCall({ 'dsp.query_campaigns': () => failure('profile_not_authorized') });
    const r = await checkDspReadiness(call, ADV, CAMP);
    expect(isReportFailure(r)).toBe(true);
  });

  it('fails when the order is not under the advertiser', async () => {
    const r = await run({ 'dsp.query_campaigns': () => ({ campaigns: [] }) });
    expect(r.ready).toBe(false);
    expect(one(r, 'campaign').level).toBe('fail');
    expect(r.checks).toHaveLength(1);
    expect(renderReadiness(r)).toContain('NOT ready: 1 failed');
  });

  it('warns when the order is already switched on', async () => {
    const r = await run({
      'dsp.query_campaigns': () => ({
        campaigns: [{ campaignId: CAMP, state: 'ENABLED', optimizations: { primaryInventoryTypes: ['DISPLAY'], goalSettings: { kpi: 'REACH' } } }],
      }),
    });
    expect(one(r, 'campaign').level).toBe('warn');
  });
});

describe('checkDspReadiness: media type', () => {
  it('fails an order with no media type', async () => {
    const r = await run({
      'dsp.query_campaigns': () => ({
        campaigns: [{ campaignId: CAMP, state: 'PAUSED', optimizations: { goalSettings: { kpi: 'REACH' } } }],
      }),
    });
    expect(one(r, 'media_type').level).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('fails when a line item needs a media type the order does not carry', async () => {
    const r = await run({
      'dsp.query_ad_groups': () => ({ adGroups: [{ adGroupId: AG, inventoryType: 'ONLINE_VIDEO' }] }),
    });
    const c = one(r, 'media_type');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain(`${AG} (ONLINE_VIDEO)`);
  });

  it('names an inventory type it cannot map instead of passing it', async () => {
    const r = await run({
      'dsp.query_ad_groups': () => ({ adGroups: [{ adGroupId: AG, inventoryType: 'SOMETHING_NEW' }] }),
    });
    const c = one(r, 'media_type');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain(`${AG} (SOMETHING_NEW)`);
  });
});

describe('checkDspReadiness: goal and tracked products', () => {
  const kpi = (k: string) => () => ({
    campaigns: [{ campaignId: CAMP, state: 'PAUSED', optimizations: { primaryInventoryTypes: ['DISPLAY'], goalSettings: { kpi: k } } }],
  });
  const none = () => ({ nextToken: null, productTrackingList: [] });

  it('fails a retail goal with no tracked products (what Amazon refuses on activation)', async () => {
    for (const k of ['ROAS', 'ROAS_PROMOTED']) {
      const r = await run({ 'dsp.query_campaigns': kpi(k), 'dsp.list_conversion_tracking_products': none });
      const c = one(r, 'tracked_products');
      expect(c.level).toBe('fail');
      expect(c.detail).toContain('CONVERSION_TRACKING_REQUIRED');
      expect(c.fix).toContain('dsp.create_conversion_tracking_products');
    }
  });

  it('fails closed on a non-retail goal with no tracked products (Amazon refuses an endemic order without them)', async () => {
    const r = await run({ 'dsp.query_campaigns': kpi('REACH'), 'dsp.list_conversion_tracking_products': none });
    const c = one(r, 'tracked_products');
    expect(c.level).toBe('fail');
    expect(c.fix).toContain('off-Amazon conversion');
    expect(r.ready).toBe(false);
  });

  it('fails when the order shows no goal and tracks no products', async () => {
    const r = await run({
      'dsp.query_campaigns': () => ({
        campaigns: [{ campaignId: CAMP, state: 'PAUSED', optimizations: { primaryInventoryTypes: ['DISPLAY'] } }],
      }),
      'dsp.list_conversion_tracking_products': none,
    });
    expect(one(r, 'goal_kpi').level).toBe('warn');
    expect(one(r, 'tracked_products').level).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('only warns on an off-Amazon goal with no tracked products, and asks to confirm the conversion', async () => {
    const r = await run({
      'dsp.query_campaigns': kpi('COST_PER_CONVERSION_OFF_AMAZON'),
      'dsp.list_conversion_tracking_products': none,
    });
    expect(one(r, 'tracked_products').level).toBe('warn');
    expect(one(r, 'off_amazon_conversion').level).toBe('confirm');
    expect(r.ready).toBe(true);
  });

  it('passes on one tracked product even when the read stopped early', async () => {
    const r = await run({
      'dsp.list_conversion_tracking_products': () => ({ nextToken: 'more', productTrackingList: [{ productId: 'B1' }] }),
    });
    const c = one(r, 'tracked_products');
    expect(c.level).toBe('pass');
    expect(c.detail).toContain('+ tracked');
  });

  it('asks Amazon for the largest tracked-products page', async () => {
    const { call, calls } = fakeCall();
    await checkDspReadiness(call, ADV, CAMP);
    const tp = calls.find((c) => c.operation === 'dsp.list_conversion_tracking_products');
    expect(tp?.query?.maxResults).toBe(10000);
  });

  it('reads an empty 200 with neither key as none', async () => {
    const r = await run({ 'dsp.list_conversion_tracking_products': () => ({}) });
    expect(one(r, 'tracked_products').level).toBe('fail');
  });

  it('asks the user to confirm an off-Amazon conversion it cannot read', async () => {
    const r = await run({ 'dsp.query_campaigns': kpi('COST_PER_CONVERSION_OFF_AMAZON') });
    const c = one(r, 'off_amazon_conversion');
    expect(c.level).toBe('confirm');
    expect(r.ready).toBe(true);
  });

  it('warns on a deprecated KPI', async () => {
    const r = await run({ 'dsp.query_campaigns': kpi('COST_PER_ACTION') });
    expect(one(r, 'goal_kpi').level).toBe('warn');
  });

  it('pages the tracked products by query token', async () => {
    const { call, calls } = fakeCall({
      'dsp.list_conversion_tracking_products': (input) =>
        input.query?.nextToken === 't2'
          ? { productTrackingList: [{ productId: 'B2' }] }
          : { nextToken: 't2', productTrackingList: [{ productId: 'B1' }] },
    });
    const r = (await checkDspReadiness(call, ADV, CAMP)) as ReadinessReport;
    expect(r.trackedProducts).toBe(2);
    expect(calls.filter((c) => c.operation === 'dsp.list_conversion_tracking_products')).toHaveLength(2);
  });

  it('marks the tracked-products line unchecked when its read fails, and keeps going', async () => {
    const r = await run({ 'dsp.list_conversion_tracking_products': () => failure() });
    expect(one(r, 'tracked_products').level).toBe('unchecked');
    expect(one(r, 'creative').level).toBe('pass');
    expect(r.ready).toBe(false);
  });
});

describe('checkDspReadiness: line items and targeting', () => {
  it('fails an order with no line items', async () => {
    const r = await run({ 'dsp.query_ad_groups': () => ({ adGroups: [] }) });
    expect(one(r, 'line_items').level).toBe('fail');
    expect(byId(r, 'targeting')).toHaveLength(0);
    expect(one(r, 'automated_rec').level).toBe('confirm');
  });

  it('marks line items unchecked when they cannot be read', async () => {
    const r = await run({ 'dsp.query_ad_groups': () => failure() });
    expect(one(r, 'line_items').level).toBe('unchecked');
    expect(r.ready).toBe(false);
  });

  it("fails a line item that carries only Amazon's default targets", async () => {
    const r = await run({
      'dsp.query_targets': () => ({ targets: [target('DAYPART'), target('DEVICE'), inv('AMAZON'), target('DOMAIN')] }),
    });
    const c = one(r, 'targeting');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain("only Amazon's defaults");
    expect(c.fix).toContain('dsp.create_targets');
  });

  it('does not count an exclusion as intended targeting', async () => {
    const r = await run({
      'dsp.query_targets': () => ({ targets: [target('DAYPART'), { ...target('AUDIENCE'), negative: true }] }),
    });
    expect(one(r, 'targeting').level).toBe('fail');
  });

  it('warns about third-party trackers per line item', async () => {
    const r = await run({
      'dsp.query_targets': () => ({ targets: [target('AUDIENCE'), target('THIRD_PARTY'), target('THIRD_PARTY')] }),
    });
    const c = one(r, 'third_party');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('2 THIRD_PARTY');
    expect(c.fix).toContain('dsp.delete_targets');
  });

  it('pages targets by body token', async () => {
    const { call, calls } = fakeCall({
      'dsp.query_targets': (input) =>
        (input.body as Record<string, unknown>).nextToken === 'n2'
          ? { targets: [target('AUDIENCE')] }
          : { nextToken: 'n2', targets: [target('DAYPART')] },
    });
    const r = (await checkDspReadiness(call, ADV, CAMP)) as ReadinessReport;
    expect(one(r, 'targeting').level).toBe('pass');
    expect(calls.filter((c) => c.operation === 'dsp.query_targets')).toHaveLength(2);
  });

  it('never passes a check on a read that stopped early', async () => {
    let n = 0;
    const r = await run({
      'dsp.query_targets': () => ({ nextToken: `t${++n}`, targets: [target('AUDIENCE')] }),
    });
    expect(one(r, 'targeting').level).toBe('unchecked');
    expect(r.ready).toBe(false);
  });

  it("ignores line items that belong to another order", async () => {
    const r = await run({
      'dsp.query_ad_groups': () => ({
        adGroups: [
          { adGroupId: AG, campaignId: CAMP, inventoryType: 'DISPLAY' },
          { adGroupId: '9', campaignId: 'another-order', inventoryType: 'DISPLAY' },
        ],
      }),
    });
    expect(r.lineItems.map((l) => l.adGroupId)).toEqual([AG]);
  });

  it('does not count a target without a type as intended targeting', async () => {
    const r = await run({
      'dsp.query_targets': () => ({ targets: [target('DAYPART'), { adGroupId: AG, negative: false }] }),
    });
    expect(one(r, 'targeting').level).toBe('fail');
  });

  it('splits many line items across targets reads and creative reads', async () => {
    const ids = Array.from({ length: 55 }, (_, i) => `7${String(i).padStart(3, '0')}`);
    const { call, calls } = fakeCall({
      'dsp.query_ad_groups': () => ({ adGroups: ids.map((adGroupId) => ({ adGroupId, inventoryType: 'DISPLAY' })) }),
      'dsp.query_targets': (input) => {
        const inc = ((input.body as Record<string, unknown>).adGroupIdFilter as { include: string[] }).include;
        return { targets: inc.map((id) => target('AUDIENCE', id)) };
      },
      'dsp.list_creative_associations': (input) => {
        const inc = ((input.body as Record<string, unknown>).adGroupIdFilter as { include: string[] }).include;
        return {
          associations: inc.map((adGroupId) => ({ adGroupId, adCreativeId: 'c', state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' })),
        };
      },
      'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
    });
    const r = (await checkDspReadiness(call, ADV, CAMP)) as ReadinessReport;
    const tReads = calls.filter((c) => c.operation === 'dsp.query_targets');
    expect(tReads).toHaveLength(3);
    for (const c of tReads) {
      expect(((c.body as Record<string, unknown>).adGroupIdFilter as { include: string[] }).include.length).toBeLessThanOrEqual(20);
    }
    expect(calls.filter((c) => c.operation === 'dsp.list_creative_associations')).toHaveLength(2);
    expect(byId(r, 'targeting')).toHaveLength(55);
    expect(byId(r, 'targeting').every((c) => c.level === 'pass')).toBe(true);
    expect(byId(r, 'creative').every((c) => c.level === 'pass')).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('marks targeting unchecked per line item when its read fails', async () => {
    const r = await run({ 'dsp.query_targets': () => failure() });
    expect(one(r, 'targeting').level).toBe('unchecked');
  });

  it('batches line items into one targets read', async () => {
    const ids = Array.from({ length: 3 }, (_, i) => `10${i}`);
    const { call, calls } = fakeCall({
      'dsp.query_ad_groups': () => ({ adGroups: ids.map((adGroupId) => ({ adGroupId, inventoryType: 'DISPLAY' })) }),
      'dsp.query_targets': () => ({ targets: ids.map((id) => target('AUDIENCE', id)) }),
      'dsp.list_creative_associations': () => ({
        associations: ids.map((adGroupId) => ({ adGroupId, adCreativeId: 'c', state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' })),
      }),
      'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
    });
    const r = (await checkDspReadiness(call, ADV, CAMP)) as ReadinessReport;
    expect(calls.filter((c) => c.operation === 'dsp.query_targets')).toHaveLength(1);
    expect(byId(r, 'targeting').every((c) => c.level === 'pass')).toBe(true);
    // No moderation row: the association's own status decides.
    expect(byId(r, 'creative').every((c) => c.level === 'pass')).toBe(true);
    expect(r.ready).toBe(true);
  });
});

describe('checkDspReadiness: creatives', () => {
  it('fails a line item with nothing attached and names the eligible creatives', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({ associations: [] }),
      'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain(`1 eligible: ${CREATIVE}`);
    expect(c.fix).toContain('dsp.create_ad_associations');
  });

  it('says to build one in the console when nothing is eligible', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({ associations: [] }),
      'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
      'dsp.list_eligible_creatives': () => ({ adCreatives: [] }),
    });
    expect(one(r, 'creative').fix).toContain('DSP console');
  });

  it('fails while moderation is pending', async () => {
    const r = await run({
      'dsp.list_association_moderations': () => ({
        associationStatuses: [
          { adCreativeId: CREATIVE, adGroupId: AG, adExperiences: [{ adExperience: 'DISPLAY', associationModerationStatus: 'PENDING' }] },
        ],
      }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain('moderation pending');
  });

  it('fails a rejected creative with its reasons', async () => {
    const r = await run({
      'dsp.list_association_moderations': () => ({
        associationStatuses: [
          {
            adCreativeId: CREATIVE,
            adGroupId: AG,
            adExperiences: [
              {
                adExperience: 'DISPLAY',
                associationModerationStatus: 'REJECTED',
                associationModerationReasons: [{ reason: 'Logo too small' }],
              },
            ],
          },
        ],
      }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain('Logo too small');
  });

  it('fails when the only approved attachment is paused: the line item has nothing to serve', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({
        associations: [{ adCreativeId: CREATIVE, adGroupId: AG, state: 'INACTIVE', creativeAssociationStatus: 'APPROVED' }],
      }),
    });
    expect(one(r, 'creative').level).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it('warns, not fails, on approved with exceptions (some targeted supply still reviewing)', async () => {
    const reason = 'This creative is pending approval from one or more supply sources targeted by one of its line items.';
    const r = await run({
      'dsp.list_creative_associations': () => ({
        associations: [{ adCreativeId: CREATIVE, adGroupId: AG, state: 'ACTIVE', creativeAssociationStatus: 'APPROVED_WITH_EXCEPTIONS' }],
      }),
      'dsp.list_association_moderations': () => ({
        associationStatuses: [
          {
            adCreativeId: CREATIVE,
            adGroupId: AG,
            adExperiences: [
              { adExperience: 'DISPLAY', associationModerationStatus: 'APPROVED_WITH_EXCEPTIONS', associationModerationReasons: [reason] },
            ],
          },
        ],
      }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('approved with exceptions');
    expect(c.detail).toContain('pending approval from one or more supply sources');
    expect(r.ready).toBe(true);
  });

  it('fails and names a moderation status it does not recognize', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({
        associations: [{ adCreativeId: CREATIVE, adGroupId: AG, state: 'ACTIVE', creativeAssociationStatus: 'SOMETHING_NEW' }],
      }),
      'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain('SOMETHING_NEW');
  });

  it('does not count an attachment with no state as live', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({
        associations: [{ adCreativeId: CREATIVE, adGroupId: AG, creativeAssociationStatus: 'APPROVED' }],
      }),
    });
    const c = one(r, 'creative');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain('state unknown');
  });

  it('marks creatives unchecked when the attachments cannot be read', async () => {
    const r = await run({ 'dsp.list_creative_associations': () => failure() });
    expect(one(r, 'creative').level).toBe('unchecked');
    expect(r.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Responsive creative identity (spec steps 1-5). All fixtures are synthetic.
// ---------------------------------------------------------------------------

const TENANT = 'user:tenant-1';
const OTHER_TENANT = 'user:tenant-2';
const OTHER_ADV = '1000000000000000077';
const ORDER_B = '2000000000000000099';
/** This order's responsive creative. */
const REC_A = '4000000000000000011';
/** Order B's responsive creative. */
const REC_B = '4000000000000000012';
/** A responsive creative nobody recorded. */
const REC_X = '4000000000000000013';
/** A plain display creative. */
const DISPLAY = '4000000000000000014';
const ASINS = ['B000TEST01', 'B000TEST02'];

function entry(order: string, creative: string, over: Partial<CreativeMappingEntry> = {}): CreativeMappingEntry {
  return {
    tenant: TENANT,
    advertiser_id: ADV,
    order_id: order,
    creative_id: creative,
    source: 'user_confirmed',
    recorded_at: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

const mapOf = (...entries: CreativeMappingEntry[]): CreativeMapInput => ({ status: 'ok', tenant: TENANT, entries });

interface Att {
  cid: string;
  ag?: string;
  state?: string;
  rec?: boolean;
  moderation?: string;
}

/** Association + moderation handlers for the given attachments. */
function attached(...atts: Att[]): Record<string, Handler> {
  return {
    'dsp.list_creative_associations': () => ({
      associations: atts.map((a) => ({
        adCreativeId: a.cid,
        adGroupId: a.ag ?? AG,
        ...(a.state === 'none' ? {} : { state: a.state ?? 'ACTIVE' }),
        creativeAssociationStatus: a.moderation ?? 'APPROVED',
      })),
    }),
    'dsp.list_association_moderations': () => ({
      associationStatuses: atts.map((a) => ({
        adCreativeId: a.cid,
        adGroupId: a.ag ?? AG,
        adExperiences: [
          {
            adExperience: a.rec === false ? 'DISPLAY' : 'RESPONSIVE_ECOMMERCE',
            associationModerationStatus: a.moderation ?? 'APPROVED',
          },
        ],
      })),
    }),
  };
}

const allAds = adsFrom([
  { adId: REC_A, name: 'Order A responsive', products: ASINS },
  { adId: REC_B, name: 'Order B responsive', products: ASINS },
  { adId: REC_X, name: 'Unrecorded responsive', products: ASINS },
  { adId: DISPLAY, name: 'Static banner', responsive: false },
]);

async function runId(
  overrides: Record<string, Handler>,
  creativeMap?: CreativeMapInput,
): Promise<{ r: ReadinessReport; calls: Array<Parameters<ReadinessCall>[0]> }> {
  const { call, calls } = fakeCall({
    'dsp.list_conversion_tracking_products': () => ({ productTrackingList: ASINS.map((productId) => ({ productId })) }),
    'dsp.query_ads': allAds,
    ...overrides,
  });
  const r = await checkDspReadiness(call, ADV, CAMP, creativeMap ? { creativeMap } : {});
  if (isReportFailure(r)) throw new Error(`unexpected failure ${r.kind}`);
  return { r, calls };
}

const identity = (r: ReadinessReport): ReadinessCheck => one(r, 'responsive_creative_identity');
const result = (r: ReadinessReport, ag = AG) =>
  (r.responsiveCreativeIdentity ?? []).find((x) => x.adGroupId === ag);

describe('checkDspReadiness: responsive creative identity, verdicts', () => {
  it('passes when the order has a recorded creative and that creative is attached', async () => {
    const { r } = await runId(attached({ cid: REC_A }), mapOf(entry(CAMP, REC_A)));
    const c = identity(r);
    expect(c.level).toBe('pass');
    expect(c.detail).toContain(REC_A);
    expect(c.detail).toContain('confirmed by the user');
    const res = result(r);
    expect(res).toMatchObject({
      verdict: 'pass',
      reason: 'expected_attached',
      orderId: CAMP,
      expectedCreativeIds: [REC_A],
      attachedCreativeIds: [REC_A],
      evidenceSource: 'user_confirmed',
    });
    expect(r.ready).toBe(true);
  });

  it('fails on a proven mismatch: the attached creative is recorded for another order', async () => {
    const { r } = await runId(attached({ cid: REC_B }), mapOf(entry(CAMP, REC_A), entry(ORDER_B, REC_B)));
    const c = identity(r);
    expect(c.level).toBe('fail');
    expect(c.detail).toContain(`${REC_B} "Order B responsive"`);
    expect(c.detail).toContain(`recorded for order ${ORDER_B}`);
    expect(c.detail).toContain(`This order's recorded creative is ${REC_A} (not attached)`);
    // Shows the ids and the fix, and never acts on it.
    expect(c.fix).toContain(`Remove ${REC_B} from line item ${AG} in the DSP console`);
    expect(c.fix).toContain('Nothing was changed');
    expect(result(r)?.reason).toBe('other_order_attached');
    expect(r.ready).toBe(false);
  });

  it("fails when another order's recorded creative is attached even though this order has no record", async () => {
    const { r } = await runId(attached({ cid: REC_B }), mapOf(entry(ORDER_B, REC_B)));
    expect(identity(r).level).toBe('fail');
    expect(identity(r).detail).toContain('This order has no recorded responsive creative of its own');
    expect(identity(r).fix).toContain(`--creative-id ${REC_B} --reuse`);
  });

  it('fails when the recorded creative is missing from the line item, naming what is there instead', async () => {
    const { r } = await runId(attached({ cid: REC_X }), mapOf(entry(CAMP, REC_A)));
    const c = identity(r);
    expect(c.level).toBe('fail');
    expect(result(r)?.reason).toBe('expected_missing');
    expect(c.detail).toContain(`does not carry the responsive creative recorded for order ${CAMP}`);
    expect(c.detail).toContain(`Attached instead: ${REC_X}`);
    expect(c.fix).toContain(`Attach ${REC_A} to line item ${AG}`);
  });

  it('asks to confirm, never passes, an extra unrecorded responsive creative beside the expected one', async () => {
    const { r } = await runId(attached({ cid: REC_A }, { cid: REC_X }), mapOf(entry(CAMP, REC_A)));
    const c = identity(r);
    expect(c.level).toBe('confirm');
    expect(result(r)?.reason).toBe('extra_unmatched_rec');
    expect(c.detail).toContain(REC_X);
    expect(c.fix).toContain('Do not decide from its name, products or dates');
  });

  it('accepts a creative reused on purpose once the user recorded it for this order too', async () => {
    const map = mapOf(entry(ORDER_B, REC_B), entry(CAMP, REC_B, { reuse: true }));
    const { r } = await runId(attached({ cid: REC_B }), map);
    expect(identity(r).level).toBe('pass');
    expect(identity(r).detail).toContain('as an intentional reuse');
  });
});

describe('checkDspReadiness: responsive creative identity, no guessing', () => {
  it('two orders with the same ASINs: an unrecorded creative stays CONFIRM, never a guessed pass', async () => {
    // REC_X features exactly this order's tracked products; that proves nothing.
    const { r } = await runId(attached({ cid: REC_X }), mapOf());
    const c = identity(r);
    expect(c.level).toBe('confirm');
    expect(c.detail).toContain('Responsive creative attached, originating order unverified');
    expect(c.detail).toContain(`${REC_X} "Unrecorded responsive", products ${ASINS.join(', ')}`);
    expect(c.detail).toContain(`order ${CAMP} line item ${AG}`);
    expect(c.fix).toContain(`mixshift dsp creative-map confirm ${CAMP} --advertiser-id ${ADV} --creative-id ${REC_X}`);
    expect(c.fix).toContain('Never decide from its name, products or dates');
    expect(byId(r, 'responsive_creative_products')).toHaveLength(0);
  });

  it('two orders with the same ASINs: matching products never overrides a recorded mismatch', async () => {
    // REC_B features the same ASINs this order tracks, but it is recorded for order B.
    const { r } = await runId(attached({ cid: REC_B }), mapOf(entry(ORDER_B, REC_B)));
    expect(identity(r).level).toBe('fail');
  });

  it('a product difference alone is a separate WARN, not a failed identity', async () => {
    const { r } = await runId(
      {
        ...attached({ cid: REC_A }),
        'dsp.query_ads': adsFrom([{ adId: REC_A, name: 'Order A responsive', products: ['B000OTHER9'] }]),
      },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('pass');
    const w = one(r, 'responsive_creative_products');
    expect(w.level).toBe('warn');
    expect(w.detail).toContain('does not mean the creative belongs to another order');
    expect(r.ready).toBe(true);
  });

  it('an unrecorded creative with different products is still only CONFIRM (plus the product WARN)', async () => {
    const { r } = await runId(
      { ...attached({ cid: REC_X }), 'dsp.query_ads': adsFrom([{ adId: REC_X, products: ['B000OTHER9'] }]) },
      mapOf(),
    );
    expect(identity(r).level).toBe('confirm');
    expect(one(r, 'responsive_creative_products').level).toBe('warn');
  });

  it('without a usable creative map every responsive creative is CONFIRM and says why', async () => {
    const { r } = await runId(attached({ cid: REC_A }), { status: 'unavailable', reason: 'not signed in to MixShift' });
    expect(identity(r).level).toBe('confirm');
    expect(identity(r).detail).toContain('the creative map could not be used: not signed in to MixShift');
    expect(result(r)?.evidenceSource).toBe('unavailable');
    const { r: r2 } = await runId(attached({ cid: REC_A }));
    expect(identity(r2).level).toBe('confirm');
  });

  it('does not judge a line item that carries no responsive creative and none is recorded', async () => {
    const { r } = await runId(attached({ cid: DISPLAY, rec: false }), mapOf(entry(ORDER_B, REC_B)));
    expect(byId(r, 'responsive_creative_identity')).toHaveLength(0);
    expect(result(r)?.verdict).toBe('not_applicable');
    expect(r.ready).toBe(true);
  });

  it('does not expect a responsive creative on a video line item', async () => {
    const { r } = await runId(
      {
        'dsp.query_campaigns': () => ({
          campaigns: [{ campaignId: CAMP, state: 'PAUSED', optimizations: { primaryInventoryTypes: ['DISPLAY', 'VIDEO_OLV'], goalSettings: { kpi: 'REACH' } } }],
        }),
        'dsp.query_ad_groups': () => ({
          adGroups: [
            { adGroupId: AG, campaignId: CAMP, inventoryType: 'DISPLAY' },
            { adGroupId: '3000000000000000033', campaignId: CAMP, inventoryType: 'ONLINE_VIDEO' },
          ],
        }),
        'dsp.query_targets': () => ({ targets: [target('AUDIENCE'), target('AUDIENCE', '3000000000000000033')] }),
        ...attached({ cid: REC_A }, { cid: '4000000000000000099', ag: '3000000000000000033', rec: false }),
        'dsp.query_ads': adsFrom([
          { adId: REC_A, products: ASINS },
          { adId: '4000000000000000099', responsive: false },
        ]),
      },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(byId(r, 'responsive_creative_identity').map((c) => c.adGroupId)).toEqual([AG]);
    expect(result(r, '3000000000000000033')?.verdict).toBe('not_applicable');
  });

  it('can tell a creative that is not responsive from moderation alone, and never invents one', async () => {
    const { r } = await runId(
      { ...attached({ cid: DISPLAY, rec: false }), 'dsp.query_ads': () => ({ ads: [] }) },
      mapOf(),
    );
    expect(byId(r, 'responsive_creative_identity')).toHaveLength(0);
  });

  it('asks to confirm a creative whose type Amazon did not describe at all', async () => {
    const { r } = await runId(
      {
        'dsp.list_creative_associations': () => ({
          associations: [{ adCreativeId: REC_X, adGroupId: AG, state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' }],
        }),
        'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
        'dsp.query_ads': () => ({ ads: [] }),
      },
      mapOf(),
    );
    expect(identity(r).level).toBe('confirm');
    expect(result(r)?.reason).toBe('unknown_type');
  });
});

describe('checkDspReadiness: responsive creative identity, attachment states', () => {
  it('reads an inactive attachment of another order\'s creative as a mismatch too', async () => {
    const { r } = await runId(
      attached({ cid: REC_A }, { cid: REC_B, state: 'INACTIVE' }),
      mapOf(entry(CAMP, REC_A), entry(ORDER_B, REC_B)),
    );
    expect(identity(r).level).toBe('fail');
    expect(identity(r).detail).toContain('attachment INACTIVE');
    expect(identity(r).detail).toContain('(attached as well)');
  });

  it('warns, never passes, when the recorded creative is attached but its attachment is inactive', async () => {
    const { r } = await runId(
      {
        ...attached({ cid: REC_A, state: 'INACTIVE' }, { cid: DISPLAY, rec: false }),
      },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('warn');
    expect(result(r)?.reason).toBe('expected_inactive');
    // The existing active-state check is independent and still judges serving.
    expect(one(r, 'creative').level).toBe('pass');
  });

  it('keeps moderation independent: a rejected recorded creative is the right identity and a failed creative check', async () => {
    const { r } = await runId(attached({ cid: REC_A, moderation: 'REJECTED' }), mapOf(entry(CAMP, REC_A)));
    expect(identity(r).level).toBe('pass');
    expect(one(r, 'creative').level).toBe('fail');
    expect(r.ready).toBe(false);
  });

  it("fails a rejected attachment of another order's creative", async () => {
    const { r } = await runId(attached({ cid: REC_B, moderation: 'REJECTED' }), mapOf(entry(ORDER_B, REC_B)));
    expect(identity(r).level).toBe('fail');
  });

  it('fails a line item with no attachment at all when the order has a recorded creative', async () => {
    const { r } = await runId(
      {
        'dsp.list_creative_associations': () => ({ associations: [] }),
        'dsp.list_association_moderations': () => ({ associationStatuses: [] }),
      },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('fail');
    expect(identity(r).detail).toContain('Nothing is attached');
    expect(one(r, 'creative').level).toBe('fail');
  });

  it('fails a stale record: the expected creative is gone from the advertiser', async () => {
    const { r } = await runId(
      { ...attached({ cid: DISPLAY, rec: false }), 'dsp.query_ads': adsFrom([{ adId: DISPLAY, responsive: false }]) },
      mapOf(entry(CAMP, REC_A)),
    );
    const c = identity(r);
    expect(c.level).toBe('fail');
    expect(result(r)?.reason).toBe('expected_stale');
    expect(c.detail).toContain('it was deleted, or the mapping is stale');
    expect(c.fix).toContain(`mixshift dsp creative-map remove ${CAMP} --advertiser-id ${ADV} --creative-id ${REC_A}`);
  });

  it('asks to confirm when the recorded creative is attached but Amazon no longer describes it as responsive', async () => {
    const { r } = await runId(
      { ...attached({ cid: REC_A, rec: false }), 'dsp.query_ads': adsFrom([{ adId: REC_A, responsive: false }]) },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('confirm');
    expect(result(r)?.reason).toBe('expected_not_rec');
  });
});

describe('checkDspReadiness: responsive creative identity, reads', () => {
  it('is NOT CHECKED, never a pass, when the attachments cannot be read', async () => {
    const { r } = await runId({ 'dsp.list_creative_associations': () => failure() }, mapOf(entry(CAMP, REC_A)));
    expect(identity(r).level).toBe('unchecked');
    expect(r.ready).toBe(false);
  });

  it('is NOT CHECKED when the moderation read fails', async () => {
    const { r } = await runId(
      { ...attached({ cid: REC_A }), 'dsp.list_association_moderations': () => failure() },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('unchecked');
  });

  it('is NOT CHECKED when the attachment read stops early', async () => {
    let n = 0;
    const { r } = await runId(
      {
        ...attached({ cid: REC_A }),
        'dsp.list_creative_associations': () => ({
          nextToken: `t${++n}`,
          associations: [{ adCreativeId: REC_A, adGroupId: AG, state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' }],
        }),
      },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('unchecked');
    expect(result(r)?.reason).toBe('attachments_truncated');
  });

  it('is NOT CHECKED when the creative details cannot be read', async () => {
    const { r } = await runId({ ...attached({ cid: REC_A }), 'dsp.query_ads': () => failure() }, mapOf(entry(CAMP, REC_A)));
    expect(identity(r).level).toBe('unchecked');
    expect(result(r)?.reason).toBe('details_unreadable');
    expect(r.ready).toBe(false);
  });

  it('is NOT CHECKED when the creative details read stops early', async () => {
    let n = 0;
    const { r } = await runId(
      { ...attached({ cid: REC_A }), 'dsp.query_ads': () => ({ nextToken: `d${++n}`, ads: [] }) },
      mapOf(entry(CAMP, REC_A)),
    );
    expect(identity(r).level).toBe('unchecked');
    expect(result(r)?.reason).toBe('details_truncated');
  });

  it('reads every page of attachments, so a creative on page two counts', async () => {
    const { r, calls } = await runId(
      {
        ...attached({ cid: REC_A }),
        'dsp.list_creative_associations': (input) =>
          (input.body as Record<string, unknown>).nextToken === 'p2'
            ? { associations: [{ adCreativeId: REC_B, adGroupId: AG, state: 'INACTIVE', creativeAssociationStatus: 'APPROVED' }] }
            : {
                nextToken: 'p2',
                associations: [{ adCreativeId: REC_A, adGroupId: AG, state: 'ACTIVE', creativeAssociationStatus: 'APPROVED' }],
              },
      },
      mapOf(entry(CAMP, REC_A), entry(ORDER_B, REC_B)),
    );
    expect(calls.filter((c) => c.operation === 'dsp.list_creative_associations')).toHaveLength(2);
    expect(identity(r).level).toBe('fail');
    expect(result(r)?.attachedCreativeIds).toEqual([REC_A, REC_B]);
  });

  it('reads every page of creative details, and asks for the attached and expected ids only', async () => {
    const { r, calls } = await runId(
      {
        ...attached({ cid: REC_A }),
        'dsp.query_ads': (input) =>
          (input.body as Record<string, unknown>).nextToken === 'q2'
            ? { ads: [{ adId: REC_A, creative: { componentCreative: { responsiveEcommerceSettings: { products: [] } } } }] }
            : { nextToken: 'q2', ads: [] },
      },
      mapOf(entry(CAMP, REC_A)),
    );
    const q = calls.filter((c) => c.operation === 'dsp.query_ads');
    expect(q).toHaveLength(2);
    expect((q[0]?.body as Record<string, unknown>).adIdFilter).toEqual({ include: [REC_A] });
    expect((q[0]?.body as Record<string, unknown>).adProductFilter).toEqual({ include: ['AMAZON_DSP'] });
    expect(identity(r).level).toBe('pass');
  });

  it('splits more than 100 creative ids across details reads', async () => {
    const many = Array.from({ length: 105 }, (_, i) => `5${String(i).padStart(18, '0')}`);
    const { calls } = await runId(
      {
        ...attached(...many.map((cid) => ({ cid, rec: false }))),
        'dsp.query_ads': () => ({ ads: [] }),
      },
      mapOf(),
    );
    const q = calls.filter((c) => c.operation === 'dsp.query_ads');
    expect(q).toHaveLength(2);
    for (const c of q) {
      expect(((c.body as Record<string, unknown>).adIdFilter as { include: string[] }).include.length).toBeLessThanOrEqual(100);
    }
  });

  it('never writes: every call on a failing identity is a read, with no commit', async () => {
    const { calls } = await runId(attached({ cid: REC_B }), mapOf(entry(CAMP, REC_A), entry(ORDER_B, REC_B)));
    expect(calls.every((c) => !/\.(create|update|delete)_/.test(c.operation))).toBe(true);
    expect(calls.every((c) => (c as Record<string, unknown>).dryRun === undefined)).toBe(true);
  });
});

describe('checkDspReadiness: responsive creative identity, isolation and the build record', () => {
  it("never uses another tenant's records: no pass and no mismatch from them", async () => {
    const theirs = (order: string, cid: string) => entry(order, cid, { tenant: OTHER_TENANT });
    const { r } = await runId(attached({ cid: REC_A }), mapOf(theirs(CAMP, REC_A)));
    expect(identity(r).level).toBe('confirm');
    const { r: r2 } = await runId(attached({ cid: REC_B }), mapOf(theirs(ORDER_B, REC_B)));
    expect(identity(r2).level).toBe('confirm');
  });

  it("never uses another advertiser's records", async () => {
    const { r } = await runId(attached({ cid: REC_A }), mapOf(entry(CAMP, REC_A, { advertiser_id: OTHER_ADV })));
    expect(identity(r).level).toBe('confirm');
    expect(result(r)?.expectedCreativeIds).toEqual([]);
  });

  it('records the ads a MixShift build created for an order, then passes the line item that carries one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsp-map-'));
    try {
      // What a committed dsp.create_ads answers (207 multi-status).
      const payload = { success: [{ index: 0, ad: { adId: REC_A } }], error: [] };
      const built = buildEntriesFromCreate({
        tenant: TENANT,
        advertiserId: ADV,
        orderId: CAMP,
        payload,
        auditId: 'audit-build-1',
        now: new Date('2026-11-11T12:00:00Z'),
      });
      await recordCreativeMappings(built, dir);
      const loaded = await loadCreativeMap(dir);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.entries).toHaveLength(1);
      const { r } = await runId(attached({ cid: REC_A }), { status: 'ok', tenant: TENANT, entries: loaded.entries });
      expect(identity(r).level).toBe('pass');
      expect(identity(r).detail).toContain('recorded by a MixShift build (audit audit-build-1)');
      expect(result(r)?.evidenceSource).toBe('plugin_build');
      // The same record makes another order's line item carrying REC_A fail.
      const { call } = fakeCall({
        ...attached({ cid: REC_A }),
        'dsp.query_campaigns': () => ({
          campaigns: [{ campaignId: ORDER_B, state: 'PAUSED', optimizations: { primaryInventoryTypes: ['DISPLAY'], goalSettings: { kpi: 'REACH' } } }],
        }),
        'dsp.query_ad_groups': () => ({ adGroups: [{ adGroupId: AG, campaignId: ORDER_B, inventoryType: 'DISPLAY' }] }),
        'dsp.query_ads': allAds,
      });
      const rb = await checkDspReadiness(call, ADV, ORDER_B, {
        creativeMap: { status: 'ok', tenant: TENANT, entries: loaded.entries },
      });
      if (isReportFailure(rb)) throw new Error('unexpected');
      expect(identity(rb).level).toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderReadiness', () => {
  it('prints one marked line per check and the fix under a failure', async () => {
    const r = await run({ 'dsp.list_conversion_tracking_products': () => ({ productTrackingList: [] }) });
    const text = renderReadiness(r);
    expect(text).toContain('[FAIL] Tracked products present');
    expect(text).toContain('        Add the advertised ASINs');
    expect(text).toContain('[CONFIRM] Automatically created responsive ad');
    expect(text).toContain('NOT ready: 1 failed');
  });
});
