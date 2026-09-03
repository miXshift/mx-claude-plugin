# Warehouse queries: the brief's figure battery

Everything here is read-only through `mixshift data query --sql "..." --json`, which is already
scoped to the signed-in account's warehouse.

**Where these queries sit in the pipeline.** The Intelligence envelope serves the core MoM/YoY
figures and their evidence; this battery serves what the envelope does not: the daily series,
dark days, the settled-window check, out-of-stock days, page-view-weighted Buy Box with the
last-7-days column, availability breadth, and the mover reconciliation. Where both sources
serve the same figure, the envelope wins and the battery's total is the cross-check; a gap
beyond about half a percent is a finding (usually restatement), not a choice.

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
| Monthly settled ad rollup | `sellermonthmetric` |
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
- **VC (Vendor Central).** Ad metrics from `sellermonthmetric`, which is settled. Do not
  aggregate raw `campaignmetric` for VC account-level ACOS (like-day SPEND from it is fine,
  labeled; it is attributed sales that unsettle). Retail from `vendor_sales_manufacturing_asin`,
  on the ORDERED basis unless the client's convention says shipped; never mix bases in one
  comparison. There is no Buy Box and no session count; use glance views from
  `vendor_traffic_asin_daily` as the traffic proxy and say so. Two field-proven traps:
  resolve VC windows from the VENDOR table's own `MAX(DateTime)`, not the ads table's
  (vendor retail loads later, and a one-day misalignment flipped a real month's MoM sign
  from -0.5% to the true +4.6%); and never read `sellermonthmetric`'s own ACoS columns,
  which store a fraction rounded to one decimal (every month reads 0.2): compute ACOS from
  spend over sales.

**Attribution windows.** SC: Sponsored Products 7 day, Sponsored Brands 14 day, Sponsored
Display 14 day. VC: all 14 day. The SC rule as SQL, which is the canonical form:

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

## Probe catalog

Before any question ships in Things-to-check, check this table: a question with a probe is
a finding waiting to be run (budget `reporting.max_live_probes`, default 5; disclose
metered probes first).

| Question | Probe | What it proves |
|---|---|---|
| Who holds the Buy Box now? | `pricing.get_item_offers_batch` on the flagged ASINs | Competitor vs suppression vs recovered (Step 6 fork) |
| Is this near-zero item suppressed or stocked out? | Inventory history per ASIN (query 8, single-ASIN) + live offers | Stockout shows zero fulfillable; suppression shows inventory with no featured offer |
| Did spend fall by bids or budgets? | Daily spend series per campaign (query 5 grain, `Cost` only) | A step change on a date is a budget cut; a proportional glide is bids |
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
| SB or SD `ad_sales_14d < ad_sales_7d` for the same rows | Impossible with complete data; the 14-day columns lag the 7-day ones on recent loads | Flag it, do not quote SB/SD efficiency from the affected days; offer to proceed with a note or wait for the load |
