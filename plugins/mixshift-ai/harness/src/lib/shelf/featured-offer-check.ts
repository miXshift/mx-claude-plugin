/**
 * The on-demand featured-offer check (epic mx-ops#158, F2): the pure half.
 *
 * Reads the account's own answer from Amazon (the Competitive Summary's
 * segmented featured offers: who holds the Buy Box for each shopper segment,
 * with the segment's glance-view weight and sample zip), decides which ASINs
 * are lost or at risk, plans a bounded shelf fan-out for those (the Buy Box at
 * the lost segments' sample zips and a few metros, plus the offer list), and
 * explains each loss from what the shelf shows: a faster promise, a lower
 * price, no featured offer at all, or our offer missing from the listing.
 *
 * Nothing here does I/O: the command (commands/shelf-featured-offer-check.ts)
 * calls the clients and persists the state between invocations, so every
 * decision in this file is testable on fixtures.
 *
 * Division of labor (plan section 1): SP-API detects and weights the loss;
 * the shelf resolves and diagnoses it. Both answers are dated; the page shows
 * both dates.
 */

import type { CompetitiveSummaryResponseItem } from '../amazon/pricing.js';
import type { ShelfBuybox, ShelfOffers, ShelfOffer } from './client.js';

// ---------------------------------------------------------------------------
// 1. The account's own answer: Competitive Summary per segment
// ---------------------------------------------------------------------------

export interface SegmentView {
  /** The seller Amazon featured for this segment; null when Amazon named none. */
  sellerId: string | null;
  /** PRIME | NON_PRIME | DEFAULT (Amazon's customerMembership). */
  membership: string;
  /** glanceViewWeightPercentage: the share of views this segment represents. */
  weight: number;
  /** The segment's representative postal code, when Amazon gives one. */
  zip: string | null;
  /** Listing price plus the default shipping option, when present. */
  price: number | null;
  /** AFN (FBA) | MFN | null. */
  fulfillment: string | null;
}

export type AsinStatus = 'held' | 'partial' | 'lost' | 'no_featured_offer' | 'error';

export interface AsinSummary {
  asin: string;
  status: AsinStatus;
  /** Our share of the total glance-view weight (0..1). */
  ourShare: number;
  totalWeight: number;
  segments: SegmentView[];
  /** Sellers other than us that hold weight, largest first. */
  competitors: Array<{ sellerId: string; weight: number; price: number | null; fulfillment: string | null }>;
  /** Sample zips of the segments we do not hold (deduplicated, in weight order). */
  lostZips: string[];
  /** Our featured price where we hold a segment, else null. */
  ourPrice: number | null;
  error: string | null;
}

/**
 * Full-share floor for "held". Convention: a seller holding at least 99% of
 * the glance-view weight holds the featured offer for practical purposes;
 * Amazon's weights are rounded to two decimals and the odd DEFAULT segment of
 * under 1% is noise, not a loss.
 */
export const HELD_SHARE_FLOOR = 0.99;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : []);

function landedPrice(offer: Record<string, unknown>): number | null {
  const lp = num(obj(offer.listingPrice)?.amount);
  if (lp === null) return null;
  const ship = list(offer.shippingOptions)[0];
  const sp = ship ? num(obj(ship.price)?.amount) ?? 0 : 0;
  return Math.round((lp + sp) * 100) / 100;
}

/** One ASIN's Competitive Summary item to a segment view. */
export function summarizeItem(item: CompetitiveSummaryResponseItem, ourSellerId: string): AsinSummary {
  const body = item.body ?? {};
  const asin = String(body.asin ?? '').toUpperCase();
  const base: AsinSummary = { asin, status: 'error', ourShare: 0, totalWeight: 0, segments: [], competitors: [], lostZips: [], ourPrice: null, error: null };
  const code = item.status?.statusCode ?? 0;
  const errors = [...(item.errors ?? []), ...(body.errors ?? [])];
  if (code < 200 || code >= 300 || errors.length > 0) {
    base.error = errors.map((e) => e.message || e.code).filter(Boolean).join('; ') || `HTTP ${code}`;
    return base;
  }
  const segments: SegmentView[] = [];
  for (const option of list(body.featuredBuyingOptions)) {
    for (const offer of list(option.segmentedFeaturedOffers)) {
      const sellerId = str(offer.sellerId);
      const price = landedPrice(offer);
      const fulfillment = str(offer.fulfillmentType);
      for (const seg of list(offer.featuredOfferSegments)) {
        const details = obj(seg.segmentDetails);
        const postal = obj(obj(details?.sampleLocation)?.postalCode);
        segments.push({
          sellerId,
          membership: str(seg.customerMembership) ?? 'UNKNOWN',
          weight: num(details?.glanceViewWeightPercentage) ?? 0,
          zip: str(postal?.value),
          price,
          fulfillment,
        });
      }
    }
  }
  const totalWeight = segments.reduce((a, s) => a + s.weight, 0);
  const ours = segments.filter((s) => s.sellerId === ourSellerId);
  const ourWeight = ours.reduce((a, s) => a + s.weight, 0);
  const ourShare = totalWeight > 0 ? ourWeight / totalWeight : 0;
  const byCompetitor = new Map<string, { sellerId: string; weight: number; price: number | null; fulfillment: string | null }>();
  for (const s of segments) {
    if (!s.sellerId || s.sellerId === ourSellerId) continue;
    const c = byCompetitor.get(s.sellerId) ?? { sellerId: s.sellerId, weight: 0, price: s.price, fulfillment: s.fulfillment };
    c.weight += s.weight;
    byCompetitor.set(s.sellerId, c);
  }
  const competitors = [...byCompetitor.values()].sort((a, b) => b.weight - a.weight);
  const lostZips: string[] = [];
  for (const s of [...segments].sort((a, b) => b.weight - a.weight)) {
    if (s.sellerId !== ourSellerId && s.zip && !lostZips.includes(s.zip)) lostZips.push(s.zip);
  }
  const status: AsinStatus = segments.length === 0 ? 'no_featured_offer' : ourShare >= HELD_SHARE_FLOOR ? 'held' : ourShare > 0 ? 'partial' : 'lost';
  return {
    ...base,
    status,
    ourShare: Math.round(ourShare * 10000) / 10000,
    totalWeight: Math.round(totalWeight * 100) / 100,
    segments,
    competitors,
    lostZips,
    ourPrice: ours.find((s) => s.price !== null)?.price ?? null,
  };
}

export function summarizeCompetitiveSummary(responses: CompetitiveSummaryResponseItem[], ourSellerId: string): AsinSummary[] {
  return responses.map((r) => summarizeItem(r, ourSellerId)).filter((s) => s.asin !== '');
}

// ---------------------------------------------------------------------------
// 2. The shelf plan: which calls to spend on which ASIN
// ---------------------------------------------------------------------------

export interface ShelfCall {
  asin: string;
  kind: 'buybox' | 'offers';
  zip: string;
  /** Why this zip: a lost segment's sample location, or a metro the user chose. */
  why: 'segment' | 'metro';
}

/**
 * Metro zips used when the caller names none. Convention: the four largest
 * US metros by population among the provider's observation points; three or
 * four points is enough to show "same price, slower promise here" without
 * spending the allowance on the whole list.
 */
export const DEFAULT_METRO_ZIPS = ['10001', '60601', '75201', '90001'];

/**
 * Zips observed per flagged ASIN at most. Convention: the lost segments'
 * sample zips first (they are where the account lost views), then metros up
 * to this count; 4 Buy Box calls plus 1 offers call per ASIN keeps a 20-ASIN
 * check under 100 answers.
 */
export const MAX_ZIPS_PER_ASIN = 4;

export interface PlanOptions {
  /** The provider's observable zips for the marketplace (free list); a sample zip off it is skipped. */
  zipList: ReadonlySet<string>;
  /** Metros to add after the segment zips; defaults to DEFAULT_METRO_ZIPS filtered by zipList. */
  metros?: string[];
  /** Also observe ASINs the account holds (default false: held ASINs cost nothing). */
  includeHeld?: boolean;
  maxZipsPerAsin?: number;
}

export function planShelfCalls(summaries: AsinSummary[], opts: PlanOptions): { calls: ShelfCall[]; skippedZips: Record<string, string[]> } {
  const maxZips = opts.maxZipsPerAsin ?? MAX_ZIPS_PER_ASIN;
  const metros = (opts.metros ?? DEFAULT_METRO_ZIPS).filter((z) => opts.zipList.has(z));
  const calls: ShelfCall[] = [];
  const skippedZips: Record<string, string[]> = {};
  for (const s of summaries) {
    if (s.status === 'error') continue;
    if (s.status === 'held' && !opts.includeHeld) continue;
    const zips: ShelfCall[] = [];
    const seen = new Set<string>();
    for (const z of s.lostZips) {
      if (!opts.zipList.has(z)) {
        (skippedZips[s.asin] ??= []).push(z);
        continue;
      }
      if (!seen.has(z) && zips.length < maxZips) {
        seen.add(z);
        zips.push({ asin: s.asin, kind: 'buybox', zip: z, why: 'segment' });
      }
    }
    for (const z of metros) {
      if (!seen.has(z) && zips.length < maxZips) {
        seen.add(z);
        zips.push({ asin: s.asin, kind: 'buybox', zip: z, why: 'metro' });
      }
    }
    calls.push(...zips);
    const offersZip = zips[0]?.zip ?? metros[0];
    if (offersZip) calls.push({ asin: s.asin, kind: 'offers', zip: offersZip, why: zips[0]?.why ?? 'metro' });
  }
  return { calls, skippedZips };
}

// ---------------------------------------------------------------------------
// 3. The diagnosis: what the shelf says about each loss
// ---------------------------------------------------------------------------

export type LossReason =
  | 'held' // Amazon and the shelf both say we hold it
  | 'promise_loss' // another seller wins at the same or a higher price with a faster promise
  | 'price_undercut' // another seller wins at a lower price
  | 'no_featured_offer' // no Buy Box at the observed locations (suppressed)
  | 'not_on_listing' // our offer is not in the offer list at all (out of stock or not listed)
  | 'lost_elsewhere' // we win every observed zip but Amazon says we lose a segment we could not observe
  | 'unresolved'; // lost per Amazon; the shelf had no answer for this ASIN

export interface BuyboxObservation {
  zip: string;
  why: ShelfCall['why'];
  observedAt: string;
  data: ShelfBuybox;
}

export interface OffersObservation {
  zip: string;
  observedAt: string;
  data: ShelfOffers;
}

export interface AsinDiagnosis {
  asin: string;
  reason: LossReason;
  /** One sentence for the page and the chat. */
  detail: string;
  /** Per observed zip: who won and the gap to us. */
  zips: Array<{ zip: string; why: ShelfCall['why']; winner: string | null; winnerId: string | null; ours: boolean; price: number | null; promiseDays: number | null; observedAt: string }>;
  ourOffer: ShelfOffer | null;
  lowestOther: ShelfOffer | null;
  undercutters: ShelfOffer[];
  offerCount: number | null;
}

const money = (n: number | null | undefined): string => (typeof n === 'number' ? `$${n.toFixed(2)}` : 'n/a');

export function diagnose(summary: AsinSummary, buyboxes: BuyboxObservation[], offers: OffersObservation | null, ourSellerId: string): AsinDiagnosis {
  const zips = buyboxes.map((b) => ({
    zip: b.zip,
    why: b.why,
    winner: b.data.sold_by,
    winnerId: b.data.seller_id,
    ours: b.data.seller_id === ourSellerId,
    price: b.data.price,
    promiseDays: b.data.promise_days_fastest,
    observedAt: b.observedAt,
  }));
  const offerList = offers?.data.offers ?? [];
  const ourOffer = offerList.find((o) => o.seller_id === ourSellerId) ?? (offers?.data.product && offers.data.product.seller_id === ourSellerId ? offers.data.product : null);
  const others = offerList.filter((o) => o.seller_id !== ourSellerId && o.price_num !== null).sort((a, b) => (a.price_num ?? 0) - (b.price_num ?? 0));
  const lowestOther = others[0] ?? null;
  const ourPrice = ourOffer?.price_num ?? summary.ourPrice;
  const undercutters = ourPrice === null ? [] : others.filter((o) => (o.price_num ?? Infinity) < ourPrice);
  const base = { asin: summary.asin, zips, ourOffer, lowestOther, undercutters, offerCount: offers ? offers.data.offer_count : null };

  if (summary.status === 'held' && zips.every((z) => z.ours || z.winner === null)) {
    return { ...base, reason: 'held', detail: `Amazon and the shelf agree: we hold the featured offer (${Math.round(summary.ourShare * 100)}% of views).` };
  }
  const lostZips = zips.filter((z) => !z.ours);
  if (zips.length > 0 && lostZips.length === 0) {
    return { ...base, reason: 'lost_elsewhere', detail: `We win the Buy Box at every observed location, but Amazon reports ${Math.round((1 - summary.ourShare) * 100)}% of views going to ${summary.competitors[0]?.sellerId ?? 'another seller'}; the losing segments could not be observed (their sample zips are not observation points).` };
  }
  const noBox = lostZips.filter((z) => z.winner === null);
  if (lostZips.length > 0 && noBox.length === lostZips.length && (offers === null || offers.data.offer_count === 0)) {
    // No Buy Box anywhere we looked and nobody at all on the offer list: the listing is not buyable there (seen live 2026-10-21: an ASIN with 0 offers).
    return { ...base, reason: 'no_featured_offer', detail: `No featured offer and no offers at all at ${noBox.map((z) => z.zip).join(', ')}: the listing is not buyable there (out of stock everywhere, or suppressed).` };
  }
  if (offers && !ourOffer) {
    return { ...base, reason: 'not_on_listing', detail: `Our offer is not in the offer list at ${offers.zip} (${offers.data.offer_count} other offers): out of stock or not buyable there.` };
  }
  if (lostZips.length > 0 && noBox.length === lostZips.length) {
    return { ...base, reason: 'no_featured_offer', detail: `No featured offer is shown at ${noBox.map((z) => z.zip).join(', ')}: the Buy Box is suppressed for everyone there, usually a lower price off Amazon or a listing issue.` };
  }
  const won = lostZips.filter((z) => z.winner !== null);
  const cheaper = won.filter((z) => ourPrice !== null && z.price !== null && z.price < ourPrice);
  if (cheaper.length > 0) {
    const w = cheaper[0]!;
    return { ...base, reason: 'price_undercut', detail: `${w.winner} wins at ${w.zip} at ${money(w.price)} against our ${money(ourPrice)}${undercutters.length > 0 ? `; ${undercutters.length} offer(s) on the listing are below our price` : ''}.` };
  }
  if (won.length > 0) {
    const w = won[0]!;
    const ourDays = ourOffer?.promise_days_fastest ?? null;
    const gap = w.promiseDays !== null && ourDays !== null ? ` (${w.promiseDays} d vs our ${ourDays} d)` : w.promiseDays !== null ? ` (${w.promiseDays} d)` : '';
    return { ...base, reason: 'promise_loss', detail: `${w.winner} wins at ${w.zip} at ${money(w.price)} with a faster delivery promise${gap}; our price is ${money(ourPrice)}.` };
  }
  return { ...base, reason: 'unresolved', detail: summary.status === 'no_featured_offer' ? 'Amazon reports no featured offer for this ASIN and the shelf could not be observed.' : 'Amazon reports a loss; the shelf had no answer for this ASIN.' };
}

// ---------------------------------------------------------------------------
// 4. The report
// ---------------------------------------------------------------------------

export interface CheckReport {
  generatedAt: string;
  merchant: { legacySellerId: string | null; amazonSellerId: string; name: string | null; marketplace: string };
  summaryObservedAt: string | null;
  asins: Array<{ summary: AsinSummary; diagnosis: AsinDiagnosis | null }>;
  shelfAnswersSpent: number;
  skippedZips: Record<string, string[]>;
}

export function reportCounts(report: CheckReport): Record<string, number> {
  const counts: Record<string, number> = { total: report.asins.length, held: 0, flagged: 0, errors: 0 };
  for (const a of report.asins) {
    if (a.summary.status === 'error') counts.errors += 1;
    else if (a.summary.status === 'held') counts.held += 1;
    else counts.flagged += 1;
    const r = a.diagnosis?.reason;
    if (r) counts[r] = (counts[r] ?? 0) + 1;
  }
  return counts;
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const REASON_LABEL: Record<LossReason, string> = {
  held: 'held',
  promise_loss: 'lost on delivery promise',
  price_undercut: 'lost on price',
  no_featured_offer: 'no featured offer',
  not_on_listing: 'our offer missing',
  lost_elsewhere: 'lost in unobserved segments',
  unresolved: 'unresolved',
};
const STATUS_LABEL: Record<AsinStatus, string> = { held: 'held', partial: 'partially lost', lost: 'lost', no_featured_offer: 'no featured offer', error: 'error' };

export function renderReportMarkdown(report: CheckReport): string {
  const c = reportCounts(report);
  const L: string[] = [];
  L.push(`# Featured offer check: ${report.merchant.name ?? report.merchant.amazonSellerId} (${report.merchant.marketplace.toUpperCase()})`, '');
  L.push(`Generated ${report.generatedAt}. Amazon's answer${report.summaryObservedAt ? ` as of ${report.summaryObservedAt}` : ''}; shelf observations dated per row. ${c.total} ASINs: ${c.held} held, ${c.flagged} flagged, ${c.errors} errors. Shelf answers spent: ${report.shelfAnswersSpent}.`, '');
  L.push('| ASIN | Amazon says | our view share | top competitor | shelf says | detail |', '|---|---|---|---|---|---|');
  for (const a of report.asins) {
    const s = a.summary;
    const comp = s.competitors[0] ? `${s.competitors[0].sellerId} (${pct(s.totalWeight > 0 ? s.competitors[0].weight / s.totalWeight : 0)})` : '-';
    L.push(`| ${s.asin} | ${s.error ? `error: ${s.error}` : STATUS_LABEL[s.status]} | ${s.error ? '-' : pct(s.ourShare)} | ${comp} | ${a.diagnosis ? REASON_LABEL[a.diagnosis.reason] : s.status === 'held' ? 'not observed (held)' : '-'} | ${a.diagnosis?.detail ?? ''} |`);
  }
  for (const a of report.asins) {
    if (!a.diagnosis) continue;
    const s = a.summary;
    const d = a.diagnosis;
    L.push('', `## ${s.asin}: ${REASON_LABEL[d.reason]}`, '', d.detail, '');
    L.push('Amazon segments:', '', '| segment | views | featured seller | price | sample zip |', '|---|---|---|---|---|');
    for (const seg of s.segments) L.push(`| ${seg.membership} | ${pct(s.totalWeight > 0 ? seg.weight / s.totalWeight : 0)} | ${seg.sellerId === report.merchant.amazonSellerId ? 'us' : seg.sellerId ?? 'none'} | ${money(seg.price)} | ${seg.zip ?? '-'} |`);
    if (d.zips.length > 0) {
      L.push('', 'Shelf, Buy Box by location:', '', '| zip | why | winner | price | fastest promise | observed |', '|---|---|---|---|---|---|');
      for (const z of d.zips) L.push(`| ${z.zip} | ${z.why} | ${z.ours ? 'us' : z.winner ?? 'no featured offer'} | ${money(z.price)} | ${z.promiseDays ?? '-'} d | ${z.observedAt} |`);
    }
    if (d.offerCount !== null) {
      L.push('', `Offers (${d.offerCount}): ours ${d.ourOffer ? `${d.ourOffer.price ?? money(d.ourOffer.price_num)} (${d.ourOffer.promise_days_fastest ?? '-'} d)` : 'not on the listing'}; lowest other ${d.lowestOther ? `${d.lowestOther.price ?? money(d.lowestOther.price_num)} by ${d.lowestOther.sold_by} (${d.lowestOther.seller_id ?? '-'})` : 'none'}; ${d.undercutters.length} below our price.`);
    }
    const skipped = report.skippedZips[s.asin];
    if (skipped?.length) L.push('', `Sample zips not observable: ${skipped.join(', ')}.`);
  }
  return L.join('\n') + '\n';
}

export function renderReportHtml(report: CheckReport): string {
  const c = reportCounts(report);
  const rows = report.asins
    .map((a) => {
      const s = a.summary;
      const comp = s.competitors[0] ? `${esc(s.competitors[0].sellerId)} (${pct(s.totalWeight > 0 ? s.competitors[0].weight / s.totalWeight : 0)})` : '-';
      const reason = a.diagnosis ? REASON_LABEL[a.diagnosis.reason] : s.status === 'held' ? 'not observed (held)' : '-';
      const cls = a.diagnosis ? a.diagnosis.reason : s.status;
      return `<tr class="${esc(cls)}"><td><a href="#${esc(s.asin)}">${esc(s.asin)}</a></td><td>${esc(s.error ? `error: ${s.error}` : STATUS_LABEL[s.status])}</td><td class="num">${s.error ? '-' : pct(s.ourShare)}</td><td>${comp}</td><td>${esc(reason)}</td><td>${esc(a.diagnosis?.detail ?? '')}</td></tr>`;
    })
    .join('\n');
  const sections = report.asins
    .filter((a) => a.diagnosis)
    .map((a) => {
      const s = a.summary;
      const d = a.diagnosis!;
      const segs = s.segments.map((seg) => `<tr><td>${esc(seg.membership)}</td><td class="num">${pct(s.totalWeight > 0 ? seg.weight / s.totalWeight : 0)}</td><td>${seg.sellerId === report.merchant.amazonSellerId ? 'us' : esc(seg.sellerId ?? 'none')}</td><td class="num">${esc(money(seg.price))}</td><td>${esc(seg.zip ?? '-')}</td></tr>`).join('');
      const zips = d.zips.map((z) => `<tr class="${z.ours ? 'ours' : 'theirs'}"><td>${esc(z.zip)}</td><td>${esc(z.why)}</td><td>${z.ours ? 'us' : esc(z.winner ?? 'no featured offer')}</td><td class="num">${esc(money(z.price))}</td><td class="num">${z.promiseDays ?? '-'} d</td><td class="muted">${esc(z.observedAt)}</td></tr>`).join('');
      const offers = d.offerCount === null ? '' : `<p><strong>Offers (${d.offerCount}).</strong> Ours: ${d.ourOffer ? `${esc(d.ourOffer.price ?? money(d.ourOffer.price_num))} (${d.ourOffer.promise_days_fastest ?? '-'} d)` : 'not on the listing'}. Lowest other: ${d.lowestOther ? `${esc(d.lowestOther.price ?? money(d.lowestOther.price_num))} by ${esc(d.lowestOther.sold_by)} (${esc(d.lowestOther.seller_id ?? '-')})` : 'none'}. ${d.undercutters.length} below our price.</p>`;
      const skipped = report.skippedZips[s.asin];
      return `<section id="${esc(s.asin)}"><h2>${esc(s.asin)} <span class="tag ${esc(d.reason)}">${esc(REASON_LABEL[d.reason])}</span></h2><p>${esc(d.detail)}</p>
<h3>Amazon: featured offer by shopper segment</h3><div class="tbl"><table><tr><th>segment</th><th>views</th><th>featured seller</th><th>price</th><th>sample zip</th></tr>${segs}</table></div>
${d.zips.length ? `<h3>Shelf: the Buy Box by location</h3><div class="tbl"><table><tr><th>zip</th><th>why</th><th>winner</th><th>price</th><th>fastest promise</th><th>observed</th></tr>${zips}</table></div>` : ''}
${offers}${skipped?.length ? `<p class="muted">Sample zips not observable: ${esc(skipped.join(', '))}.</p>` : ''}</section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Featured offer check ${esc(report.merchant.name ?? report.merchant.amazonSellerId)}</title>
<style>
:root{--bg:#f6f8f7;--fg:#0f1b20;--muted:#5b6b6f;--line:#d3dcd7;--card:#fff;--accent:#15b95c;--warn:#b45309;--bad:#b91c1c}
body{margin:0;padding:24px max(16px,4vw);background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:28px 0 6px}h3{font-size:.95rem;margin:16px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.lead{color:var(--muted);margin:0 0 18px}.kpis{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 20px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}.kpi b{display:block;font-size:1.4rem}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--card)}th,td{text-align:left;vertical-align:top;padding:7px 10px;border-bottom:1px solid var(--line);font-size:.92rem}th{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:var(--muted)}
tr.held td:first-child{border-left:3px solid var(--accent)}tr.promise_loss td:first-child,tr.lost_elsewhere td:first-child{border-left:3px solid var(--warn)}tr.price_undercut td:first-child,tr.no_featured_offer td:first-child,tr.not_on_listing td:first-child{border-left:3px solid var(--bad)}
.tag{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:999px;background:#e9efec;color:var(--muted);vertical-align:middle}.tag.held{background:#dff5e8;color:#0b7a3b}.tag.promise_loss,.tag.lost_elsewhere{background:#fdebd3;color:var(--warn)}.tag.price_undercut,.tag.no_featured_offer,.tag.not_on_listing{background:#fde2e2;color:var(--bad)}
tr.ours td{background:#f2fbf6}section{max-width:1100px}footer{margin-top:28px;color:var(--muted);font-size:.85rem}
</style></head><body>
<h1>Featured offer check: ${esc(report.merchant.name ?? report.merchant.amazonSellerId)} <span class="muted">(${esc(report.merchant.marketplace.toUpperCase())})</span></h1>
<p class="lead">Generated ${esc(report.generatedAt)}. Amazon's answer${report.summaryObservedAt ? ` as of ${esc(report.summaryObservedAt)}` : ''}; each shelf observation carries its own date. Shelf answers spent: ${report.shelfAnswersSpent}.</p>
<div class="kpis"><div class="kpi"><b>${c.total}</b>ASINs checked</div><div class="kpi"><b>${c.held}</b>held</div><div class="kpi"><b>${c.flagged}</b>flagged</div><div class="kpi"><b>${c.price_undercut ?? 0}</b>lost on price</div><div class="kpi"><b>${c.promise_loss ?? 0}</b>lost on promise</div><div class="kpi"><b>${(c.no_featured_offer ?? 0) + (c.not_on_listing ?? 0)}</b>no offer / missing</div></div>
<div class="tbl"><table><tr><th>ASIN</th><th>Amazon says</th><th>our view share</th><th>top competitor</th><th>shelf says</th><th>detail</th></tr>${rows}</table></div>
${sections}
<footer>Amazon's featured-offer segments come from your account's Product Pricing data (the retail surface). The shelf rows are public observations through MixShift, never your Amazon credentials; every shelf answer counted one against your organization's monthly allowance.</footer>
</body></html>`;
}
