/**
 * Capture-rate calibration deriver — Phase 8 brain enrichment.
 *
 * NEW computer (no upstream Python ancestor). Reduces the attribution-window
 * comparison queries CS-06 (SC SP 1d-vs-7d, prior full month), CS-07 (VC SP
 * 1d-vs-14d, prior full month), and CS-08 (daily 1d-vs-7d distribution over
 * T-104..T-7) into the three SCALAR fields of context.yaml's
 * `capture_rate_calibration` block:
 *
 *   - capture_rate_pct               "1-day capture rate": the share of the
 *                                    settled (N-day) ad sales that has already
 *                                    accrued by the 1-day attribution mark.
 *                                    = sales_1day / sales_Nday * 100.
 *   - fresh_day_acos_improvement_pts "Fresh-day improvement heuristic": how
 *                                    many ACOS points the 1-day figure
 *                                    overstates vs the settled N-day figure.
 *                                    = acos_1day - acos_Nday (a positive number
 *                                    of percentage POINTS).
 *   - settlement_application_rule    "Operating read": a one-sentence
 *                                    interpretation rule generated from the
 *                                    numbers, so a downstream skill / the
 *                                    Brand Context page has the human gloss.
 *
 * Field meanings + the section layout come from the cold-start docs
 * (skills/mx-brand-context: SKILL.md "Attribution Backfill Calibration",
 * references/BRAND-CONTEXT-SCHEMA.md Section 2). The daily-curve sub-block
 * (`daily_settlement_curve`) is NOT produced here — that is
 * computeSettlementCurve (settlement-curve.ts) from CS-28; the brain assembler
 * nests the two together.
 *
 * --------------------------------------------------------------------------
 * Numeric convention
 * --------------------------------------------------------------------------
 * PERCENTAGE NUMBERS, e.g. 28.5 means 28.5% and 12.0 means 12.0 points — NOT
 * the normalized 0-1 form. This matches settlement-curve.ts (see its
 * "Numeric convention" header) and the captureRateCalibrationSchema scalars in
 * lib/context/schema.ts, so the brain value and an AM-edited context value are
 * directly comparable.
 *
 * --------------------------------------------------------------------------
 * Source-of-truth choices (documented; flagged in the S1 report)
 * --------------------------------------------------------------------------
 *   1. SC over VC. CS-06 (SC, 1d-vs-7d) is preferred over CS-07 (VC,
 *      1d-vs-14d) when both return a usable monthly row — MixShift's base is
 *      predominantly SC, and the two can't be averaged (different settled
 *      windows: 7-day vs 14-day). The chosen window is recorded in the
 *      `settlement_application_rule` text so the basis is never ambiguous.
 *   2. Monthly headline for capture_rate_pct. The "1-day capture rate"
 *      headline comes from the prior-full-month aggregate (CS-06/07), which is
 *      the figure the cold-start "Most recent checkpoint" block reports.
 *   3. fresh_day_acos_improvement_pts prefers the CS-08 MEDIAN. The daily
 *      distribution (CS-08, ~97 settled days) is a more robust central estimate
 *      of the fresh-day overstatement than a single month's aggregate, and the
 *      cold-start docs describe CS-08 as the daily-calibration source. The
 *      monthly improvement_pts (CS-06/07) is the fallback when CS-08 is empty.
 *      (capture_rate_pct stays monthly because CS-08 carries no sales columns —
 *      only daily ACOS — so a capture-rate ratio can't be computed from it.)
 *
 * Scope note: all three sources are Sponsored-Products-only by construction
 * (the CS-* SQL filters `CampaignType = 'sponsoredProducts'`), so the derived
 * calibration is the SP settlement read, matching the cold-start section.
 */

// ---------------------------------------------------------------------------
// Row shapes (field names match the CS-* query columns)
// ---------------------------------------------------------------------------

/** One CS-06 row: SC SP 1-day vs 7-day, prior full month (a single row). */
export interface CS06Row {
  spend?: unknown;
  sales_1day?: unknown;
  sales_7day?: unknown;
  acos_1day?: unknown;
  acos_7day?: unknown;
  improvement_pts?: unknown;
  /** Tolerant raw row: extra columns from the wire are allowed. */
  [key: string]: unknown;
}

/** One CS-07 row: VC SP 1-day vs 14-day, prior full month (a single row). */
export interface CS07Row {
  spend?: unknown;
  sales_1day?: unknown;
  sales_14day?: unknown;
  acos_1day?: unknown;
  acos_14day?: unknown;
  improvement_pts?: unknown;
  /** Tolerant raw row: extra columns from the wire are allowed. */
  [key: string]: unknown;
}

/** One CS-08 row: one settled day's 1-day vs 7-day SP ACOS. */
export interface CS08Row {
  /** DATE(DateTime) — string or Date; unused by the math, kept for parity. */
  d?: unknown;
  acos_1day?: unknown;
  acos_7day?: unknown;
  improvement_pts?: unknown;
  /** Tolerant raw row: extra columns from the wire are allowed. */
  [key: string]: unknown;
}

export interface CaptureRateInput {
  /** SC monthly comparison rows (CS-06). Zero or one meaningful row. */
  cs06?: CS06Row[] | null;
  /** VC monthly comparison rows (CS-07). Zero or one meaningful row. */
  cs07?: CS07Row[] | null;
  /** Daily distribution rows (CS-08). */
  cs08?: CS08Row[] | null;
}

/**
 * The derived scalar block. Mirrors the scalar fields of
 * captureRateCalibrationSchema (lib/context/schema.ts). `enabled` is true
 * whenever we computed anything; the daily curve is added by the assembler,
 * not here.
 */
export interface CaptureRateCalibration {
  enabled: boolean;
  /** 1-day capture rate, percentage number (e.g. 62.0). Null when the
   *  settled-window sales were zero / unavailable. */
  capture_rate_pct: number | null;
  /** Fresh-day ACOS overstatement, percentage POINTS (e.g. 12.5). Null when
   *  neither source produced an improvement figure. */
  fresh_day_acos_improvement_pts: number | null;
  /** One-sentence operating read generated from the numbers. */
  settlement_application_rule: string;
  /** Which channel/window the scalars came from: 'SC' (7-day) or
   *  'VC' (14-day). Null when neither monthly row was usable. */
  basis: 'SC' | 'VC' | null;
  /** N in "1-day vs N-day": 7 for SC, 14 for VC. Null when no basis. */
  settled_window_days: number | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the capture-rate calibration scalars from CS-06/07/08. Returns null
 * when NONE of the three sources carries usable signal (no monthly row and no
 * daily distribution) — the caller omits the section, mirroring how
 * computeSettlementCurve returns null on empty input.
 */
export function deriveCaptureRateCalibration(
  input: CaptureRateInput,
): CaptureRateCalibration | null {
  const sc = firstUsableMonthly(input.cs06, 'sales_7day');
  const vc = firstUsableMonthly(input.cs07, 'sales_14day');

  // Daily median improvement (CS-08) — robust central estimate.
  const dailyMedianImprovement = medianImprovement(input.cs08 ?? []);

  // Pick the monthly basis: SC preferred, then VC.
  let basis: 'SC' | 'VC' | null = null;
  let settledWindowDays: number | null = null;
  let captureRatePct: number | null = null;
  let monthlyImprovementPts: number | null = null;

  if (sc) {
    basis = 'SC';
    settledWindowDays = 7;
    captureRatePct = ratioPct(sc.sales_1day, sc.sales_7day);
    monthlyImprovementPts =
      sc.improvement_pts ?? subPts(sc.acos_1day, sc.acos_7day);
  } else if (vc) {
    basis = 'VC';
    settledWindowDays = 14;
    captureRatePct = ratioPct(vc.sales_1day, vc.sales_14day);
    monthlyImprovementPts =
      vc.improvement_pts ?? subPts(vc.acos_1day, vc.acos_14day);
  }

  // fresh_day_acos_improvement_pts: prefer the daily median; fall back to the
  // monthly aggregate's improvement.
  const freshDayImprovement = dailyMedianImprovement ?? monthlyImprovementPts;

  // Nothing usable at all → no section.
  if (
    basis === null &&
    freshDayImprovement === null &&
    captureRatePct === null
  ) {
    return null;
  }

  return {
    enabled: true,
    capture_rate_pct: round2(captureRatePct),
    fresh_day_acos_improvement_pts: round2(freshDayImprovement),
    settlement_application_rule: buildApplicationRule(
      basis,
      settledWindowDays,
      round2(captureRatePct),
      round2(freshDayImprovement),
    ),
    basis,
    settled_window_days: settledWindowDays,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The first row carrying a usable settled-window sales figure (> 0). The CS-06/
 * CS-07 queries return a single aggregate row, but a quiet account can return
 * one all-null row; this skips those.
 */
function firstUsableMonthly<R extends Record<string, unknown>>(
  rows: R[] | null | undefined,
  settledSalesKey: keyof R,
): {
  sales_1day: number | null;
  [k: string]: number | null;
} | null {
  for (const r of rows ?? []) {
    const settled = toNumber(r[settledSalesKey]);
    const oneDay = toNumber(r.sales_1day);
    const acos1 = toNumber((r as Record<string, unknown>).acos_1day);
    const imp = toNumber((r as Record<string, unknown>).improvement_pts);
    // Usable if we have either a settled-sales basis or any ACOS/improvement
    // signal to report.
    if (settled !== null || oneDay !== null || acos1 !== null || imp !== null) {
      return {
        sales_1day: oneDay,
        sales_7day: toNumber((r as Record<string, unknown>).sales_7day),
        sales_14day: toNumber((r as Record<string, unknown>).sales_14day),
        acos_1day: acos1,
        acos_7day: toNumber((r as Record<string, unknown>).acos_7day),
        acos_14day: toNumber((r as Record<string, unknown>).acos_14day),
        improvement_pts: imp,
      };
    }
  }
  return null;
}

/** Median of the CS-08 daily improvement_pts column. Computes it from
 *  acos_1day - acos_7day when improvement_pts is absent on a row. Null when no
 *  row yields a finite value. */
function medianImprovement(rows: CS08Row[]): number | null {
  const vals: number[] = [];
  for (const r of rows) {
    const imp = toNumber(r.improvement_pts) ?? subPts(r.acos_1day, r.acos_7day);
    if (imp !== null) vals.push(imp);
  }
  if (vals.length === 0) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 === 0 ? (vals[mid - 1]! + vals[mid]!) / 2 : vals[mid]!;
}

/** numerator / denominator * 100, as a percentage number. Null when the
 *  denominator is null/zero or the numerator is null. */
function ratioPct(numerator: unknown, denominator: unknown): number | null {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  if (n === null || d === null || d === 0) return null;
  return (n / d) * 100;
}

/** a - b in points; null when either is null. */
function subPts(a: unknown, b: unknown): number | null {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null || y === null) return null;
  return x - y;
}

/**
 * Generate the one-sentence "operating read". Deterministic so the brain hash
 * is stable across identical inputs. No em dashes (customer-facing string).
 */
function buildApplicationRule(
  basis: 'SC' | 'VC' | null,
  settledWindowDays: number | null,
  captureRatePct: number | null,
  freshDayImprovementPts: number | null,
): string {
  if (basis === null || settledWindowDays === null) {
    return 'Insufficient attribution-window data to derive a settlement rule.';
  }
  const window = `1-day vs ${settledWindowDays}-day`;
  const capturePart =
    captureRatePct !== null
      ? `roughly ${captureRatePct}% of settled ad sales land by the 1-day mark`
      : 'the 1-day capture rate could not be measured';
  const improvementPart =
    freshDayImprovementPts !== null
      ? `1-day ACOS overstates the settled figure by about ${freshDayImprovementPts} points, so subtract that when reading fresh-day ACOS`
      : 'no reliable fresh-day ACOS adjustment could be derived';
  return `On Sponsored Products (${basis}, ${window}): ${capturePart}; ${improvementPart}.`;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number | null): number | null {
  if (n === null) return null;
  return Math.round(n * 100) / 100;
}
