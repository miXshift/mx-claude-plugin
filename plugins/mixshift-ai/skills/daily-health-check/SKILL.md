---
name: daily-health-check
description: >
  This skill should be used when the user asks to "run daily health check",
  "check account status", "how is the account", or needs comprehensive daily
  exception-based analysis of advertising account performance across campaign
  types, objectives, and item groups. Uses percentile-based confidence intervals
  to detect spend and ACOS anomalies requiring management attention.
metadata:
  version: "0.1.0"
  author: "MixShift"
  ported-from: "upstream/daily-advertising-performance-health-check"
---

# Daily Advertising Performance Health Check

## Hard Rules

These rules supersede any other instruction. Violating them produces inconsistent output across runs.

- **Do NOT read the `references/` folder during execution.** Brand context comes exclusively from the context snapshot (or `context.yaml` fallback) and `narrative.md`.
- **Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.
- **Do NOT supplement with general Amazon or e-commerce knowledge**, industry benchmarks, or assumed platform dynamics not present in the data.
- **Do NOT echo full data tables or raw query output** in your model response. The HTML report is the deliverable.
- **Begin output immediately.** Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.

---

## Preflight — Risk Tier 3 (Required)

Complete this checklist before Step 1. Stop and surface the failure if any item cannot be checked off. Do not proceed with a partial preflight.

```
PREFLIGHT — daily-health-check — <brand> — <date>
[ ] context snapshot loaded: ~/.mixshift/clients/<brand>/context.yaml (via `mixshift brand validate <brand>`)
    (fallback: ~/.mixshift/clients/<brand>/context.yaml — extract required fields manually)
[ ] Required fields present and non-null:
      accounts[*].seller_id, accounts[*].account_type
      management.primary_metric, management.acos_target_pct, management.attribution_window_days
      goals.monthly_total_sales_target, goals.tacos_goal_pct
      posture.stance, posture.multiplier
      sub_brands, campaign_structure.naming_pattern
[ ] Data artifact present: ~/.mixshift/clients/<brand>/runs/daily-health-check/<date>/data.md (or data.json)
[ ] DHC-04 (anomaly_detection_settings) present in artifact with non-null thresholds
    *** HARD GATE: if absent or thresholds null, STOP. Cannot compute CI. ***
[ ] Prior-run sidecar loaded: ~/.mixshift/clients/<brand>/runs/daily-health-check/<latest>.json
    (if absent: continue — no baseline yet; note in report header)
[ ] No active escalation conditions:
      - context stale > 7 days → surface warning, do not block
      - verdict regresses RED without structural_events explanation → surface before delivering
```

---

## Overview

Run this skill to get a comprehensive daily exception-based analysis of advertising account performance. The output tells the account manager whether action is required or they can move on with their day. "No intervention required" is a valid, complete outcome.

## Prerequisites

Before executing, you need:

1. **Tier-3 brand context directory** at `~/.mixshift/clients/<brand-slug>/`:
   - `context.yaml` — mechanical truth (SellerIDs, account_type, ACOS/TACOS targets, capture-rate calibration, structural events, posture, campaign_structure, sub-brands, goals)
   - `narrative.md` — interpretive prose (positioning, management history, per-skill guidance)
   - `corpora/` — ASIN lists if needed
   - Schema source of truth: the Zod schema in the harness. Validate with `mixshift brand validate <brand-slug>` before any skill run.
2. **Access to MySQL database** with advertising metrics tables (campaignmetric, business_reports_dpst_date for SC; vendor_sales_manufacturing_asin for VC; anomaly_detection_settings; anomaly_detection_MV)
3. **Account configuration** drawn from `context.yaml` — never hardcode

If `context.yaml` is missing or fails validation, run the account-cold-start skill first.

## Execution Steps

### Step 0: Bootstrap (Run in Parallel)

Read these sources simultaneously:
1. This SKILL.md (you are reading now)
2. **`~/.mixshift/clients/<brand-slug>/context.yaml (validated via `mixshift brand validate <brand-slug>`)`** — compact context snapshot pre-extracted by the pre-fetch script. Contains only the fields this skill consumes: `seller_id`, `account_type`, `primary_metric`, `acos_target_pct`, `attribution_window_days`, `capture_rate_calibration`, `goals`, `structural_events`, `posture.stance`, `posture.multiplier`, `sub_brands`, `campaign_structure.naming_pattern`, `delivery.report_url`, `delivery.archive_dir`. If absent, fall back to reading `~/.mixshift/clients/<brand-slug>/context.yaml` directly and extracting those fields.
3. **`~/.mixshift/clients/<brand-slug>/runs/daily-health-check/ (most recent <date>-<run-id>.json)`** — prior run sidecar (~65 lines). If present, use for drift context and prior verdict. If absent, skip — no baseline yet.
4. `~/.mixshift/clients/<brand-slug>/narrative.md` — for prose context only (interpretation rules, per-skill guidance). Do not extract numbers from this file.

**Fail closed:** if the context snapshot is absent AND `context.yaml` is absent or missing `account_type`/`acos_target_pct`, stop and direct user to cold-start. Do not infer from prose.

### Step 1: Verify Data Completeness

**Timing:** Do not run before 8:00 AM in the account's local timezone. For PST-based cron: 6:30 AM PST covers most US time zones.

**History tier check:** Before running CI-based anomaly detection, verify you have:
- **< 7 days of data:** Do not run. Insufficient baseline.
- **7–13 days:** Observational report only. Suppress anomaly claims. Add banner: "Provisional — fewer than 14 days of history."
- **14–29 days:** Provisional CI with footnote noting baseline length.
- **30+ days:** Standard mode (preferred).

**Null handling rules:** Distinguish three states:
- **Real zero:** Query returned 0 (e.g., spend ran but no sales). Render `$0` or `0 orders`.
- **Null/unavailable:** Data not yet settled. Render `--` with a data lag note.
- **Query failed:** Infrastructure error. Stop the run; do not render partial output.

### Step 2: Load Account Configuration

Determine the account type from brand context:
- **Seller Central (SC):** Use `business_reports_dpst_date` for Total Sales and TACOS windows. SC has a 1-day data lag.
- **Vendor Central (VC):** Use `vendor_sales_manufacturing_asin` for Ordered Revenue. VC has a 2-day data lag.

Do not mix sources or discover the path mid-run. If account type is missing, stop and update brand context first.

### Step 3: Load Pre-Fetched Data

**Do NOT read SQL library files. Do NOT execute queries.** All query results are pre-computed before this skill runs.

Read the data artifact — **prefer the `.md` file** (pre-formatted markdown tables, no parsing overhead):
```
~/.mixshift/clients/<brand-slug>/runs/daily-health-check/<run_date>/data.md
```
Fallback to `.data.json` only if the `.md` file is absent.

This file contains pre-executed results for all queries, keyed by query ID:
- `DHC-01` — Campaign-level metrics (T-1, T-7, T-30, MTD, TACOS window): `spend, adsales, orders, acos` across all time windows
- `DHC-02` — Total Sales / SC accounts (business_reports_dpst_date): `total_sales` for T-1, T-7, T-30, MTD windows
- `DHC-03` — Ordered Revenue / VC accounts (vendor_sales_manufacturing_asin): `ordered_revenue` for T-1, T-7, T-30, MTD windows
- `DHC-04` — Anomaly Detection Settings: `UpperSensitivityLimit, LowerSensitivityLimit` by SellerID
- `DHC-05` — T-30 Daily Actuals (anomaly_detection_MV): daily `spend, adsales, acos, total_sales, tacos` for CI computation
- `DHC-06` — Campaign Type Performance (T-1, T-7, T-30): `campaign_type, spend, adsales, acos`
- `DHC-07` — Objective Performance (T-1, T-7, T-30): `objective, spend, adsales, acos`
- `DHC-08` — Item Group Performance (T-1, T-7, T-30): `item_group, spend, adsales, acos`
- `DHC-09` — Brand Performance (conditional — present only when sub-brand segmentation is active): `brand_label, spend, adsales, acos`
- `DHC-10` — Data lag check (campaign-level vs. keyword-level spend comparison): `campaign_spend_t1, keyword_spend_t1`
- `DHC-11` — Keyword-level spend comparison supplemental data
- `DHC-12` — Additional anomaly detection context
- `LIB-PT-01` — Price test query (conditional — present only when `structural_events` includes an active price_test): `asin, total_sales, units` for tested vs. untested sub-lines

All queries share the join key: `(SellerID, date)` at account level; dimensional queries use `(SellerID, CampaignName/Objective/ItemGroup, date)` as appropriate.

**If the artifact is missing:** Run prefetch now — do not stop and ask the user:
```bash
mixshift prefetch --brand <brand-slug> --skill daily-health-check --date <YYYY-MM-DD>
```
Use brand-slug derived from the brand context path and today's date as run_date. Wait for completion, then read the artifact and continue.

**Critical:** If DHC-04 (Anomaly Detection Settings) is absent or thresholds are null, stop immediately. Log the error and do not proceed. You cannot compute CI without these thresholds.

### Step 3a: Join Pre-Fetched Query Results

Join pre-fetched query results on the shared key to produce one unified record per row. DHC-01 forms the base campaign-level record; DHC-04/DHC-05 provide CI thresholds and T-30 daily actuals; DHC-06/DHC-07/DHC-08/DHC-09 provide dimensional breakdowns. DHC-02 or DHC-03 (account type determines which) provides total sales for TACOS computation.

### Step 4: Compute Confidence Interval Bounds

From Batch D daily actuals:

1. Sort T-30 daily values for each metric (Spend, Ad Sales, ACOS, Sales, TACOS) in ascending order
2. Compute percentiles:
   - **Upper CI** = PERCENTILE(values, UpperSensitivityLimit / 100)  [e.g., 97.5th percentile]
   - **Lower CI** = PERCENTILE(values, LowerSensitivityLimit / 100)  [e.g., 2.5th percentile]
3. Use linear interpolation if no exact percentile match
4. Check for per-objective CI distributions in brand context (some accounts may have per-objective thresholds instead of account-level)

**Never hardcode CI thresholds.** Always read them dynamically from anomaly_detection_settings.

### Step 5: Compute All Metrics

**From Batch A (campaignmetric):**
- `spend_t1` = T-1 total spend
- `spend_t7_avg` = T-7 total spend / 7
- `spend_t30_avg` = T-30 total spend / 30
- `adsales_t1` = T-1 ad sales
- `acos_t1` = spend_t1 / adsales_t1 × 100
- `acos_t7` = spend_t7_total / adsales_t7_total × 100
- `acos_t30` = spend_t30_total / adsales_t30_total × 100
- `acos_mtd` = spend_mtd / adsales_mtd × 100

**From Batch B (Total Sales):**
- `total_sales_t1` = T-1 total sales (T-2 date for SC accounts; latest available for VC)
- `total_sales_t7_avg` = T-7 total sales / 7 (or active days, see pacing rule below)
- `total_sales_t30_avg` = T-30 total sales / 30
- `total_sales_mtd` = MTD total sales

**TACOS (matched windows, both lagged to same date):**
- `tacos_t1` = spend_t2 / total_sales_t1 × 100  [both sides are T-2 date for SC]
- `tacos_t7` = spend_t7_window / total_sales_t7_window × 100
- `tacos_t30` = spend_t30_window / total_sales_t30_window × 100
- `tacos_mtd` = spend_mtd_window / total_sales_mtd_window × 100

**Pacing projection (universal rule for SC and VC):**
- `days_remaining` = (month_end_day - last_available_data_date_day) — NOT (month_end_day - run_date_day)
- Always project from the last date with actual data, not today's run date
- SC typically ends at T-2; VC typically ends at T-2. Account for the lag explicitly.
- `pacing_total_sales` = total_sales_mtd + (total_sales_t7_avg × days_remaining)
- `pacing_ad_sales` = adsales_mtd + (adsales_t7_avg × days_remaining)
- `pacing_spend` = spend_mtd + (spend_t7_avg × days_remaining)
- `pacing_acos` = pacing_spend / pacing_ad_sales × 100

**T-7 Active Days Correction (for lag accounts):**
- VC accounts with 2-day lag typically have only 5-6 active days in a T-7 window (not 7)
- SC accounts with 1-day lag typically have 6 active days
- Do NOT divide T-7 sum by 7 automatically; count actual days with non-zero data
- `t7_avg = t7_total / active_days` (not `t7_total / 7`)
- Dividing by 7 on a lag account understates the daily rate by 14-28%

**VC-Specific: Adjusted ACOS (when attribution calibration exists in brand context):**
- When brand context documents an SP capture rate calibration, compute Adj. ACOS

**Selecting the capture rate (cold-start v2.3.1+):**
- **Preferred input** — `capture_rate_calibration.daily_settlement_curve.by_campaign_type.sponsoredProducts.settled_pct_at_1day` (decimal of 100). This is the per-campaign-type signal produced by cold-start v2.3.1; for example brand this is **82.7** (0.827 as a fraction). When present and non-null, use it as `capture_rate` instead of the legacy account-blended number.
- **Day-of-week refinement** — when the curve is present, look up `capture_rate_calibration.daily_settlement_curve.dow_offset_pts[<dow_of_t1_read>]` (e.g. `friday: 0.32` means Friday clicks settle 0.32 ACOS-pts slower than the weekly mean). Apply the offset additively to `improvement_pts_1_to_14` if you're computing the additive form (see below). Skip the DOW step if the offset map is absent or `stability_score == "low"` (the offsets aren't reliable enough to act on).
- **Fallback chain** — if the curve is absent or its SP row is null:
  1. Use legacy `capture_rate_calibration.capture_rate_pct / 100` (account-blended single number — example brand legacy: 80.93).
  2. If even that's absent, omit the Adj. ACOS row entirely with note "no calibration on file."
- **Surface the source** — render the table with a small footnote indicating which input was used (e.g. "calibration source: SP daily curve, settled 82.7% by Day 1, +Fri DOW offset"). AMs need to see whether a refined or blended number is in play.

**Computing Adj. ACOS:**
- **T-7 and T-1 windows:** fully open. Divide all ad sales by the selected `capture_rate`.
  - `adjusted_adsales_t1 = adsales_t1 / capture_rate`
  - `adj_acos_t1 = spend_t1 / adjusted_adsales_t1 × 100`
- **Equivalent additive form (preferred when the curve has `improvement_pts_1_to_14`):**
  - `effective_improvement_pts = improvement_pts_1_to_14 + dow_offset_pts[<dow>]` (DOW term defaults to 0 if curve absent or stability=low)
  - `adj_acos_t1 ≈ acos_t1 - effective_improvement_pts`
  - This form is more interpretable on the rendered table and matches the underlying math; either form is acceptable.
- **T-30 window:** split into settled (age >= 14 days) and open (age < 14 days)
  - Apply capture rate only to open-day ad sales
  - `adj_acos_t30 = spend_t30 / (settled_sales + open_sales / capture_rate) × 100`
- **MTD window:** similar split to T-30
- **Pacing:** forward days are fully open; apply capture rate
- Only compute Adj. ACOS if some calibration input exists; otherwise omit the row.

**Caveat on the per-CT curve:** the curve gives reliable numbers only for `sponsoredProducts` because SB and SD have insufficient 1-day attribution volume on most accounts. DHC operates at the account level; using the SP curve as the account-level capture_rate is a strict improvement for SP-dominant brands (example brand: SP is 91% of spend) but slightly under-corrects for the small SB/SD slice. For accounts with materially balanced SP/SB/SD mix, this is worth revisiting; for now, the SP curve is the canonical fresh-day input.

### Step 6: Detect Anomalies

**Spend CI Breach:**
- Flag if T-1 Spend > Upper CI (upper breach)
- Flag if T-1 Spend < Lower CI (lower breach)

**ACOS CI Breach:**
- Flag if T-1 ACOS > Upper CI

**TACOS vs. Target:**
- Flag if T-1 TACOS > TACOS goal
- Flag if T-1 TACOS within 3 percentage points of goal (approaching)

**Pacing vs. Target:**
- Compute `pacing_gap_pct` = (pacing_total_sales - monthly_target) / monthly_target × 100
- Flag if gap < -8% (more than 8% behind pace)

### Step 7: Structural Event Check

Before making any intervention call, cross-reference brand context for:
- Active stockouts (inflated TACOS due to sales suppression)
- Active price tests (ACOS distorted by test period)
- Active promotional windows (spend spike expected)
- Recent bid or budget changes (check Account Actions Log)
- Confirmed data anomalies within the T-30 window

If a structural event explains a breach, keep the status flag but label it explicitly in narrative. A promo-driven spend breach during Easter sale is YELLOW, not RED, and must be named as such.

### Step 8: Compute Summary Table

Build the core summary table with these columns:

| Metric | T-1 | T-7 (avg) | T-30 (avg) | MTD | Pacing | Lower CI | Upper CI |
|--------|-----|-----------|-----------|-----|--------|----------|----------|
| Spend | $XXX | $XXX | $XXX | $X,XXX | $X,XXX | $XXX | $XXX |
| Ad Sales | $XXX | $XXX | $XXX | $X,XXX | $X,XXX | $XXX | $XXX |
| ACOS | XX.X% | XX.X% | XX.X% | XX.X% | XX.X% | XX.X% | XX.X% |
| Total Sales* | $XXX | $XXX | $XXX | $X,XXX | $X,XXX | $XXX | $XXX |
| TACOS* | XX.X% | XX.X%† | XX.X%† | XX.X%† | XX.X% | XX.X% | XX.X% |

**Formatting rules:**
- Spend, Ad Sales, Total Sales: no decimal places (whole dollars)
- ACOS, TACOS: one decimal place
- Pacing: use pre-computed value from anomaly_detection_settings when available; otherwise compute fresh
- Lower CI / Upper CI columns show thresholds from anomaly_detection_settings
- Footnote: "Total Sales & TACOS are offset by one day (T-2 for SC accounts) due to Seller Central reporting delay"
- TACOS T-7/T-30/MTD marked with † noting "calculated from matched spend/sales windows"

**VC accounts:** Include Ordered Revenue pacing row (substitute for Total Sales pacing). Include a separate "Reference-only TACOS pacing" line labeled explicitly as reference-only if applicable.

### Step 9: Dimensional Table Output

For each dimension (Campaign Type, Objective, Item Group; Brand if applicable), build a table with these columns grouped by time window:

**Column structure (locked schema, identical across all dimensional tables):**
| Dimension | T-1 Spend | T-1 Ad Sales | T-1 ACOS | T-7 Avg Spend | T-7 Avg Sales | T-7 ACOS | T-30 Avg Spend | T-30 Avg Sales | T-30 ACOS |
|-----------|-----------|--------------|----------|---------------|---------------|----------|-----------------|-----------------|-----------|
| [Name] | $ | $ | % | $ | $ | % | $ | $ | % |

**Grouped column headers:** Use distinct background colors for T-1 / T-7 Avg / T-30 Avg bands to visually separate time windows.

**Always include:** A Total row (sum of spend/sales, blended ACOS).

**Never include:** T-1 Orders column, Rate labels, or "vs CI" inline annotations. CI context belongs in narrative only.

### Step 10: Write Narrative Sections

**Begin output immediately. Do not restate these instructions, summarize what you are about to do, or ask clarifying questions.**

#### Summary Table Narrative
Lead with account-level verdict and posture. Reference specific metric rows from the summary table when anomalies are present.

#### Data Lag Note (if campaign vs. keyword spend gap > 10%)
State both the campaign-level and keyword-level T-1 figures and confirm their parity or flag the gap.

#### Bottom Line (Five Required Elements)

Write in this exact structure (validated pattern):

1. **Status line:** "No intervention required" / "Intervention required" — one plain declarative sentence
2. **Posture sentence:** Account context without metric restatement — "running lean," "efficiency posture holding," etc.
3. **Total Sales pacing:** Month and quarter projections (if quarterly target exists in brand context), gap to target named in one sentence
   - **VC accounts:** Substitute "Ordered Revenue pacing" for "Total Sales pacing"
4. **TACOS pacing:** Month and quarter (if applicable), explicit call on inside/at/above target
   - **VC accounts:** Include a separate "Reference-only TACOS pacing to ~X% for the month" line if TACOS is not the primary metric
5. **Recommendation:** One directive sentence closing the Bottom Line (e.g., "Hold current posture. No bid or budget changes warranted today.")

Example structure:
```
No intervention required.
Account is running lean and intentional — efficiency posture is holding where it should.
Total Sales pacing to $26,400 for March, $71,200 for Q1, on track against the $72K target.
TACOS pacing to 32.1% for the month, 33.8% for the quarter, inside the 35% target.
Recommendation: Hold current posture. No bid or budget changes warranted today.
```

**VC accounts:** When no quarterly target exists in brand context, omit the quarterly projection sentence entirely. Monthly ACOS vs. target is sufficient.

#### Performance by Brand (Conditional)
Only include if brand context documents sub-brand segmentation. Use campaign-side brand labels for ad metrics. Follow the table with narrative connecting brand findings to account-level pacing or goal proximity.

#### Performance by Campaign Type
Table first, then narrative. Lead with plain-language verdict ("This type is clean" / "Weak performance here requires attention"). For chronic inefficiency (100%+ ACOS, zero conversions): surface an explicit recommendation ("Consider pause or restructure"), not just a description.

#### Performance by Objective
Same structure as Campaign Type. When per-objective CI distributions exist (stored in SQL-REFERENCE.md), use those thresholds instead of account-level CI.

#### Performance by Item Group
Same structure. When brand context documents a price test on any item group, add a sub-section within this table:

**Price Test Sub-Section:**
- Use same-day-count prior period comparison (e.g., 9 test days vs 9 prior days)
- Source: business_reports_dpst_sku (total ordered product sales, not ad sales alone)
- Segment by tested vs untested sub-line using ASIN-level ASP as classifier
- Present as compact table: sub-line rows, Total row, Sales/Units/Change columns
- Narrative: (1) overall line revenue direction, (2) unit velocity on tested sub-line, (3) mix shift between tested/untested, (4) hedge on interpretation if < 14 days
- Do NOT use sessions or CVR — ASIN-level sessions are only reported on conversion days, creating survivorship bias

#### Areas to Monitor
3–4 bullets, one sentence each. Recap of callouts made above; no new analysis. This is a decision queue, not an analysis section. Format: name the thing, state the watch condition or action.

### Step 11: Compose HTML Output

Build a single HTML page with:
1. Report header (account name, run date, data date, CI sensitivity from settings)
2. Summary table
3. Data lag note (if applicable)
4. Bottom Line
5. Performance by Brand (if applicable)
6. Performance by Campaign Type (with narrative)
7. Performance by Objective (with narrative)
8. Item Group Performance (with narrative; price test sub-section if applicable)
9. Areas to Monitor

Use consistent CSS styling with:
- System font stack
- Clear table styling with borders
- Grouped column headers with distinct background colors per time window
- No em dashes anywhere in output

### Step 12: Self-Review (Before Delivery)

Before delivering output:

- [ ] Every section follows the five-element Bottom Line structure (status, posture, sales pacing, TACOS pacing, recommendation)
- [ ] Summary table has all required columns (T-1, T-7, T-30, MTD, Pacing, Lower CI, Upper CI)
- [ ] All dimensional tables include Total row with blended ACOS
- [ ] No em dashes in any narrative
- [ ] T-7 Avg columns present in all dimensional tables
- [ ] Grouped column headers with distinct visual bands for T-1 / T-7 / T-30
- [ ] CI sensitivity level shown in header (never hardcoded)
- [ ] Causal statements verified against actual query data (no day-of-week assumptions, no attribution language)
- [ ] Structural events cross-referenced; if present, named in relevant sections
- [ ] VC accounts: Adj. ACOS row present with all five columns (T-1, T-7, T-30, MTD, Pacing)
- [ ] VC accounts: Ordered Revenue pacing computed (never `--`)
- [ ] VC accounts: Reference TACOS pacing line present in Bottom Line
- [ ] Prior run format anchored (section count, narrative length, column format, naming consistency)
- [ ] Prior day trend comparisons use fresh DB queries on settled dates, not prior run HTML captures
- [ ] Data lag check completed (campaign vs. keyword spend difference noted)

### Step 13: Deliver Output

Compose the report as **markdown** (default) or HTML (if the user explicitly requests HTML).

Save the report to the brand's local reports directory using the Write tool:
```
~/.mixshift/clients/<brand-slug>/reports/<YYYY-MM-DD>/health-check.md
```
(or `.html` if HTML was requested.) If `context.yaml::delivery.reports_local_dir` is set, save there instead — honor that override.

Drift comparison against the prior sidecar will be handled by `mixshift sidecar compare` (not yet implemented). For now, you can manually inspect prior sidecars under `~/.mixshift/clients/<brand-slug>/runs/daily-health-check/` to spot config / verdict drift before delivering.

### Step 14: Emit Run Sidecar (canonical, drift-detection input)

After delivery, write a structured JSON sidecar capturing this run's inputs and headline outputs. Sidecars live at `~/.mixshift/clients/<brand-slug>/runs/daily-health-check/<data-date>-<run-id>.json`. Schema source of truth: `plugins/mixshift-ai/shared/run-sidecar.schema.yaml`.

Compose the input JSON (write to a temp file, then invoke the harness). Pick DHC-02 for SC OR DHC-03 for VC in sql_calls — never both. DHC-09 (sub-brand) is conditional on `sub_brands` segmentation. LIB-PT-01 is conditional on an active price_test in `structural_events`:

```jsonc
// /tmp/dhc-sidecar-input.json
{
  "skill": "daily-health-check",
  "skill_version": "0.2.0",
  "brand_slug": "<brand-slug>",
  "run_kind": "per_account",
  "data_date": "YYYY-MM-DD",   // T-1 (yesterday)
  "verdict": "GREEN|YELLOW|RED|OBSERVATIONAL",
  "history_tier": "provisional|tier-14|tier-30",
  "context_snapshot": {
    "account_type": "SC|VC",
    "seller_id": 0,
    "primary_metric": "ACOS|TACOS",
    "acos_target_pct": 20,
    "attribution_window_days": 14,
    "tacos_goal_pct": 5,
    "posture_stance": "scale|efficiency|defend|clear_bleed",
    "posture_multiplier": 0
  },
  "headline_metrics": {
    "spend_t1": 0,
    "spend_t7_avg": 0,
    "spend_t30_avg": 0,
    "adsales_t1": 0,
    "acos_t1": 0,
    "acos_t30": 0,
    "tacos_t30": 0,
    "pacing_total_sales": 0,
    "pacing_acos": 0,
    "pacing_gap_pct": 0,
    "upper_ci_spend": 0,
    "lower_ci_spend": 0
  },
  "sql_calls": [
    {"id": "DHC-01", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD", "month_start": "YYYY-MM-01"}},
    // Pick ONE: DHC-02 (SC) or DHC-03 (VC) -- never both
    {"id": "DHC-02", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD"}},
    {"id": "DHC-04", "params": {"seller_id": 0}},
    {"id": "DHC-05", "params": {"seller_id": 0, "lookback_days": 30}},
    {"id": "DHC-06", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD"}},
    {"id": "DHC-07", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD"}},
    {"id": "DHC-08", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD"}},
    {"id": "DHC-10", "params": {"seller_id": 0, "yesterday": "YYYY-MM-DD"}},
    {"id": "DHC-11", "params": {"seller_id": 0}},
    {"id": "DHC-12", "params": {"seller_id": 0}}
    // Optional: DHC-09 when sub_brands segmentation is active
    // Optional: LIB-PT-01 when structural_events includes an active price_test
  ],
  "artifacts": {
    "report_html_path": "<path-to-rendered-output>"
  }
}
```

Then write it:

```bash
mixshift sidecar write --input-file /tmp/dhc-sidecar-input.json
```

**Verdict rule:** `GREEN` = no intervention required. `YELLOW` = approaching threshold or structural-event-explained anomaly. `RED` = intervention required. `OBSERVATIONAL` = history tier <14 days; no claims made.

`mixshift sidecar compare` will surface drift against the prior run once implemented; until then, sidecars accumulate read-only for retrospective inspection.

## Writing Rules

- **No em dashes** anywhere in output
- **MoM and YoY labels mandatory** on every delta in prose (e.g., "up 3% MoM", not just "up 3%")
- **One sentence per finding:** Combine number and judgment into one tight sentence
- **No hedging adverbs:** Cut "modestly," "somewhat," "currently," "largely"
- **TACOS direction:** Lower is better. Say "below target" or "ahead of goal" when numerically lower
- **Spend vs Volume:** Always "spend" not "volume"
- **Percentage points:** Always use "pts" (e.g., "3 pts above target")
- **No restatement:** Table handles numbers; narrative handles story and decision
- **Causal integrity:** Describe the data pattern; do not assert causes without supporting data

## Causal Integrity (Critical)

Never assert a causal explanation without data that directly supports it. This is IP integrity — MixShift's patent claims attribution via deterministic functional relationships, not probabilistic inference.

- ✅ Describe the data pattern: "ACOS rose 4pp vs T-30; spend was flat"
- ✅ Label hypotheses explicitly: "spend mix shifted toward Headline Search which carries higher ACOS — but campaign-level confirmation needed"
- ✅ State when causation is indeterminate: "cause not determinable from available data"
- ❌ Never assert without data: "Thursday volume pullback," "seasonal demand shift," "competitive pressure"

If you cannot point to specific query data supporting a causal claim, describe the pattern and stop.

## Key Constraints

- **Always read SellerID from brand context** — never hardcoded
- **Always read anomaly_detection_settings dynamically** — never hardcoded CI thresholds
- **SC vs VC branch is mandatory** — use correct data source for account type
- **T-7 active days correction required for lag accounts** — do not divide T-7 by 7
- **Pacing always projects from last available data date**, not run date
- **Price test analysis uses total sales** (organic + ad), not ad sales alone
- **No ASIN-level sessions or CVR** — these are not valid due to survivorship bias
- **Structural events checked before final verdict** — account context can downgrade severity

All SQL queries are pre-fetched before skill execution. Do not read the references/ folder during skill execution.

## Telemetry (required — see [SKILL-AUTHOR-GUIDE.md](../../../../docs/productization/SKILL-AUTHOR-GUIDE.md))

At the START of this skill, run:

```bash
mixshift telemetry emit skill.invoked --skill daily-health-check
# If natural-language trigger matched (NOT a /slash command), also run:
mixshift telemetry emit skill.trigger_phrase_matched --skill daily-health-check --trigger-phrase "<the user's exact phrase>"
```

At the END of this skill, run:

```bash
mixshift telemetry emit skill.completed --skill daily-health-check --outcome <ok|failed|deferred|skipped>
```

Outcomes: `ok` (skill ran cleanly), `failed` (CLI errored or prereq missing), `deferred` (paused waiting for user input that didn't come back), `skipped` (user opted out or prereq guard fired).
