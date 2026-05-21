/**
 * Stockout window detector — Phase 1.5 analysis #2.
 *
 * Ported from Todd's `enrich-context.py::detect_stockout_windows`. Reads
 * CS-29 (mws_inventory_health historical snapshots, FBA-only, pre-filtered
 * to "in-trouble" rows) and CS-30 (daily account-level ad metrics), and
 * groups consecutive in-trouble days per ASIN into contiguous windows of
 * ≥ `min_days` days. Each window scores impacted ad-sales by summing the
 * daily ad_sales from CS-30 across the window's date range.
 *
 * **Key signal sources:**
 *   - sellable_zero       — SellableQuantity = 0 on that snapshot day
 *   - alert_active        — Alert column truthy
 *   - days_of_supply_low  — DaysOfSupply < 14 (and SellableQuantity > 0)
 *   - multi               — more than one signal fired across the window
 *
 * **Limitation:** ASIN-suppression-for-profitability events (Amazon de-ranks
 * an ASIN despite inventory) are NOT detectable from `mws_inventory_health`
 * — those still require AM input as `structural_events[]` per the cold-start
 * SKILL.md.
 */

import type { StockoutCandidate, StockoutSignalSource } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CS29Row {
  ASIN?: unknown;
  ItemName?: unknown;
  /** Snapshot date — string (YYYY-MM-DD) or Date. */
  snapshot_date?: unknown;
  SellableQuantity?: unknown;
  Alert?: unknown;
  DaysOfSupply?: unknown;
}

export interface CS30Row {
  /** ISO date YYYY-MM-DD. */
  metric_date?: unknown;
  ad_sales?: unknown;
}

export interface StockoutOptions {
  /** Minimum days in a window before it qualifies as a candidate. Default 3. */
  min_days?: number;
  /** Days of gap tolerated when stitching consecutive in-trouble rows.
   *  Default 2 — Amazon snapshots can skip a day; don't fragment windows. */
  gap_tolerance_days?: number;
}

/**
 * Detect stockout candidate windows from CS-29 + CS-30. Returns an array
 * sorted by impacted_revenue_usd descending. Empty array when no input.
 */
export function detectStockoutWindows(
  cs29Rows: CS29Row[],
  cs30Rows: CS30Row[],
  options: StockoutOptions = {},
): StockoutCandidate[] {
  const minDays = options.min_days ?? 3;
  const gapTolerance = options.gap_tolerance_days ?? 2;

  if (cs29Rows.length === 0) return [];

  // -- Group CS-29 by ASIN ------------------------------------------------
  const byAsin = new Map<string, CS29Row[]>();
  for (const r of cs29Rows) {
    const asin = typeof r.ASIN === 'string' ? r.ASIN : null;
    if (!asin) continue;
    if (!byAsin.has(asin)) byAsin.set(asin, []);
    byAsin.get(asin)!.push(r);
  }

  // -- Build ad-sales lookup from CS-30 (keyed by ISO date) ---------------
  const revByDate = new Map<string, number>();
  for (const r of cs30Rows) {
    const d = parseDate(r.metric_date);
    if (!d) continue;
    revByDate.set(d, (revByDate.get(d) ?? 0) + safeFloat(r.ad_sales));
  }

  // -- Stitch windows per ASIN --------------------------------------------
  const candidates: StockoutCandidate[] = [];
  for (const [asin, rawRows] of byAsin.entries()) {
    const rowsWithDate = rawRows
      .map((r) => ({ row: r, date: parseDate(r.snapshot_date) }))
      .filter((x): x is { row: CS29Row; date: string } => x.date !== null)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    if (rowsWithDate.length === 0) continue;

    // Walk through sorted rows, building contiguous windows. A new window
    // starts when the gap from the previous row exceeds gap_tolerance.
    const windows: Array<typeof rowsWithDate> = [];
    let current: typeof rowsWithDate = [rowsWithDate[0]!];
    for (let i = 1; i < rowsWithDate.length; i++) {
      const prev = current[current.length - 1]!;
      const cur = rowsWithDate[i]!;
      if (daysBetween(prev.date, cur.date) <= gapTolerance) {
        current.push(cur);
      } else {
        windows.push(current);
        current = [cur];
      }
    }
    windows.push(current);

    // -- Convert each qualifying window to a candidate --------------------
    for (const w of windows) {
      if (w.length < minDays) continue;

      let zeroDays = 0;
      let alertDays = 0;
      let dosLowDays = 0;
      for (const { row } of w) {
        const sellable = numOrNull(row.SellableQuantity);
        const alert = row.Alert !== null && row.Alert !== undefined && Boolean(row.Alert);
        const dos = numOrNull(row.DaysOfSupply);
        if (sellable === 0) zeroDays += 1;
        if (alert) alertDays += 1;
        if (dos !== null && dos < 14 && sellable !== null && sellable !== 0) dosLowDays += 1;
      }

      const sources: StockoutSignalSource[] = [];
      if (zeroDays > 0) sources.push('sellable_zero');
      if (alertDays > 0) sources.push('alert_active');
      if (dosLowDays > 0) sources.push('days_of_supply_low');
      const signal_source: StockoutSignalSource =
        sources.length > 1 ? 'multi' : sources[0] ?? 'sellable_zero';

      const started = w[0]!.date;
      const ended = w[w.length - 1]!.date;
      const days_in_window = daysBetween(started, ended) + 1;

      // Sum impacted ad-sales across the window date range
      let impacted = 0;
      let cursor = started;
      while (cursor <= ended) {
        impacted += revByDate.get(cursor) ?? 0;
        cursor = addOneDay(cursor);
      }

      const item_name =
        typeof w[0]!.row.ItemName === 'string' ? w[0]!.row.ItemName : '';

      candidates.push({
        asin,
        item_name,
        started,
        ended,
        days_in_window,
        days_at_zero: zeroDays,
        impacted_revenue_usd: Math.round(impacted * 100) / 100,
        signal_source,
      });
    }
  }

  candidates.sort((a, b) => b.impacted_revenue_usd - a.impacted_revenue_usd);
  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a date value into ISO format YYYY-MM-DD. Returns null on parse
 * failure. Accepts Date instances, ISO strings, and date-time strings
 * (which get truncated to the date portion).
 */
function parseDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const trimmed = v.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
    return trimmed;
  }
  return null;
}

function daysBetween(startISO: string, endISO: string): number {
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function addOneDay(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function safeFloat(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
