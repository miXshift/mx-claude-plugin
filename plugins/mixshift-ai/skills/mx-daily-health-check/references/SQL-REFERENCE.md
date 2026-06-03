# SQL Reference — Daily Advertising Performance Health Check

All queries live in `shared/sql-library/`. This file references them by ID
and documents the parameter binding for each consumer call site. Run
`scripts/check-sql-drift.py` to verify schema integrity.

**Common parameters** (used across most batches):
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` (T-1 date) from runtime
- `:month_start` (first of current month) from runtime

---

## Batch A — campaignmetric: All Time Windows (Single Query)

Returns all spend/sales/orders for T-1, T-7, T-30, MTD, and TACOS windows in one round trip.

[SQL-LIBRARY: DHC-01]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime
- `:month_start` from runtime

---

## Batch B — business_reports_dpst_date: All Total Sales Windows (SC accounts only)

All Seller Central total sales figures in one query. Data uses T-2 ceiling (one-day lag).

[SQL-LIBRARY: DHC-02]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime
- `:month_start` from runtime

---

## Batch B (VC Alternative) — vendor_sales_manufacturing_asin: Ordered Revenue Windows

For Vendor Central accounts, use this instead of business_reports_dpst_date.

[SQL-LIBRARY: DHC-03]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime
- `:month_start` from runtime
- `:vc_lag` from `context.yaml::accounts[0].vc_lag_days` (typically 2)

Note: `:vc_lag` is typically 2 days; confirm from brand context or last available date check.

---

## Batch C — anomaly_detection_settings: CI Thresholds + Pre-Computed Pacing

[SQL-LIBRARY: DHC-04]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`

Returns rows for: Sales, Units, Spend, AdSale, ACOS, TACOS

- `UpperSensitivityLimit` / `LowerSensitivityLimit` = percentile cutoffs (e.g., 97.50 / 2.50)
- `Pacing` and `MTD` = pre-computed and validated. Use directly when available.
- `Sensitivity` value shown in report header (e.g., "95% Confidence Interval")

---

## Batch D — anomaly_detection_MV: T-30 Daily Actuals for CI Percentile Calculation

[SQL-LIBRARY: DHC-05]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

**CI computation (in application layer):**
```
For each metric (Spend, AdSale, ACOS, Sales, TACOS):
  Sort T-30 daily values ascending
  Upper CI = PERCENTILE(values, UpperSensitivityLimit / 100)
  Lower CI = PERCENTILE(values, LowerSensitivityLimit / 100)
  Use linear interpolation if no exact match
```

The `_Mean` columns use winsorized rolling mean — pre-computed; use for context only.

---

## Batch E — Campaign Type: T-1 + T-7 + T-30 Combined

[SQL-LIBRARY: DHC-06]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

Derived values: `spend_t7_avg = spend_t7_total / 7`, `acos_t7 = spend_t7_total / adsales_t7_total × 100`

---

## Batch F — Objective: T-1 + T-7 + T-30 Combined

Uses `campaignmetric JOIN campaign` (campaign-level, matches Report Center). NOT keywordtargetingmetric.

[SQL-LIBRARY: DHC-07]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

---

## Batch G — Item Group: T-1 + T-7 + T-30 Combined

Same source as Batch F: `campaignmetric JOIN campaign`.

[SQL-LIBRARY: DHC-08]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

---

## Batch E0 (Conditional) — Brand: T-1 + T-7 + T-30 Combined

Run only when brand context documents sub-brand segmentation.

[SQL-LIBRARY: DHC-09]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

---

## Data Lag Check

Run to compare campaign-level vs. keyword-level T-1 figures.

[SQL-LIBRARY: DHC-10]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime

If gap > 10%, flag in report: "Campaign-level spend ($X) vs. keyword-level ($Y) = Z% gap. Dimensional ACOS figures are directional; full attribution expected within 24–48h."

---

## Diagnostic Follow-Ups (Context-Triggered)

### Budget Cap Check
Run when spend is below lower CI.

[SQL-LIBRARY: DHC-11]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:yesterday` from runtime
- `:utilization_threshold` (default 0.90)

### Inventory Check
Run when an item group shows conversion drop with clicks present.

[SQL-LIBRARY: DHC-12]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:days_of_supply_threshold` (default 14)

### Price Test ASIN-Level Total Sales
Run when brand context documents an active price test.

[SQL-LIBRARY: LIB-PT-01]

Parameters:
- `:seller_id` from `context.yaml::accounts[0].seller_id`
- `:title_pattern` from `context.yaml::structural_events[].metadata.title_pattern` (e.g., `'%Spartan%'`)
- `:prior_start`, `:prior_end` from price-test event metadata
- `:test_start`, `:test_end` from price-test event metadata

Source: `business_reports_dpst_sku` (total ordered product sales = organic + ad combined). Do NOT use sessions or CVR.

---

## Data Architecture Reference

| Table | Purpose | Key Columns |
|-------|---------|------------|
| `campaignmetric` | Campaign-level daily metrics | CampaignID, CampaignType, Cost, Sales, Orders, DateTime, SellerID |
| `campaign` | Campaign metadata | ID, CampaignType, Objective, ItemGroup, Brand |
| `business_reports_dpst_date` | SC total sales (1-day lag) | SalesAmount, DateTime, SellerID |
| `vendor_sales_manufacturing_asin` | VC ordered revenue (2-day lag) | OrderedRevenueAmount, DateTime, SellerID |
| `anomaly_detection_MV` | Pre-computed T-30 daily actuals | Spend, AdSale, ACOS, Sales, TACOS, Date, SellerID |
| `anomaly_detection_settings` | CI thresholds | Metric, UpperSensitivityLimit, LowerSensitivityLimit, SellerID |
| `keywordtargetingmetric` | Keyword-level data (lag varies) | Cost, Sales, DateTime, SellerID |
| `mws_inventory_health` | Inventory metrics per ASIN | SellableQuantity, DaysOfSupply, Alert, SellerID |
| `business_reports_dpst_sku` | ASIN-level total sales (organic + ad) | Amount, UnitsOrdered, Title, ChildAsin, DateTime, SellerID |

---

## Key Notes

- All queries are parameterized via the canonical SQL library — never hardcode `:seller_id`, `:yesterday`, or `:month_start`
- SC accounts: `business_reports_dpst_date` ends at T-2 (1-day lag)
- VC accounts: `vendor_sales_manufacturing_asin` ends at T-2 (2-day lag typically)
- TACOS requires matched windows (both sides lagged to same date)
- Price test analysis: use `business_reports_dpst_sku` total sales, never ad sales alone
- No ASIN-level sessions or CVR — only use on zero-conversion-inclusive days
