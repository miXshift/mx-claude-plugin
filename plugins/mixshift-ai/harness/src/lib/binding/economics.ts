/**
 * Per-label ECONOMICS and lifecycle for sub-brand promotion (mx-ops#6).
 *
 * The promotion plan used to rank candidates on `mws_items` ASIN count.
 * Counting items is not counting dollars: a label with many dormant ASINs
 * outranks one with few very large ones, so the plan could propose a brand
 * with almost no trailing revenue while omitting the account's largest.
 * This module consumes the gateway's SBD-05/06/07 economics entries and
 * turns them into (a) a ranking signal in dollars and (b) a lifecycle
 * read.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE
 *
 * 1. Lifecycle is derived from OBSERVABLE ACTIVITY, never from a custom
 *    label column. `ItemLabel1`/`Tag1..4` are free-text per-tenant fields;
 *    the value one account uses to mark a brand dead is that account's
 *    convention, not a product concept. Trailing revenue, recent revenue,
 *    recent spend and last-activity dates mean the same thing on every
 *    tenant and need no customer setup.
 *
 * 2. Dormant is a FLAG, never a filter. Nothing here removes a label from
 *    anything. A dormant label still appears, still carries its real
 *    numbers, and still counts toward account totals — so those totals
 *    keep reconciling against Seller/Vendor Central. What dormancy changes
 *    is CANDIDACY: a dormant label is not proposed for promotion by
 *    default, and says why. Suppressing it entirely is a decision the
 *    operator makes explicitly, never one this code makes silently.
 */

import { normalizeLabel } from './label.js';

// ---------------------------------------------------------------------------
// Wire rows (SBD-05 / SBD-06 / SBD-07)
//
// Same bigNumberStrings hazard as the SBD-01..04 rows: COUNT()- and
// SUM()-derived columns arrive as JS STRINGS, and DECIMAL money columns do
// too. Coerce once at the fetch boundary so nothing downstream has to think
// about it. See discovery.ts's coercion block for the full rationale.
// ---------------------------------------------------------------------------

export interface Sbd05RetailEconRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  revenue_365d: number | string;
  revenue_90d: number | string;
  units_365d: number | string;
  last_order_at: string | null;
  sku_count: number | string;
}

export interface Sbd06AdsEconRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  spend_365d: number | string;
  spend_90d: number | string;
  ad_sales_365d: number | string;
  last_spend_at: string | null;
  campaigns_with_spend: number | string;
}

export interface Sbd07VendorEconRowWire {
  SellerID: number | string;
  source: string;
  label: string;
  revenue_365d: number | string;
  revenue_90d: number | string;
  units_365d: number | string;
  last_order_at: string | null;
  asin_count: number | string;
}

export interface Sbd05RetailEconRow {
  SellerID: number | string;
  source: string;
  label: string;
  revenue_365d: number;
  revenue_90d: number;
  units_365d: number;
  last_order_at: string | null;
  sku_count: number;
}

export interface Sbd06AdsEconRow {
  SellerID: number | string;
  source: string;
  label: string;
  spend_365d: number;
  spend_90d: number;
  ad_sales_365d: number;
  last_spend_at: string | null;
  campaigns_with_spend: number;
}

export interface Sbd07VendorEconRow {
  SellerID: number | string;
  source: string;
  label: string;
  revenue_365d: number;
  revenue_90d: number;
  units_365d: number;
  last_order_at: string | null;
  asin_count: number;
}

/** Number(...) with a NaN guard — a malformed value degrades to 0 rather
 *  than poisoning every downstream sum. Mirrors discovery.ts's coerceCount;
 *  kept local so this module stands alone at the fetch boundary. */
function coerceAmount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** A wire timestamp -> a trimmed ISO-ish string, or null. Deliberately does
 *  NOT parse into a Date: the value is only ever compared against other
 *  wire timestamps and rendered, and parsing would introduce a timezone
 *  question the warehouse row does not answer. */
function coerceStamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

export function coerceRetailEconRow(row: Sbd05RetailEconRowWire): Sbd05RetailEconRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    revenue_365d: coerceAmount(row.revenue_365d),
    revenue_90d: coerceAmount(row.revenue_90d),
    units_365d: coerceAmount(row.units_365d),
    last_order_at: coerceStamp(row.last_order_at),
    sku_count: coerceAmount(row.sku_count),
  };
}

export function coerceAdsEconRow(row: Sbd06AdsEconRowWire): Sbd06AdsEconRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    spend_365d: coerceAmount(row.spend_365d),
    spend_90d: coerceAmount(row.spend_90d),
    ad_sales_365d: coerceAmount(row.ad_sales_365d),
    last_spend_at: coerceStamp(row.last_spend_at),
    campaigns_with_spend: coerceAmount(row.campaigns_with_spend),
  };
}

export function coerceVendorEconRow(row: Sbd07VendorEconRowWire): Sbd07VendorEconRow {
  return {
    SellerID: row.SellerID,
    source: row.source,
    label: row.label,
    revenue_365d: coerceAmount(row.revenue_365d),
    revenue_90d: coerceAmount(row.revenue_90d),
    units_365d: coerceAmount(row.units_365d),
    last_order_at: coerceStamp(row.last_order_at),
    asin_count: coerceAmount(row.asin_count),
  };
}

// ---------------------------------------------------------------------------
// Assembled per-label economics
// ---------------------------------------------------------------------------

export type Lifecycle = 'active' | 'dormant' | 'unknown';

export interface LabelEconomics {
  label: string;
  /** SC + VC ordered revenue, trailing 365 days. */
  revenue_365d: number;
  /** The trailing-90-day slice of the same. */
  revenue_90d: number;
  /** Ad spend, trailing 365 days. */
  spend_365d: number;
  /** The trailing-90-day slice of the same. */
  spend_90d: number;
  /** Latest of the retail/vendor last-order and ads last-spend stamps. */
  last_activity_at: string | null;
  /** What the label is worth, for ranking. Revenue plus ad spend: a brand
   *  can be small in catalog revenue and still consume a large share of the
   *  account's spend, and either alone under-ranks it. */
  economic_weight: number;
  lifecycle: Lifecycle;
  /** Human-readable justification for `lifecycle`, always populated. This
   *  is what a flagged candidate shows the operator, so it has to stand on
   *  its own without the reader knowing the thresholds. */
  lifecycle_reason: string;
  /** Whether ANY economics row was actually returned for this label.
   *
   *  False is NOT the same as zero. Zero means "we looked and it earned
   *  nothing"; false means "we never saw a row". Callers that hold a
   *  candidate back for being economically trivial must check this first,
   *  or they will tell an operator a brand is worth 0.00% of the account
   *  when the truth is that we have no data on it at all. */
  has_data: boolean;
  /** The retail/vendor label COLUMN this label was read from (e.g.
   *  `mws_items.ItemLabel1`), when SBD-05 or SBD-07 returned a row for it.
   *  Carried so an economics-only candidate — one the coverage queries
   *  never returned — can still be bound to a real label filter instead of
   *  silently scoping to the whole account. */
  retail_source: string | null;
  /** The ads label column (SBD-06), same purpose. */
  ads_source: string | null;
}

/** A label with trailing activity but none in the recent window reads as
 *  wound down. Fraction of trailing-365d value that must appear in the
 *  trailing 90 days for the label to count as still running.
 *
 *  Calibration note: a perfectly flat year puts ~24.7% of its value in any
 *  90-day window. 2% is deliberately far below that — this is meant to
 *  catch "effectively stopped", not "declining", and a seasonal brand in
 *  its off-quarter must not be called dormant. */
export const RECENT_ACTIVITY_SHARE = 0.02;

/** Below this much trailing value, a label is too small for the recent-share
 *  test to say anything: a handful of dollars either way flips the ratio.
 *  Such labels are reported `unknown` rather than guessed at in either
 *  direction — being wrong toward "active" proposes a dead brand, being
 *  wrong toward "dormant" hides a real one, and neither is acceptable on no
 *  evidence. */
export const MIN_WEIGHT_FOR_LIFECYCLE = 1_000;

function latestStamp(...stamps: Array<string | null>): string | null {
  let best: string | null = null;
  for (const s of stamps) {
    if (!s) continue;
    if (best === null || s > best) best = s;
  }
  return best;
}

/**
 * Classify one label's lifecycle from its own numbers alone.
 *
 * Deliberately conservative. The cost of a false "dormant" is hiding a real
 * brand from an operator who was looking for it; the cost of a false
 * "active" is proposing a dead one, which the flag exists to prevent. So
 * anything that cannot be judged on the evidence returns `unknown`, which
 * is treated as promotable-but-unverified rather than as either answer.
 */
export function classifyLifecycle(
  revenue365: number,
  revenue90: number,
  spend365: number,
  spend90: number,
): { lifecycle: Lifecycle; reason: string } {
  const weight365 = revenue365 + spend365;
  const weight90 = revenue90 + spend90;

  if (weight365 <= 0) {
    return {
      lifecycle: 'unknown',
      reason: 'no trailing revenue or ad spend found in the last 365 days',
    };
  }
  if (weight365 < MIN_WEIGHT_FOR_LIFECYCLE) {
    return {
      lifecycle: 'unknown',
      reason:
        `only ${fmtMoney(weight365)} of trailing activity in the last 365 days — ` +
        'too little to tell a live brand from a wound-down one',
    };
  }
  if (weight90 <= 0) {
    return {
      lifecycle: 'dormant',
      reason:
        `${fmtMoney(weight365)} of activity in the last 365 days but ` +
        'nothing at all in the last 90',
    };
  }
  const share = weight90 / weight365;
  if (share < RECENT_ACTIVITY_SHARE) {
    return {
      lifecycle: 'dormant',
      reason:
        `only ${fmtMoney(weight90)} of activity in the last 90 days against ` +
        `${fmtMoney(weight365)} across the year (${(share * 100).toFixed(1)}%)`,
    };
  }
  return {
    lifecycle: 'active',
    reason: `${fmtMoney(weight90)} of activity in the last 90 days`,
  };
}

/** Whole dollars with thousands separators. No currency symbol: a
 *  multi-marketplace account's rows are in local currency and this module
 *  does not convert, so asserting "$" could be wrong. */
export function fmtMoney(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export interface EconomicsInput {
  retailEconRows: readonly Sbd05RetailEconRow[];
  adsEconRows: readonly Sbd06AdsEconRow[];
  vendorEconRows: readonly Sbd07VendorEconRow[];
}

/**
 * Fold the three economics sides into one map keyed by label.
 *
 * Labels are matched by their NORMALIZED value, the same way every coverage
 * side keys (see ./label.ts). Keying the raw wire string here while
 * discovery keyed the normalized one meant a label carrying stray
 * whitespace on one side produced two map entries that never joined, and
 * the candidate silently lost its economics.
 *
 * A label present on only one side still gets an entry — a brand can carry
 * ad spend with no catalog revenue, or vice versa, and both are real states
 * worth showing.
 *
 * The label COLUMN each side reported is carried through, so a candidate
 * that only economics saw can still be bound to a real filter.
 */
export function assembleEconomics(input: EconomicsInput): Map<string, LabelEconomics> {
  const acc = new Map<
    string,
    {
      revenue365: number;
      revenue90: number;
      spend365: number;
      spend90: number;
      stamps: Array<string | null>;
      retailSource: string | null;
      adsSource: string | null;
    }
  >();

  const bucket = (rawLabel: string) => {
    const label = normalizeLabel(rawLabel);
    let e = acc.get(label);
    if (!e) {
      e = {
        revenue365: 0,
        revenue90: 0,
        spend365: 0,
        spend90: 0,
        stamps: [],
        retailSource: null,
        adsSource: null,
      };
      acc.set(label, e);
    }
    return e;
  };

  // First non-empty source wins. SC and VC both feed retailSource; they read
  // the same custom-label column on their respective catalogs, and a label
  // present on both sides reports the same column name from each.
  const keepSource = (current: string | null, incoming: string): string | null =>
    current ?? (incoming.trim().length > 0 ? incoming : null);

  // SC and VC revenue add together: one label can legitimately sell on both
  // sides of the business, and the account's real revenue for it is the sum.
  for (const r of input.retailEconRows) {
    const e = bucket(r.label);
    e.revenue365 += r.revenue_365d;
    e.revenue90 += r.revenue_90d;
    e.stamps.push(r.last_order_at);
    e.retailSource = keepSource(e.retailSource, r.source);
  }
  for (const r of input.vendorEconRows) {
    const e = bucket(r.label);
    e.revenue365 += r.revenue_365d;
    e.revenue90 += r.revenue_90d;
    e.stamps.push(r.last_order_at);
    e.retailSource = keepSource(e.retailSource, r.source);
  }
  for (const r of input.adsEconRows) {
    const e = bucket(r.label);
    e.spend365 += r.spend_365d;
    e.spend90 += r.spend_90d;
    e.stamps.push(r.last_spend_at);
    e.adsSource = keepSource(e.adsSource, r.source);
  }

  const out = new Map<string, LabelEconomics>();
  for (const [label, e] of acc) {
    const { lifecycle, reason } = classifyLifecycle(e.revenue365, e.revenue90, e.spend365, e.spend90);
    out.set(label, {
      label,
      revenue_365d: e.revenue365,
      revenue_90d: e.revenue90,
      spend_365d: e.spend365,
      spend_90d: e.spend90,
      last_activity_at: latestStamp(...e.stamps),
      economic_weight: e.revenue365 + e.spend365,
      lifecycle,
      lifecycle_reason: reason,
      // A row came back for this label, so its numbers are measured — even
      // when every one of them is zero.
      has_data: true,
      retail_source: e.retailSource,
      ads_source: e.adsSource,
    });
  }
  return out;
}

/** The economics of a label we have no economics row for. Distinct from a
 *  zeroed row: `unknown` lifecycle, so an absent economics side degrades to
 *  "cannot tell" rather than to "dormant". Silently treating missing data
 *  as dead would hide real brands. */
export function unknownEconomics(label: string): LabelEconomics {
  return {
    label,
    revenue_365d: 0,
    revenue_90d: 0,
    spend_365d: 0,
    spend_90d: 0,
    last_activity_at: null,
    economic_weight: 0,
    lifecycle: 'unknown',
    lifecycle_reason: 'no economics data returned for this label',
    // The zeros above are PLACEHOLDERS, not measurements. Anything that
    // reads them as "this brand earned nothing" is wrong; check this flag
    // before drawing any conclusion from the numbers.
    has_data: false,
    retail_source: null,
    ads_source: null,
  };
}
