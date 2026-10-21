import { describe, it, expect } from 'vitest';
import type { CompetitiveSummaryResponseItem } from '../amazon/pricing.js';
import type { ShelfBuybox, ShelfOffers } from './client.js';
import { diagnose, planShelfCalls, renderReportHtml, renderReportMarkdown, reportCounts, summarizeCompetitiveSummary, summarizeItem, DEFAULT_METRO_ZIPS, HELD_SHARE_FLOOR, MAX_ZIPS_PER_ASIN } from './featured-offer-check.js';

// Made-up sellers and ASINs: this repo is public. The segment shape is the
// recorded Competitive Summary shape (featuredBuyingOptions ->
// segmentedFeaturedOffers -> featuredOfferSegments with glance-view weight
// and a sample postal code).
const US = 'A1EXAMPLEUS000';
const RIVAL = 'A2EXAMPLERIVAL';

function offer(sellerId: string | null, price: number, segs: Array<[string, number, string | null]>, fulfillment = 'AFN') {
  return {
    ...(sellerId ? { sellerId } : {}),
    condition: 'New',
    listingPrice: { amount: price, currencyCode: 'USD' },
    fulfillmentType: fulfillment,
    shippingOptions: [{ price: { amount: 0, currencyCode: 'USD' }, shippingOptionType: 'DEFAULT' }],
    featuredOfferSegments: segs.map(([membership, weight, zip]) => ({
      customerMembership: membership,
      segmentDetails: { glanceViewWeightPercentage: weight, ...(zip ? { sampleLocation: { postalCode: { value: zip, countryCode: 'US' } } } : {}) },
    })),
  };
}
const item = (asin: string, offers: unknown[], code = 200): CompetitiveSummaryResponseItem => ({
  status: { statusCode: code },
  body: { asin, marketplaceId: 'ATVPDKIKX0DER', featuredBuyingOptions: offers.length ? [{ buyingOptionType: 'New', segmentedFeaturedOffers: offers }] : [] },
});

const HELD = item('B0EXAMPLE01', [offer(US, 7.99, [['DEFAULT', 27.78, '37217'], ['PRIME', 66.67, '32428'], ['NON_PRIME', 5.56, '42348']])]);
const LOST = item('B0EXAMPLE02', [offer(RIVAL, 7.83, [['PRIME', 70, '75201'], ['DEFAULT', 20, '37217']]), offer(US, 7.99, [['NON_PRIME', 10, '10001']])]);
const SUPPRESSED = item('B0EXAMPLE03', []);
const ERRORED: CompetitiveSummaryResponseItem = { status: { statusCode: 400 }, body: { asin: 'B0EXAMPLE04', errors: [{ code: 'InvalidInput', message: 'ASIN not found' }] } };

describe('summarizeCompetitiveSummary', () => {
  it('reads segments, weights, sample zips and prices; classifies held, partial and no featured offer', () => {
    const s = summarizeCompetitiveSummary([HELD, LOST, SUPPRESSED, ERRORED], US);
    expect(s.map((x) => [x.asin, x.status])).toEqual([
      ['B0EXAMPLE01', 'held'],
      ['B0EXAMPLE02', 'partial'],
      ['B0EXAMPLE03', 'no_featured_offer'],
      ['B0EXAMPLE04', 'error'],
    ]);
    expect(s[0]).toMatchObject({ ourShare: 1, totalWeight: 100.01, lostZips: [], ourPrice: 7.99, competitors: [] });
    expect(s[1]).toMatchObject({ ourShare: 0.1, lostZips: ['75201', '37217'], ourPrice: 7.99 });
    expect(s[1]!.competitors).toEqual([{ sellerId: RIVAL, weight: 90, price: 7.83, fulfillment: 'AFN' }]);
    expect(s[1]!.segments[0]).toEqual({ sellerId: RIVAL, membership: 'PRIME', weight: 70, zip: '75201', price: 7.83, fulfillment: 'AFN' });
    expect(s[3]).toMatchObject({ error: 'ASIN not found' });
    expect(HELD_SHARE_FLOOR).toBe(0.99);
  });

  it('a lost ASIN (no segment ours) is lost, and a segment without a seller counts as weight nobody holds', () => {
    const s = summarizeItem(item('B0EXAMPLE05', [offer(RIVAL, 9.5, [['PRIME', 80, '60601']]), offer(null, 0, [['DEFAULT', 20, '37217']])]), US);
    expect(s.status).toBe('lost');
    expect(s.ourShare).toBe(0);
    expect(s.lostZips).toEqual(['60601', '37217']);
    expect(s.competitors).toHaveLength(1);
  });
});

describe('planShelfCalls', () => {
  const summaries = summarizeCompetitiveSummary([HELD, LOST, SUPPRESSED, ERRORED], US);
  const zipList = new Set(['75201', '10001', '60601', '90001', '02108']);

  it('plans the lost segment zips first (skipping ones off the list), then metros, then one offers call; held and errored ASINs cost nothing', () => {
    const { calls, skippedZips } = planShelfCalls(summaries, { zipList });
    expect(calls.filter((c) => c.asin === 'B0EXAMPLE01')).toHaveLength(0);
    expect(calls.filter((c) => c.asin === 'B0EXAMPLE04')).toHaveLength(0);
    const lost = calls.filter((c) => c.asin === 'B0EXAMPLE02');
    expect(lost.map((c) => [c.kind, c.zip, c.why])).toEqual([
      ['buybox', '75201', 'segment'],
      ['buybox', '10001', 'metro'],
      ['buybox', '60601', 'metro'],
      ['buybox', '90001', 'metro'],
      ['offers', '75201', 'segment'],
    ]);
    expect(skippedZips).toEqual({ B0EXAMPLE02: ['37217'] });
    const supp = calls.filter((c) => c.asin === 'B0EXAMPLE03');
    expect(supp.map((c) => c.kind)).toEqual(['buybox', 'buybox', 'buybox', 'buybox', 'offers']);
    expect(MAX_ZIPS_PER_ASIN).toBe(4);
    expect(DEFAULT_METRO_ZIPS).toEqual(['10001', '60601', '75201', '90001']);
  });

  it('honors includeHeld and custom metros', () => {
    const { calls } = planShelfCalls(summaries, { zipList, metros: ['02108'], includeHeld: true });
    expect(calls.filter((c) => c.asin === 'B0EXAMPLE01').map((c) => [c.kind, c.zip])).toEqual([
      ['buybox', '02108'],
      ['offers', '02108'],
    ]);
  });
});

const bb = (over: Partial<ShelfBuybox>): ShelfBuybox => ({ price: 7.99, currency: '$', in_stock: true, stock: 8, sold_by: 'Example Us', ships_from: 'Amazon', prime: true, free_shipping: true, free_delivery: 'Tuesday', fastest_delivery: 'Tomorrow', order_within: null, seller_id: US, delivery_to: null, promise_days_free: 5, promise_days_fastest: 1, ...over });
const off = (over: Partial<ShelfOffers['offers'][number]>) => ({ price: '$7.99', price_num: 7.99, fba: true, sold_by: 'Example Us', ships_from: 'Amazon', free_shipping: true, free_delivery: null, fastest_delivery: 'Tomorrow', order_within: null, conditions: 'New', seller_id: US, promise_days_free: 5, promise_days_fastest: 1, ...over });
const offersWith = (list: ShelfOffers['offers']): ShelfOffers => ({ product: null, offers: list, offer_count: list.length });

describe('diagnose', () => {
  const lost = summarizeItem(LOST, US);

  it('promise_loss: the winner is not cheaper but faster', () => {
    const d = diagnose(lost, [{ zip: '75201', why: 'segment', observedAt: 't1', data: bb({ seller_id: RIVAL, sold_by: 'Example Rival', price: 7.99, promise_days_fastest: 1 }) }, { zip: '10001', why: 'metro', observedAt: 't2', data: bb({}) }], { zip: '75201', observedAt: 't1', data: offersWith([off({}), off({ seller_id: RIVAL, sold_by: 'Example Rival', promise_days_fastest: 1 })]) }, US);
    expect(d.reason).toBe('promise_loss');
    expect(d.detail).toContain('Example Rival wins at 75201 at $7.99');
    expect(d.zips.map((z) => z.ours)).toEqual([false, true]);
    expect(d.undercutters).toHaveLength(0);
  });

  it('price_undercut: the winner is cheaper, and the offer list counts the undercutters', () => {
    const d = diagnose(lost, [{ zip: '75201', why: 'segment', observedAt: 't', data: bb({ seller_id: RIVAL, sold_by: 'Example Rival', price: 7.83 }) }], { zip: '75201', observedAt: 't', data: offersWith([off({}), off({ seller_id: RIVAL, sold_by: 'Example Rival', price: '$7.83', price_num: 7.83 }), off({ seller_id: 'A3EXAMPLEOTHER', sold_by: 'Example Other', price: '$7.50', price_num: 7.5 })]) }, US);
    expect(d.reason).toBe('price_undercut');
    expect(d.undercutters.map((o) => o.seller_id)).toEqual(['A3EXAMPLEOTHER', RIVAL]);
    expect(d.lowestOther?.price_num).toBe(7.5);
  });

  it('no_featured_offer when the lost zips show no Buy Box; not_on_listing when we are absent from the offer list', () => {
    const none = diagnose(lost, [{ zip: '75201', why: 'segment', observedAt: 't', data: bb({ seller_id: null, sold_by: null, price: null, in_stock: false }) }], { zip: '75201', observedAt: 't', data: offersWith([off({})]) }, US);
    expect(none.reason).toBe('no_featured_offer');
    const gone = diagnose(lost, [{ zip: '75201', why: 'segment', observedAt: 't', data: bb({ seller_id: RIVAL, sold_by: 'Example Rival' }) }], { zip: '75201', observedAt: 't', data: offersWith([off({ seller_id: RIVAL, sold_by: 'Example Rival' })]) }, US);
    expect(gone.reason).toBe('not_on_listing');
    // No Buy Box anywhere and an empty offer list: not buyable, not "our offer missing".
    const nobody = diagnose(lost, [{ zip: '75201', why: 'segment', observedAt: 't', data: bb({ seller_id: null, sold_by: null, price: null, in_stock: false }) }], { zip: '75201', observedAt: 't', data: offersWith([]) }, US);
    expect(nobody.reason).toBe('no_featured_offer');
    expect(nobody.detail).toContain('no offers at all');
  });

  it('held when Amazon and the shelf agree; lost_elsewhere when we win every observed zip but Amazon says we lose unobserved segments; unresolved with no shelf', () => {
    const held = summarizeItem(HELD, US);
    expect(diagnose(held, [{ zip: '10001', why: 'metro', observedAt: 't', data: bb({}) }], null, US).reason).toBe('held');
    expect(diagnose(lost, [{ zip: '10001', why: 'metro', observedAt: 't', data: bb({}) }], null, US).reason).toBe('lost_elsewhere');
    expect(diagnose(lost, [], null, US).reason).toBe('unresolved');
  });
});

describe('the report', () => {
  it('renders markdown and html with every ASIN, the reasons, both dates, and no provider name', () => {
    const summaries = summarizeCompetitiveSummary([HELD, LOST, SUPPRESSED, ERRORED], US);
    const lostD = diagnose(summaries[1]!, [{ zip: '75201', why: 'segment', observedAt: '2026-10-20T14:41:11.040Z', data: bb({ seller_id: RIVAL, sold_by: 'Example Rival', price: 7.83 }) }], { zip: '75201', observedAt: '2026-10-20T14:41:15.958Z', data: offersWith([off({}), off({ seller_id: RIVAL, sold_by: 'Example Rival', price: '$7.83', price_num: 7.83 })]) }, US);
    const report = { generatedAt: '2026-10-21T10:00:00.000Z', merchant: { legacySellerId: '574', amazonSellerId: US, name: 'Example Brand', marketplace: 'US' }, summaryObservedAt: '2026-10-21T09:59:00.000Z', asins: [{ summary: summaries[0]!, diagnosis: null }, { summary: summaries[1]!, diagnosis: lostD }, { summary: summaries[2]!, diagnosis: diagnose(summaries[2]!, [], null, US) }, { summary: summaries[3]!, diagnosis: null }], shelfAnswersSpent: 2, skippedZips: { B0EXAMPLE02: ['37217'] } };
    const md = renderReportMarkdown(report);
    const html = renderReportHtml(report);
    expect(reportCounts(report)).toMatchObject({ total: 4, held: 1, flagged: 2, errors: 1, price_undercut: 1, unresolved: 1 });
    for (const s of ['B0EXAMPLE01', 'B0EXAMPLE02', 'B0EXAMPLE03', 'B0EXAMPLE04', 'lost on price', 'Example Rival wins at 75201 at $7.83', '2026-10-21T09:59:00.000Z', '2026-10-20T14:41:11.040Z', '37217']) {
      expect(md).toContain(s);
      expect(html).toContain(s);
    }
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('never your Amazon credentials');
    expect((md + html).toLowerCase()).not.toContain('asgard');
  });
});
