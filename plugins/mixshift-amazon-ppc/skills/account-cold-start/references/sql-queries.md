# Account Cold Start — SQL Queries Reference

All queries live in `shared/sql-library/`. This file references them by ID
and documents the parameter binding for each call site. Run
`scripts/check-sql-drift.py` to verify schema integrity after edits.

**Common parameters:**
- `:seller_id` from `context.yaml::accounts[0].seller_id` (or per-account driver)
- `:seller_id_list` comma-separated INT list when running across multiple accounts in one call

## Query 1: Confirm account and type

[SQL-LIBRARY: CS-01]

Parameters:
- `:seller_id_list` from cold-start scope (one or more account IDs)

- SC = use `business_reports_dpst_date` for ops data
- VC = use `vendor_sales_manufacturing_asin` for ops data
- Never use `business_reports_dpst_date` for VC — returns zero rows

## Query 2: 12-month revenue baseline by month

**SC:**

[SQL-LIBRARY: CS-02]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

Note: Column names in `business_reports_dpst_date` are `DateTime`, `SalesAmount`, `UnitsOrdered`, `Sessions`.

**VC:**

[SQL-LIBRARY: CS-03]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 3: ACOS baseline by month (12 months)

[SQL-LIBRARY: CS-04]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 4: ACOS by campaign type (12 months)

[SQL-LIBRARY: CS-05]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 5: Attribution window factor + daily backfill calibration

**SC Sponsored Products:**

[SQL-LIBRARY: CS-06]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

**VC Sponsored Products:**

[SQL-LIBRARY: CS-07]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

**Daily calibration distribution (last ~90 settled days):**

[SQL-LIBRARY: CS-08]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 6: Sub-brand + item group structure

**VC:**

[SQL-LIBRARY: CS-09]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

**SC (derive from campaign names):**

[SQL-LIBRARY: CS-10]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 7: Sub-brand revenue split — T-90 and T-12 (VC only)

[SQL-LIBRARY: CS-11]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 8: Item group revenue concentration — most recent full month (VC)

[SQL-LIBRARY: CS-12]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 9: ASP promotional flag — monthly ASP by item group (VC)

[SQL-LIBRARY: CS-13]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 10: Brand vs. NonBrand spend split (trailing 6 months)

[SQL-LIBRARY: CS-14]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 11: Spend trend — T-30 vs T-90 daily average

[SQL-LIBRARY: CS-15]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 12: Inventory history check — structural stockout diagnostic (SC)

[SQL-LIBRARY: CS-16]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 13: Same-SKU vs Other-SKU cross-sell ratio (most recent full month)

[SQL-LIBRARY: CS-17]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 14: Ads % of Total Sales stability check (SC)

[SQL-LIBRARY: CS-18]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 15: Brand catalog — derive brand ASINs and brand names

**VC:**

[SQL-LIBRARY: CS-19]

Parameters:
- `:seller_id_list` from cold-start scope

**SC:**

[SQL-LIBRARY: CS-20]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

> NOTE: CS-20 references `Brand` and `Asin` columns on
> `business_reports_dpst_date`. The current schema dump does not list
> these columns on that table — they exist on
> `business_reports_dpst_sku`. Verify the source query before relying on
> CS-20 in production. Drift gate will flag once columns are populated in
> tables.yaml.

## Query 16: Enabled negatives inventory — by campaign / ad group

[SQL-LIBRARY: CS-21]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`
- `:limit` (default 1000)

## Query 17: Budget constraint + keyword/ASIN spend concentration

**Budget utilization (SC/VC):**

[SQL-LIBRARY: CS-22]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`
- `:limit` (default 50)

**Keyword spend concentration (T-30):**

[SQL-LIBRARY: CS-23]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`
- `:limit` (default 50)

## Query 18: Objective Config classification — campaign-level intent

[SQL-LIBRARY: CS-24]

Parameters:
- `:seller_id` from `context.yaml::accounts[].seller_id`

## Query 19: Label Completeness Check — ItemGroup (VC) + Campaign Objective (SC/VC)

**Pull blank ItemGroup ASINs (VC):**

[SQL-LIBRARY: CS-25]

Parameters:
- `:seller_id_list` from cold-start scope

**Check which have T-90 revenue (active):**

[SQL-LIBRARY: CS-26]

Parameters:
- `:seller_id_list` from cold-start scope
- `:asin_list` from CS-25 result rows (blank-ItemGroup ASINs)

**Campaign objective completeness (SC/VC):**

[SQL-LIBRARY: CS-27]

Parameters:
- `:seller_id_list` from cold-start scope
- `:spend_floor` (default 5)
- `:limit` (default 30)

---

All queries return results as YYYY-MM dates, percentages (2 decimal places), and currency amounts (2 decimal places). Timestamp conversion handles timezone variance — no additional adjustments needed.
