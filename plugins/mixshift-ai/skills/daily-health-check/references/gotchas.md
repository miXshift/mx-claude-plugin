# Health Check — Gotchas

Review this file before every run. Add new entries immediately after any correction. Newest entries at top.

---

## 2026-04-24 — VC: SQL-REFERENCE used wrong column names for vendor_sales_manufacturing_asin

**What happened:** example brand run failed with `Unknown column 'PurchaseDate' in 'field list'`. SQL-REFERENCE.md (Batch B VC) referenced `PurchaseDate` and `OrderedRevenue` — neither column exists.

**Why:** Skill was ported from upstream where the model had implicit context for the right columns. On a fresh model, the spec failed.

**The rule:** `vendor_sales_manufacturing_asin` actual columns are `DateTime` (date type) and `OrderedRevenueAmount` (decimal). NOT `PurchaseDate`/`OrderedRevenue`. Verified against live schema 2026-04-24.

---

## 2026-03-20 — VC: Ordered Revenue pacing left as `--`

**What happened:** Ran example brand health check. Ordered Revenue pacing cell populated with `--` instead of computed value.

**Why:** Computed last ops date and MTD figures but forgot to apply universal pacing formula.

**The rule:** `ordered_rev_pacing = ordered_rev_mtd + (ordered_rev_t7_avg × days_remaining)`. Never `--`. Always a number.

---

## 2026-03-20 — VC: Adj. ACOS row missing entirely

**What happened:** Ran example brand health check. No Adj. ACOS row in summary table.

**Why:** Computed raw ACOS and moved to narrative without running backfill adjustment math.

**The rule:** When `has_attribution_calibration=true` in brand context, Adj. ACOS must be computed for all 5 columns (T-1, T-7, T-30, MTD, Pacing). T-30 splits settled/open days. T-7 and T-1 fully open. Never skip this row for VC accounts with calibration.

---

## 2026-03-20 — VC: Reference TACOS pacing missing from Bottom Line

**What happened:** example brand Bottom Line had no TACOS reference line.

**Why:** TACOS deprioritized mentally and then omitted.

**The rule:** VC accounts still require TACOS reference line in Bottom Line, labeled explicitly as reference-only. Format: "Reference-only TACOS pacing to ~X% for the month."

---

## 2026-03-20 — report-append.py validator blocking on em-dash

**What happened:** Block file had em-dash characters. Validator rejected. Report not appended.

**Why:** Wrote em-dash in Bottom Line before checking.

**The rule:** Zero em-dashes in any output. Check before writing, not after.

---

## 2026-03-19 — report-append.py: block file date mismatch

**What happened:** Block written as YYYY-MM-DD with data date, but script called with run date. Mismatch caused file-not-found.

**The rule:** Block file date = run date (today). Data date = T-1. Keep distinct. `block_file = /tmp/skill-output/{run_date}-health-check-block.html`.

---

## 2026-03-18 — report-append.py: day-label class missing from block

**What happened:** Block did not include `class="day-label"` or `class="run-label"` on run header div. Validator rejected.

**The rule:** Run header div must include: `<div class="run-header day-label run-label">`.

---

## 2026-03-23 — VC: Quarterly projection when no quarterly target exists

**What happened:** HP Bottom Line included quarterly projection even though no target exists.

**Why:** RP has Q1 $70K target so quarterly sentence is correct for RP. HP does not.

**The rule:** Check brand context for quarterly target before writing Bottom Line pacing lines. If no quarterly target: monthly pacing only. No quarterly sentence. Gate is mechanical.

---

## 2026-03-23 — report-append.py: bottom-line class must be exact

**What happened:** Block used `class="bottom-line intervention-yes"`. Validator failed.

**Why:** Validator does literal string match on `class="bottom-line"`. Additional classes break the match.

**The rule:** Bottom-line div must use exactly `class="bottom-line"` and nothing else. Use child elements if you need additional styling.

---

## 2026-03-23 — Don't declare run complete before deploy executes



---




---

## Pattern to watch — example brand

- Always check: last ops date from `MAX(DateTime)` in `vendor_sales_manufacturing_asin` (column is `DateTime`, not `PurchaseDate`). Never assume T-2.
- Always confirm: `days_remaining = 31 - last_ops_date_day` (or month-specific end day). Not `31 - today`.
- SP capture rate: **80.93%** (Feb 2026 calibration). Expected improvement: **4.42 pts** T-1 to T-14.

---

## Pattern to watch — example brand SC

- TACOS is the managed metric, not just reference. Must appear in Bottom Line with month AND quarter projection.
- T-1 Total Sales = T-2 date in `business_reports_dpst_date`. Both sides of TACOS are T-2 lagged.
- Q1 target: $70K. Always compute quarter projection and call out gap explicitly.
- Historical bid changes: check Account Actions Log before claiming trend explanations
- Structural events: Price test contamination, temporary stockouts — check brand context

---

## Pattern to watch — All Accounts

- **T-7 active days:** Do NOT divide T-7 sum by 7 automatically. Count days with non-zero data. Lag accounts have only 5-6 active days in T-7 window.
- **Prior day trends:** Always use fresh DB query on settled date, not prior HTML capture
- **Day-of-week:** No assumptions without supporting data in brand context or T-30 history
- **Pacing:** Always project from last available data date, not run date
- **Structural events:** Cross-reference brand context before citing T-30 baseline as clean
- **TACOS windows:** Both spend and sales must end on same date (T-2 for SC accounts)
