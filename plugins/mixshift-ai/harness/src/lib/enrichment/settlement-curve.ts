/**
 * Settlement curve enricher — Phase 1.5 analysis #1.
 *
 * Ported from Todd's `enrich-context.py::reshape_settlement_curve`. Takes
 * CS-28 prefetch rows (per-account, per-campaign-type, per-DOW spend +
 * sales at 1-day / 7-day / 14-day attribution windows) and computes:
 *
 *   - by_campaign_type:  per-CT ACOS at 1d/7d/14d, improvement points,
 *                        settled% at 1d
 *   - dow_offset_pts:    per-DOW improvement_pts_1_to_14 deviation from
 *                        the global mean (positive = settles slower)
 *   - stability_score:   high/medium/low from std-dev across DOWs
 *
 * The output shape matches `SettlementCurve` in types.ts so it can be
 * patched into context.yaml::capture_rate_calibration.daily_settlement_curve
 * by delta-mode merge (Phase C.6).
 *
 * --------------------------------------------------------------------------
 * Numeric convention
 * --------------------------------------------------------------------------
 * Stores ACOS as a PERCENTAGE NUMBER (e.g. 28.5 means 28.5%), not the
 * normalized 0-1 form. This matches Todd's Python output + the shape of
 * downstream consumers. Different from the brand-config OCL which stores
 * 0.28 for 28% — context.yaml's calibration block stays in Todd's
 * percentage convention for backward compatibility.
 */

import type {
  CampaignType,
  SettlementCurve,
  StabilityScore,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One CS-28 prefetch row. Field names match the SQL query columns.
 *
 * Tolerant: each field is `unknown` so the caller can pass raw JSON without
 * pre-coercing. `safeFloat` converts to numbers; `safeString` to canonical
 * campaign_type. Unknown rows are dropped silently.
 */
export interface CS28Row {
  campaign_type?: unknown;
  /** MySQL DAYOFWEEK(): 1=Sunday, 2=Monday, ..., 7=Saturday. */
  dow?: unknown;
  spend?: unknown;
  sales_1day?: unknown;
  sales_7day?: unknown;
  sales_14day?: unknown;
}

/**
 * Compute the settlement curve from CS-28 rows. Returns null when the input
 * is empty (signals insufficient data — the artifact's partial_reasons[]
 * should note this).
 */
export function computeSettlementCurve(
  rows: CS28Row[],
): SettlementCurve | null {
  if (rows.length === 0) return null;

  // -- Aggregate per campaign_type ----------------------------------------
  const byCt = new Map<string, { spend: number; s1: number; s7: number; s14: number }>();
  for (const r of rows) {
    const ct = normalizeCampaignType(r.campaign_type);
    if (!ct) continue;
    const agg = byCt.get(ct) ?? { spend: 0, s1: 0, s7: 0, s14: 0 };
    agg.spend += safeFloat(r.spend);
    agg.s1 += safeFloat(r.sales_1day);
    agg.s7 += safeFloat(r.sales_7day);
    agg.s14 += safeFloat(r.sales_14day);
    byCt.set(ct, agg);
  }

  // -- Build by_campaign_type with insufficient_data fallback -------------
  // Always emit all three CT slots — downstream consumers expect them.
  const ctSlots: CampaignType[] = ['sponsoredProducts', 'sponsoredBrands', 'sponsoredDisplay'];
  const by_campaign_type = {} as SettlementCurve['by_campaign_type'];
  for (const ct of ctSlots) {
    const agg = byCt.get(ct);
    if (!agg || agg.spend === 0) {
      by_campaign_type[ct] = insufficientCell();
      continue;
    }
    const acos1 = agg.s1 > 0 ? (agg.spend / agg.s1) * 100 : null;
    const acos7 = agg.s7 > 0 ? (agg.spend / agg.s7) * 100 : null;
    const acos14 = agg.s14 > 0 ? (agg.spend / agg.s14) * 100 : null;
    const imp7 = acos1 !== null && acos7 !== null ? acos1 - acos7 : null;
    const imp14 = acos1 !== null && acos14 !== null ? acos1 - acos14 : null;
    const settled = agg.s14 > 0 ? (agg.s1 / agg.s14) * 100 : null;

    // If at least 14-day ACOS doesn't compute, mark insufficient — that's
    // the settlement reference. 1-day and 7-day alone aren't meaningful.
    if (acos14 === null) {
      by_campaign_type[ct] = insufficientCell();
      continue;
    }

    by_campaign_type[ct] = {
      acos_1day: round2(acos1),
      acos_7day: round2(acos7),
      acos_14day: round2(acos14),
      improvement_pts_1_to_7: round2(imp7),
      improvement_pts_1_to_14: round2(imp14),
      settled_pct_at_1day: round2(settled),
      status: 'computed',
    };
  }

  // -- DOW offsets --------------------------------------------------------
  // Aggregate by DOW across all campaign types, compute per-DOW 1→14
  // improvement, then deviate from the global mean.
  const byDow = new Map<number, { spend: number; s1: number; s14: number }>();
  for (const r of rows) {
    const dow = normalizeDow(r.dow);
    if (dow === null) continue;
    const agg = byDow.get(dow) ?? { spend: 0, s1: 0, s14: 0 };
    agg.spend += safeFloat(r.spend);
    agg.s1 += safeFloat(r.sales_1day);
    agg.s14 += safeFloat(r.sales_14day);
    byDow.set(dow, agg);
  }

  const dowImp = new Map<number, number>();
  for (const [dow, agg] of byDow.entries()) {
    if (agg.s1 > 0 && agg.s14 > 0) {
      const acos1 = (agg.spend / agg.s1) * 100;
      const acos14 = (agg.spend / agg.s14) * 100;
      dowImp.set(dow, acos1 - acos14);
    }
  }

  let globalMean = 0;
  if (dowImp.size > 0) {
    const vals = Array.from(dowImp.values());
    globalMean = vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  const dow_offset_pts: SettlementCurve['dow_offset_pts'] = {
    monday: 0,
    tuesday: 0,
    wednesday: 0,
    thursday: 0,
    friday: 0,
    saturday: 0,
    sunday: 0,
  };
  for (const [dow, imp] of dowImp.entries()) {
    const name = DOW_NAMES.get(dow);
    if (!name) continue;
    (dow_offset_pts as Record<string, number>)[name] = round2(imp - globalMean) ?? 0;
  }

  // -- Stability score ----------------------------------------------------
  let stability_score: StabilityScore;
  if (dowImp.size >= 5) {
    const vals = Array.from(dowImp.values());
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length;
    const stddev = Math.sqrt(variance);
    stability_score = stddev < 5 ? 'high' : stddev < 15 ? 'medium' : 'low';
  } else {
    stability_score = 'low';
  }

  return {
    by_campaign_type,
    dow_offset_pts,
    stability_score,
    last_calibrated: new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// MySQL DAYOFWEEK() returns 1=Sunday, 2=Monday, ..., 7=Saturday
const DOW_NAMES = new Map<number, string>([
  [1, 'sunday'],
  [2, 'monday'],
  [3, 'tuesday'],
  [4, 'wednesday'],
  [5, 'thursday'],
  [6, 'friday'],
  [7, 'saturday'],
]);

function normalizeCampaignType(v: unknown): CampaignType | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  // Accept exact match + a few common variant spellings
  if (s === 'sponsoredProducts' || s === 'SP' || s.toLowerCase() === 'sponsored products')
    return 'sponsoredProducts';
  if (s === 'sponsoredBrands' || s === 'SB' || s.toLowerCase() === 'sponsored brands')
    return 'sponsoredBrands';
  if (s === 'sponsoredDisplay' || s === 'SD' || s.toLowerCase() === 'sponsored display')
    return 'sponsoredDisplay';
  return null;
}

function normalizeDow(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 7) return null;
  return n;
}

function safeFloat(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number | null): number | null {
  if (n === null) return null;
  return Math.round(n * 100) / 100;
}

function insufficientCell() {
  return {
    acos_1day: null,
    acos_7day: null,
    acos_14day: null,
    improvement_pts_1_to_7: null,
    improvement_pts_1_to_14: null,
    settled_pct_at_1day: null,
    status: 'insufficient_data' as const,
  };
}
