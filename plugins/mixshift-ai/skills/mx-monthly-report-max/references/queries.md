# Warehouse queries: the brief's figure battery

Everything here is read-only through `mixshift data query --sql "..." --json`, which is already
scoped to the signed-in account's warehouse.

**Where these queries sit in the pipeline.** The Intelligence envelope serves the core MoM/YoY
figures and their evidence; this battery serves what the envelope does not: the daily series,
dark days, the settled-window check, out-of-stock days, page-view-weighted Buy Box with the
last-7-days column, availability breadth, and the mover reconciliation. Where both sources
serve the same figure, the envelope wins and the battery's total is the cross-check; a gap
beyond about half a percent is a finding (usually restatement), not a choice.

**Executable form.** The battery itself runs inside the MixShift service, called by
`mixshift report battery` (SKILL.md step 3b) as the brand battery `MPRX-FIGURES-BRAND-01`,
which routes each account row to the Seller Central battery `MPRX-FIGURES-01` or the Vendor
Central battery `MPRX-FIGURES-VC-01` from the seller row's channel, aligns the accounts to one
day count and rolls a brand up (section 11). This file is the annotated, human-readable source
of record for what those batteries do and why each query is shaped the way it is. Run the
queries below by hand only when you go beyond the battery: a cadence other than monthly, a
probe it does not carry, or a section the service reported under `sections_failed`.

## Contents

- [Which tables](#which-tables)
- [Account type fork](#account-type-fork)
- [Window resolution](#window-resolution)
- [1. Account ad metrics](#1-account-ad-metrics)
- [2. Account retail metrics](#2-account-retail-metrics)
- [3. Dark ad days](#3-dark-ad-days)
- [4. Settled-window efficiency check](#4-settled-window-efficiency-check)
- [5. Daily trend and exit rate](#5-daily-trend-and-exit-rate)
- [6. Sub-brand split](#6-sub-brand-split)
- [7. ASIN movers](#7-asin-movers)
- [8. Out-of-stock days](#8-out-of-stock-days)
- [9. Buy Box by ASIN, page-view weighted](#9-buy-box-by-asin-page-view-weighted)
- [9b. Availability breadth](#9b-availability-breadth)
- [9c. Daily series for one item](#9c-daily-series-for-one-item)
- [9d. Live featured offer state](#9d-live-featured-offer-state)
- [10. Full-month history](#10-full-month-history)
- [11. Vendor Central battery and the brand roll-up](#11-vendor-central-battery-and-the-brand-roll-up)
- [Known traps](#known-traps)

## Which tables

| Need | Table |
|---|---|
| Ad spend, ad sales, orders, clicks, impressions | `campaignmetric` |
| Campaign metadata: Brand, ItemGroup, Tags, Objective | `campaign` |
| Retail sales, sessions, Buy Box, offer count, account level | `business_reports_dpst_date` (SC) |
| Retail sales and sessions per ASIN | `business_reports_dpst_sku` (SC) |
| Retail revenue and units per ASIN | `vendor_sales_manufacturing_asin` (VC) |
| Glance views, the VC traffic proxy | `vendor_traffic_asin_daily` (VC) |
| Inventory snapshot, procurable out-of-stock rate, net received | `vendor_inventory_manufacturing_asin_daily` (VC) |
| Inventory snapshots, fulfillable and inbound | `mws_inventory_history` (SC) |
| Catalog: nickname, brand, item group, tier labels | `mws_items` (SC), `vendor_items` (VC) |

Date column is `DateTime` on all of these. It is **not** `date`, which is the first error
everyone makes.

## Account type fork

Check `MerchantType` or the brand list's `account_type` first, because the whole data path
differs and mixing them produces figures that cannot be reconciled.

- **SC (Seller Central).** Ad metrics from `campaignmetric` with the attribution CASE block
  below. Retail from `business_reports_dpst_date` and `_sku`. Buy Box, offer count, sessions and
  inventory all exist.
- **VC (Vendor Central).** Ad metrics from `campaignmetric`, exactly as on Seller Central
  (house rule, 2026-09-06: campaignmetric always; `sellermonthmetric` is never read, on any
  channel). Use the 14-day columns for every campaign type: on a vendor row the 7-day
  columns are empty for Sponsored Brands and Display, so the SC CASE would drop their sales.
  Retail from `vendor_sales_manufacturing_asin` (the manufacturing view, not sourcing), on
  the ORDERED basis unless the client's convention says shipped; never mix bases in one
  comparison. There is no Buy Box and no session count; glance views from
  `vendor_traffic_asin_daily` are the traffic basis, named as such. Out of stock is a RATE
  (`ProcurableProductOutOfStockRate`, 0 to 1) in `vendor_inventory_manufacturing_asin_daily`;
  an ASIN-day at or above the threshold while `SellableOnHandInventoryUnits > 0` is an
  availability interruption, not a stockout. Field-proven trap: resolve VC windows from the
  EARLIEST of the vendor sales, vendor traffic and ads load dates, never from the ads table
  alone (vendor retail loads later, and a one-day misalignment flipped a real month's MoM
  sign from -0.5% to the true +4.6%).

**Attribution windows.** SC: Sponsored Products 7 day, Sponsored Brands 14 day, Sponsored
Display 14 day. VC: 14 day for every type (the battery's `attribution: all_14` default; the
brand's `management.attribution_window_days` records the convention). The SC rule as SQL,
which is the canonical form:

```sql
SUM(CASE WHEN CampaignType='sponsoredProducts'
         THEN AttributedSales7day ELSE AttributedSales14day END) AS ad_sales,
SUM(CASE WHEN CampaignType='sponsoredProducts'
         THEN AttributedConversions7day ELSE AttributedConversions14day END) AS orders
```

`CampaignType` values are `sponsoredProducts`, `headlineSearch` (this is Sponsored Brands),
`sponsoredDisplay`, `sponsoredTelevision`.

## Window resolution

Run this first. It decides every window in the brief.

```sql
SELECT 'retail' src, MAX(DateTime) mx FROM business_reports_dpst_date WHERE SellerID=<ID>
UNION ALL
SELECT 'ads' src, MAX(DateTime) mx FROM campaignmetric WHERE SellerID=<ID>
```

Take the earlier of the two as the current window's end date. Let `D` be its day-of-month. The
three windows are then:

- Current: month start to day `D` of the current month
- Prior month: prior month start to day `D` of the prior month
- Prior year: same month last year, start to day `D`

If `D` lands past the prior month's length (day 31 against a 30 day month), use the prior
month's last day and say the windows differ by a day.

## 1. Account ad metrics

```sql
SELECT
  CASE
    WHEN DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN 'A_current'
    WHEN DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN 'B_prior_month'
    WHEN DateTime BETWEEN '<ly_start>'  AND '<ly_end>'  THEN 'C_prior_year'
  END AS period,
  ROUND(SUM(Cost),2) AS ad_spend,
  ROUND(SUM(CASE WHEN CampaignType='sponsoredProducts'
                 THEN AttributedSales7day ELSE AttributedSales14day END),2) AS ad_sales,
  SUM(CASE WHEN CampaignType='sponsoredProducts'
           THEN AttributedConversions7day ELSE AttributedConversions14day END) AS orders,
  SUM(Clicks) AS clicks, SUM(Impressions) AS impressions
FROM campaignmetric
WHERE SellerID=<ID>
  AND (DateTime BETWEEN '<cur_start>' AND '<cur_end>'
    OR DateTime BETWEEN '<pri_start>' AND '<pri_end>'
    OR DateTime BETWEEN '<ly_start>'  AND '<ly_end>')
GROUP BY period ORDER BY period
```

Write the CASE branches as mutually exclusive ranges. Overlapping ranges make the first branch
win silently and the later bucket then holds only the remainder, which looks like a real number
and is not one.

## 2. Account retail metrics

```sql
SELECT
  CASE WHEN DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN 'A_current'
       WHEN DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN 'B_prior_month'
       ELSE 'C_prior_year' END AS period,
  MAX(DateTime) AS last_day,
  ROUND(SUM(SalesAmount),2) AS ops,
  SUM(UnitsOrdered) AS units,
  SUM(Sessions) AS sessions,
  ROUND(100*AVG(BuyBoxPercentage),1) AS buybox_pct,
  ROUND(AVG(AverageOfferCount),1) AS avg_offer_count,
  ROUND(SUM(SalesAmount)/SUM(UnitsOrdered),2) AS asp,
  ROUND(100*SUM(UnitsOrdered)/SUM(Sessions),2) AS units_per_session_pct
FROM business_reports_dpst_date
WHERE SellerID=<ID> AND (<the three ranges>)
GROUP BY period ORDER BY period
```

`BuyBoxPercentage` is stored as a fraction (0.9707), so multiply by 100. Check `last_day` per
period; that is the safety net on window alignment.

Derived, all from these two queries:

```
ACOS  = ad_spend / ad_sales * 100
TACOS = ad_spend / ops      * 100
AOV   = ad_sales / orders
ad share of sales = ad_sales / ops * 100
```

## 3. Dark ad days

```sql
SELECT COUNT(*) AS active_days, ROUND(SUM(sp),2) AS total_spend FROM (
  SELECT DATE(DateTime) d, SUM(Cost) sp FROM campaignmetric
  WHERE SellerID=<ID> AND DateTime BETWEEN '<start>' AND '<end>'
  GROUP BY d HAVING sp > 0
) t
```

Run per window. Derive the dark dates by listing the ACTIVE days and subtracting from the
calendar: a day with no rows at all (the common outage shape) never shows up in a GROUP BY,
so asking SQL for zero-spend days misses exactly the days that matter. If `active_days` is
short of the calendar day count, name the outage dates, then normalize: `figure * calendar_days / active_days`. Apply to
spend, ad sales and TACOS. Leave ACOS alone.

## 4. Settled-window efficiency check

The one that stops a brief from being wrong. Re-run the ad query for both periods ending 7 days
earlier, so the Sponsored Products window has fully elapsed on both sides:

```sql
SELECT
  CASE WHEN DateTime BETWEEN '<cur_start>' AND '<cur_end_minus_7>' THEN 'A_current_settled'
       ELSE 'B_prior_settled' END AS period,
  ROUND(SUM(Cost),2) spend,
  ROUND(SUM(CASE WHEN CampaignType='sponsoredProducts'
                 THEN AttributedSales7day ELSE AttributedSales14day END),2) ad_sales
FROM campaignmetric WHERE SellerID=<ID>
  AND (DateTime BETWEEN '<cur_start>' AND '<cur_end_minus_7>'
    OR DateTime BETWEEN '<pri_start>' AND '<pri_end_minus_7>')
GROUP BY period
```

Add a sub-brand or segment dimension when the account splits, since the deterioration is usually
concentrated. Compare the settled ACOS gap to the unsettled one and report the settled figure as
the verified one.

## 5. Daily trend and exit rate

```sql
SELECT DATE(DateTime) d, ROUND(SalesAmount,0) ops, UnitsOrdered units,
       Sessions sessions, ROUND(AverageOfferCount,0) offers
FROM business_reports_dpst_date
WHERE SellerID=<ID> AND DateTime BETWEEN '<cur_start>' AND '<cur_end>' ORDER BY d
```

Compare the first 7 days' daily average to the last 7 days'. A month closing well reads very
differently from its month-to-date total, and vice versa. The run-rate close is
`current_total + remaining_days * trailing_7_day_average`. Present it as arithmetic. It is not a
forecast and must never be labelled one.

Step changes in `offers` are worth noticing: they usually mark a restock or a catalog push
landing, and they date it.

## 6. Sub-brand split

Two routes. Prefer campaign name when the naming convention is disciplined, because the
`campaign` dimension table often has null `Brand` or missing rows, which silently drops spend
into an unmapped bucket.

```sql
SELECT
  CASE WHEN CampaignName LIKE '%<Brand A>%' THEN 'A'
       WHEN CampaignName LIKE '%<Brand B>%' THEN 'B'
       ELSE 'OTHER' END AS sub,
  <period CASE>,
  ROUND(SUM(Cost),2) spend,
  ROUND(SUM(CASE WHEN CampaignType='sponsoredProducts'
                 THEN AttributedSales7day ELSE AttributedSales14day END),2) ad_sales,
  SUM(CASE WHEN CampaignType='sponsoredProducts'
           THEN AttributedConversions7day ELSE AttributedConversions14day END) orders,
  SUM(Clicks) clicks
FROM campaignmetric WHERE SellerID=<ID> AND (<ranges>)
GROUP BY sub, period ORDER BY sub, period
```

Check the `OTHER` bucket is empty or trivially small. If it is not, the naming convention has
drifted and the split needs the dimension table instead. Discover the available labels with
`SELECT DISTINCT Brand FROM campaign WHERE SellerID=<ID>`.

When the envelope serves entity or item-group tables, the engine's own groups are
authoritative; `context.yaml::item_group_mapping` applies only to battery or residual-SQL
classification like this one (first match wins, with a fallback group), and the per-group
membership should be shown for confirmation when it drives a client-facing split.

Retail side, split on catalog brand with a correlated subquery to avoid row multiplication:

```sql
SELECT COALESCE((SELECT i.Brand FROM mws_items i
                 WHERE i.ASIN=t.ChildAsin AND i.SellerID=<ID> LIMIT 1),'(unknown)') brand,
  ROUND(SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.Amount ELSE 0 END),0) cur,
  ROUND(SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.Amount ELSE 0 END),0) pri,
  SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.UnitsOrdered ELSE 0 END) cur_u,
  SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.UnitsOrdered ELSE 0 END) pri_u,
  SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.Sessions ELSE 0 END) cur_s,
  SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.Sessions ELSE 0 END) pri_s
FROM business_reports_dpst_sku t
WHERE t.SellerID=<ID> AND (<both ranges>)
GROUP BY brand ORDER BY cur DESC
```

## 7. ASIN movers

```sql
SELECT t.ChildAsin, MAX(t.Title) title,
  (SELECT COALESCE(NULLIF(i.ItemNickname,''), i.ItemName) FROM mws_items i
   WHERE i.ASIN=t.ChildAsin AND i.SellerID=<ID> LIMIT 1) AS nick,
  ROUND(SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.Amount ELSE 0 END),0) cur,
  ROUND(SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.Amount ELSE 0 END),0) pri,
  SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.UnitsOrdered ELSE 0 END) cur_u,
  SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.UnitsOrdered ELSE 0 END) pri_u
FROM business_reports_dpst_sku t
WHERE t.SellerID=<ID> AND (<both ranges>)
GROUP BY t.ChildAsin ORDER BY (cur-pri) ASC
```

Then reconcile before you quote anything from it:

```
sum(cur) over all rows  vs  account-level ops for the same window
```

Within about 0.5% is fine. A sum that comes back at roughly double or triple means a join
multiplied rows. Note the reconciliation figure in the brief's method section, because it is
what entitles you to put item-level dollars in front of a client.

Split the list into gross declines and gross gains and report both. The net is the account
delta; the two gross figures are the story.

Never invent a product nickname. Use `ItemNickname`, fall back to `ItemName` or the raw ASIN,
or ask. In client-facing lines prefer the nickname over the ASIN.

## 8. Out-of-stock days

Two levels of aggregation, and the inner one matters: `mws_inventory_history` carries several
rows per ASIN per day, so a naive `SUM(CASE WHEN FulfillableQuantity<=0 ...)` counts rows and
returns impossible values like 200 out-of-stock days in a 25 day month.

```sql
SELECT item, ASIN,
  SUM(CASE WHEN d BETWEEN '<cur_start>' AND '<cur_end>' THEN zero_day ELSE 0 END) cur_oos,
  SUM(CASE WHEN d BETWEEN '<pri_start>' AND '<pri_end>' THEN zero_day ELSE 0 END) pri_oos
FROM (
  SELECT COALESCE(NULLIF(i.ItemNickname,''), h.ASIN) item, h.ASIN, DATE(h.DateTime) d,
    CASE WHEN MAX(h.FulfillableQuantity) <= 0 THEN 1 ELSE 0 END AS zero_day
  FROM mws_inventory_history h
  LEFT JOIN mws_items i ON i.ASIN=h.ASIN AND i.SellerID=h.SellerID
  WHERE h.SellerID=<ID> AND (<both ranges>)
  GROUP BY item, h.ASIN, d
) t
GROUP BY item, ASIN ORDER BY cur_oos DESC
```

`MAX(FulfillableQuantity)` per ASIN-day is the definition: sellable somewhere means sellable.
Deliberately ignores inbound and reserved quantity, so it reads as "could not be bought".

Join this against the mover list. The attributable set is the ASINs that both declined
materially and are materially worse on out-of-stock days than the prior window. ASINs sitting at
zero in both windows are dormant listings, not this month's news.

## 9. Buy Box by ASIN, page-view weighted

Two things make this query different from the obvious one, and both matter.

Weight by page views rather than taking a daily mean: `SUM(BuyBoxPercentage * PageViews) /
SUM(PageViews)`. Losing the featured offer collapses traffic as well as conversion, so a simple
average gives a near-empty broken day the same standing as a busy healthy one. Weighting can flip
the sign of the month over month move.

Return a **last 7 days** column beside the month. A month average blends a resolved problem with
the days it was broken, so an item that lost the box for two weeks and then recovered reads as a
persistent 58% problem when the last week is 99%. The last 7 days column is the one to act on.

```sql
SELECT (SELECT COALESCE(NULLIF(i.ItemNickname,''), i.ItemName) FROM mws_items i
        WHERE i.ASIN=t.ChildAsin AND i.SellerID=<ID> LIMIT 1) nickname, t.ChildAsin asin,
  ROUND(SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.Amount ELSE 0 END),0) cur_sales,
  ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)
         /NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '<pri_start>' AND '<pri_end>' THEN t.PageViews ELSE 0 END),0),1) pri_bb_pvw,
  ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)
         /NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '<cur_start>' AND '<cur_end>' THEN t.PageViews ELSE 0 END),0),1) cur_bb_pvw,
  ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '<last7_start>' AND '<cur_end>' THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)
         /NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '<last7_start>' AND '<cur_end>' THEN t.PageViews ELSE 0 END),0),1) last7_bb_pvw
FROM business_reports_dpst_sku t
WHERE t.SellerID=<ID> AND (<both ranges>)
GROUP BY t.ChildAsin
HAVING cur_sales >= 400 AND (cur_bb_pvw < 92 OR last7_bb_pvw < 92)
ORDER BY last7_bb_pvw ASC
```

Raise the sales floor for a larger account. Classify each row:

- `last7 < 92` → still open, and it goes to the featured offer diagnosis.
- `last7 >= 92` with a bad month figure → recovered. Report it as a win, and do not tell the
  client an action item failed.
- `last7 IS NULL` → no page views in the last week. **Not recovery.** Usually out of stock or a
  suppressed listing. Check inventory before writing anything about it.

## 9b. Availability breadth

Amazon reports `AverageOfferCount` only at account level, and it counts *listings*, so it rises
when new listings go live even while availability falls. Two constructed measures give the
segment-level answer, and the second is usually the most legible availability number in the brief.

Average in-stock and listed items per day, by segment:

```sql
SELECT segment, period, ROUND(AVG(instock),1) avg_instock_items, ROUND(AVG(listed),1) avg_listed_items
FROM (
  SELECT COALESCE((SELECT i.Brand FROM mws_items i
                   WHERE i.ASIN=h.ASIN AND i.SellerID=<ID> LIMIT 1),'(unmapped)') segment,
    <period CASE on h.DateTime> period, DATE(h.DateTime) d,
    COUNT(DISTINCT CASE WHEN h.FulfillableQuantity > 0 THEN h.ASIN END) instock,
    COUNT(DISTINCT h.ASIN) listed
  FROM mws_inventory_history h WHERE h.SellerID=<ID> AND (<ranges>)
  GROUP BY segment, period, d
) t GROUP BY segment, period ORDER BY segment, period
```

Share of page views that landed on something buyable:

```sql
SELECT segment, period,
  ROUND(100*SUM(CASE WHEN instock=1 THEN pv ELSE 0 END)/NULLIF(SUM(pv),0),1) pct_pv_on_instock,
  SUM(pv) page_views
FROM (
  SELECT COALESCE((SELECT i.Brand FROM mws_items i
                   WHERE i.ASIN=s.ChildAsin AND i.SellerID=<ID> LIMIT 1),'(unmapped)') segment,
    <period CASE on s.DateTime> period, s.ChildAsin, DATE(s.DateTime) d, SUM(s.PageViews) pv,
    (SELECT CASE WHEN MAX(h.FulfillableQuantity) > 0 THEN 1 ELSE 0 END FROM mws_inventory_history h
      WHERE h.SellerID=<ID> AND h.ASIN=s.ChildAsin AND DATE(h.DateTime)=DATE(s.DateTime)) instock
  FROM business_reports_dpst_sku s WHERE s.SellerID=<ID> AND (<ranges>)
  GROUP BY segment, period, s.ChildAsin, d
) t GROUP BY segment, period ORDER BY segment, period
```

Label both as our own measures. They answer the same question as offer count but are not the same
metric and will not tie to the account row. Say that in the method notes rather than letting a
client discover it.

## 9c. Daily series for one item

Run this for every flagged Buy Box item before writing a word about it. It gives the break date,
the recovery date, and the before, during and after rates, which is both the impact figure and
the proof the fix landed.

```sql
SELECT DATE(t.DateTime) d, ROUND(t.BuyBoxPercentage*100,1) bb, ROUND(t.Amount,0) sales,
       t.UnitsOrdered units, t.PageViews pv
FROM business_reports_dpst_sku t
WHERE t.SellerID=<ID> AND t.ChildAsin='<ASIN>'
  AND t.DateTime BETWEEN '<pri_start>' AND '<cur_end>' ORDER BY d
```

Watch the page view column as well as the Buy Box column. Traffic collapsing alongside the box is
what makes a featured offer loss cost more than a conversion-rate view suggests: on one real case
page views fell about 80% during the loss.

## 9d. Live featured offer state

The warehouse tells you the history. For current state, ask Amazon.

```bash
mixshift amazon call pricing.get_item_offers_batch --legacy-seller-id <ID> --json \
  --body '{"requests":[{"uri":"/products/pricing/v0/items/<ASIN>/offers","method":"GET",
           "MarketplaceId":"ATVPDKIKX0DER","ItemCondition":"New"}]}'
```

Up to 20 ASINs per batch, one batch per roughly 12 seconds, and each response item carries its
own status code. Read:

| Field | Tells you |
|---|---|
| `Offers[].IsFeaturedMerchant`, `IsBuyBoxWinner` | Who holds the box |
| `Offers[].SellerId` | Whether the winner is us or a third party |
| `Summary.NumberOfOffers` | Whether there is any competition at all |
| `Summary.CompetitivePriceThreshold` | The price ceiling Amazon is enforcing |
| `Offers[].ListingPrice` | Our price against that ceiling |

The diagnosis fork: a competing seller id on the featured offer is a pricing or authorisation
question. **No featured offer at all with one offer, ours,** is suppression, meaning Amazon sees a
lower price off Amazon. Repricing is not the fix there and may be barred by MAP: the fix is a
dispute evidenced by the competitor's item price plus shipping. A `CompetitivePriceThreshold`
equal to our listing price means no headroom, and any upward price move re-breaks the item.

Catalog price history is sparse (`mws_items_history` carries only a small daily subset per
seller), so you usually cannot date a price edit. Report the recovery date, not the edit date, and
write the mechanism as "consistent with" rather than "caused by".

## 10. Full-month history

For the prior-year base check and general shape.

```sql
SELECT DATE_FORMAT(DateTime,'%Y-%m') m, ROUND(SUM(SalesAmount),0) ops,
       SUM(UnitsOrdered) units, SUM(Sessions) sessions, COUNT(*) days
FROM business_reports_dpst_date
WHERE SellerID=<ID> AND DateTime >= '<15 months back>'
GROUP BY m ORDER BY m
```

`days` catches partial months. Look at the prior-year comparison month against its own
neighbours: if it is an obvious trough, the year-over-year comp is flattered by the base and the
brief should say so.

## 11. Vendor Central battery and the brand roll-up

`MPRX-FIGURES-VC-01` is the vendor sibling of sections 1 to 10, run by the service for any
account row whose `seller.MerchantType` is `Vendor`. Statement by statement (all bound by
`SellerID`, dates as `DateTime`, one row per ASIN-day in every vendor table):

| Section | Table(s) | What it serves | Trap it encodes |
|---|---|---|---|
| `windows` | `vendor_sales_manufacturing_asin`, `vendor_traffic_asin_daily`, `campaignmetric` | `MAX(DateTime)` of each; the window ends at the EARLIEST | Vendor traffic loads separately from vendor sales; a final day with units but no glance views is trimmed |
| `account_ads` | `campaignmetric` | spend, 14-day sales and orders, clicks, impressions per period; ACOS, TACOS, ad share, AOV derived | Never `sellermonthmetric`; the 7-day columns are empty for SB/SD on a vendor row |
| `account_retail` + `account_traffic` | vendor sales, vendor traffic | `OrderedRevenueAmount` / `OrderedUnits` (or shipped), `GlanceViews`, ASP, `gv_conversion_pct` = units / glance views | Two tables, one section: a null glance-view side leaves conversion null, never a sessions alias |
| `dark_days` | `campaignmetric` | active ad days, zero-spend days, normalization factor per window | An exception check; report it only when a window has dark days |
| `settled_check` | `campaignmetric` | settled current vs prior window by segment | Same 7-day settled exclusion as SC |
| `daily` + `daily_traffic` | vendor sales, vendor traffic | daily revenue, units, glance views; 7-day pace arithmetic | Arithmetic, not a forecast |
| `segment_ads` | `campaignmetric` | paid split by campaign name LIKE | Labels, never vendor codes |
| `segment_retail` + `segment_traffic` | vendor sales, vendor traffic, `vendor_items.CustomBrand` | retail split by the operator's own label, with glance views and conversion per label | Correlated subquery with LIMIT 1 even though `vendor_items` is one row per ASIN (verified: 950 rows, 0 duplicates) |
| `movers` | vendor sales, `vendor_items.ItemNickname` | per-ASIN revenue and units, both windows, delta, gross gains and declines, sum for the reconciliation | Reconciliation gap should be zero: same table both sides |
| `oos_days` | `vendor_inventory_manufacturing_asin_daily` | per ASIN: days at or above the OOS rate threshold, and days out of stock WHILE sellable units were on hand | `MAX()` per ASIN-day; the rate is a fraction 0 to 1, default threshold 0.99 |
| `availability_interruptions` | derived from `oos_days` | account totals of the interruption pattern (ASIN-days, ASINs) and the top items | The finding a vendor manager acts on; 16 ASIN-days vs 1 on a real account |
| `inventory` | `vendor_inventory_manufacturing_asin_daily` | sellable, unsellable, aged 90+, open PO units on the last loaded day; net received over the window | Snapshot vs flow: do not sum the snapshot columns across days |
| `monthly_history` + `monthly_traffic` | vendor sales, vendor traffic | 15 months of revenue, units, glance views, days loaded | Same as SC |

Not in the battery, by design: weeks of cover and lost sales. Both are engine metrics with a
channel-aware definition (VC cover = the latest `vendor_demandforecast` snapshot at or before
period end over the next 6, 9 and 12 weeks; SC = trailing 7, 14, 30 days), served by
INS-LOSTSALES-01 and INS-OPS-BRIDGE-01. Quote the served figure and its basis.

**The brand roll-up (`MPRX-FIGURES-BRAND-01`).** One statement of its own, the seller rows
(`seller` joined to `marketplace` for the currency), then each account through its channel
battery with `as_of` set to the EARLIEST of the accounts' own data-aligned window ends, so the
brand runs on one day count. Roll-up rules, in order of what can go wrong:

1. Sum only summable figures, and only within one marketplace (= one currency): ordered
   revenue, units, ad spend, ad sales, orders, clicks, impressions, per period; recompute
   ACOS, TACOS, ad share, AOV and ASP from the sums, never average the ratios.
2. Traffic and conversion per CHANNEL: `traffic.SC` (sessions, units per session) and
   `traffic.VC` (glance views, glance-view conversion) are never added together.
3. Movers merge by ASIN per channel; the same ASIN sold 1P and 3P is two businesses.
4. Sub-brand splits sum by LABEL across codes (campaign name for ads, `CustomBrand` for
   retail); vendor codes never create the split.
5. Dark-day normalization stays per account (a lapse on one code is not a lapse on the
   brand); the roll-up names which accounts had dark days.
6. Several currencies = several roll-ups and no brand total, labelled `mixed_currency`.

## The per-ASIN roll-up has no zero-sale rows (SC traffic basis)

`business_reports_dpst_sku` emits a row only on ASIN-days that sold at least one unit:
confirmed on three separate accounts, twelve months each, zero rows with
`UnitsOrdered = 0`. Summing its sessions therefore drops exactly the non-converting
traffic. Account traffic and conversion come from `business_reports_dpst_date`, always;
per-ASIN and per-group session figures are "sessions on selling days" and must be labeled
so. Confirm the property on a new account with:

```sql
SELECT COUNT(*) total_rows,
       SUM(CASE WHEN UnitsOrdered = 0 THEN 1 ELSE 0 END) zero_unit_rows
FROM business_reports_dpst_sku
WHERE SellerID = <ID>
  AND DateTime >= '<12 months ago>' AND DateTime < '<month start>'
```

## Probe catalog

Before any question ships in Things-to-check, check this table: a question with a probe is
a finding waiting to be run (budget `reporting.max_live_probes`, default 5; disclose
metered probes first).

| Question | Probe | What it proves |
|---|---|---|
| Who holds the Buy Box now? | `pricing.get_item_offers_batch` on the flagged ASINs | Competitor vs suppression vs recovered (Step 6 fork). Match offers against the account's own `AmazonSellerID` (`mws_items`) to separate the client from the interloper; name the competitor via `amazon.com/sp?seller=<SellerId>`; record competitor SellerIds in the run record for month-over-month continuity |
| Is this near-zero item suppressed or stocked out? | Inventory history per ASIN (query 8, single-ASIN) + live offers | Stockout shows zero fulfillable; suppression shows inventory with no featured offer |
| Did spend fall by bids, budgets, or delivery? | Daily spend + impressions + CPC + CPM around the break date | Bid cuts cheapen the impression (CPC and CPM fall together); impressions down with CPC flat and CPM UP is less delivery, not cheaper clicks; a step change on a date points at a budget or state change. Say "bid pullback" only when bids are observed or the account's change log says so |
| Did a promotion drive the lift? | `mws_orders_metric`: SUM(ItemPromotionDiscount) + promo-touched units (PromotionIds <> '') by month | Promo intensity flat or falling while conversion rises = not promo-driven. Gotchas: filter on `dtPurchasedOn` (the string PurchaseDate column does not compare as a date); never alias a column `lines` (reserved) |
| One Buy Box problem or several? | Daily `BuyBoxPercentage` per flagged ASIN (query 8 shape) across the window | Break dates and troughs clustering across items = ONE shared trigger (price event, family-level change); scattered dates = independent problems. Anchor any cause talk to the cluster shape |
| Did a channel-scoped commitment land? | `campaignmetric`: SUM(Cost) by `CampaignType` by month (types: sponsoredProducts, headlineSearch = Sponsored Brands, sponsoredDisplay) | The account total hides mix: SP up under an SB pullback nets to flat. Grade the commitment on its named channel; if it is plan-relative, the baseline is the plan (owner's tracker), not the prior month |
| Is a group's traffic drop the ads, the season, or a problem? | Three legs: the engine's group-level `topDrivers` for sessions (delta + bps contribution), SUM(Clicks) on the group's campaigns by month, and the SAME MONTHS LAST YEAR from `business_reports_dpst_sku` | Deterministic split: paid share = the clicks delta; seasonal share = the prior-year fade over the same months; whatever remains is the real question. A fade SHALLOWER than last year's closes it; label the per-item session basis when quoting YoY |
| Is a dark item a seasonal ending or a stockout gap? | Sales shape by half-month (`business_reports_dpst_sku`, column `Amount`) + `mws_items` OpenDate + `mws_inventory_history` FulfillableQuantity and Inbound* (columns `DateTime`, `FulfillableQuantity`, `InboundWorkingQuantity/ReceivingQuantity/ShippedQuantity`) | Sold through early summer + zero fulfillable + ZERO INBOUND = ended (seasonal candidate, especially when OpenDate clusters by spring cohort); inbound quantities present = a restock in motion, i.e. a gap. `mws_items.ItemQuantityAvailable` is the listings-feed quantity, not FBA stock: read stock from inventory history |
| Did the ad change cause the retail move? | Daily ad impressions + paid clicks vs account sessions around the candidate date | Both series breaking on the same date turns a correlation into something defensible; different dates kill the attribution |
| Is the decline seasonal? | Same item, same window, prior year (query 7 with `prior_year`) | A matching prior-year dip is season; a flat prior year is not |
| Is the traffic loss account-wide or item-local? | Page views for the flagged ASINs vs the account daily series | Local loss points at placement or listing; global points at demand or spend |
| Did the last call's budget commitment land? | Like-day spend windows (query 1, spend only) | Landed / not landed in this channel; other channels stay "not visible here" |

## Scale ceiling

The gateway enforces a 60-second statement ceiling. On catalogs with millions of inventory
rows (seen at about 8,600 listed items / 7.5M rows), the out-of-stock and availability
breadth queries exceed it, the battery labels those sections failed, and the brief runs
without them, saying so. A bounded variant still answers the question where it matters:
run the same OOS query with `AND h.ASIN IN (<top 20 current-window sellers>)` and label it
as top-20 coverage. The Intelligence engine can hit the same wall on these accounts
(`account_too_large_use_async`, and the async run can itself time out terminally): that is
a degrade-and-label, battery-carries-the-brief month, and an engine-team routing.

## Known traps

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown column 'date'` | Date column is `DateTime` | Use `DateTime` |
| `Unknown column 'c.CampaignID'` | `campaign` has `ID` and `AmazonCampaignID`, not `CampaignID` | Join on `AmazonCampaignID` plus `SellerID` |
| SKU sums are 2x to 3x the account total | `JOIN mws_items` multiplies, several rows per ASIN | Correlated subquery for the nickname |
| Out-of-stock days exceed the day count | Multiple warehouse rows per ASIN-day | Nested aggregate, `MAX(...)` per ASIN-day |
| Buy Box reads 0.9 | Stored as a fraction | Multiply by 100 |
| A period bucket holds a suspiciously small figure | Overlapping CASE ranges, an earlier branch consumed the days | Make the ranges mutually exclusive |
| Zero rows for a SellerID you expected | Wrong account row, often the VC twin of an SC account | Confirm against the row-count query in Step 2 |
| `mixshift data query` returns `status: error` and no `rows` key | Query failed | Read `message`; never index `rows` without checking `status` |
| Tier or segment sums far exceed the account total | Grouping on a joined `mws_items` label | Correlated subquery, or group in a subselect first |
| VC window a day ahead of the traffic feed, conversion inflated | Vendor traffic loads after vendor sales | Resolve from the earliest of the three load dates; trim a units-without-glance-views day |
| VC out-of-stock days read 0 everywhere | `ProcurableProductOutOfStockRate` is a fraction 0 to 1, not a percent | Compare against 0.99, not 99 |
| VC account ACOS reads 0.2 every month | `sellermonthmetric` stores a one-decimal fraction, and it is not a sanctioned source | Never read `sellermonthmetric`; compute from `campaignmetric` spend over 14-day sales |
| SB or SD `ad_sales_14d < ad_sales_7d` for the same rows | Impossible with complete data; the 14-day columns lag the 7-day ones on recent loads | Flag it, do not quote SB/SD efficiency from the affected days; offer to proceed with a note or wait for the load |
