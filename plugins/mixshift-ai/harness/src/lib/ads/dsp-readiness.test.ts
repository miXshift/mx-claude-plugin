import { describe, it, expect } from 'vitest';
import {
  checkDspReadiness,
  renderReadiness,
  type ReadinessCall,
  type ReadinessCheck,
  type ReadinessReport,
} from './dsp-readiness.js';
import { isReportFailure, type ReportFailure } from '../amazon/reports.js';

const ADV = '583522466791149589';
const CAMP = '577494217848082836';
const AG = '594418588682008774';
const CREATIVE = '582322110087171418';

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
      productTrackingList: [{ productId: 'B0946MVWGD', productAssociation: 'FEATURED', domain: 'AMAZON_US' }],
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
    expect(renderReadiness(r)).toContain('Ready to switch on');
  });

  it('sends the advertiser as the account and the CM product filter on every Campaign Management read', async () => {
    const { call, calls } = fakeCall();
    await checkDspReadiness(call, ADV, CAMP);
    for (const c of calls) expect(c.pathParams?.advertiserId).toBe(ADV);
    const cm = calls.filter((c) => c.operation.startsWith('dsp.query_'));
    expect(cm.length).toBe(3);
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

  it('does not judge an inventory type it does not know', async () => {
    const r = await run({
      'dsp.query_ad_groups': () => ({ adGroups: [{ adGroupId: AG, inventoryType: 'SOMETHING_NEW' }] }),
    });
    expect(one(r, 'media_type').level).toBe('pass');
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

  it('only warns on a non-retail goal with no tracked products', async () => {
    const r = await run({ 'dsp.query_campaigns': kpi('REACH'), 'dsp.list_conversion_tracking_products': none });
    expect(one(r, 'tracked_products').level).toBe('warn');
    expect(r.ready).toBe(true);
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

  it('warns when the approved attachment is paused', async () => {
    const r = await run({
      'dsp.list_creative_associations': () => ({
        associations: [{ adCreativeId: CREATIVE, adGroupId: AG, state: 'INACTIVE', creativeAssociationStatus: 'APPROVED' }],
      }),
    });
    expect(one(r, 'creative').level).toBe('warn');
  });

  it('marks creatives unchecked when the attachments cannot be read', async () => {
    const r = await run({ 'dsp.list_creative_associations': () => failure() });
    expect(one(r, 'creative').level).toBe('unchecked');
    expect(r.ready).toBe(false);
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
