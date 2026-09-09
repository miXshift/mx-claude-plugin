# Amazon Retail Purchases (`amazon_retail_purchases`)

The paid AMC dataset behind lifetime value, repeat purchase, and cohort work.
Read this before writing SQL against it. Most of what goes wrong here does not
raise an error: it returns a plausible number that is wrong.

## What it is, and why it answers questions nothing else can

Every AMC table you get for free is **ad-attributed**: a purchase appears only
because Amazon could tie it to an ad the shopper saw or clicked, and the history
runs about 13 months.

This table is neither. It is **every Amazon store purchase of the advertiser's
products, whether or not an ad was involved**, and Amazon describes its
retention as *"multi-year ... longer than the default AMC 12.5 months"*. One row
per retail event.

That is what makes long-window customer questions possible:

- What is a customer worth over years, not over one campaign?
- Which ASIN brings people back, and which one is bought once and never again?
- What did an acquisition cohort go on to spend after the month it arrived?
- What share of a brand's real sales does advertising actually touch?

Two limits to establish before promising any of that.

**Retention is a ceiling, not what this instance holds.** History effectively
starts when the advertiser's subscription was activated. A real subscribed
instance checked 2026-09-09 had an `activationTime` of 2025-08-05, so about 13
months, not years. Never promise a five-year read without looking: the
subscription check below returns that `activationTime`, and
`SELECT MIN(purchase_date_utc)` confirms the real floor.

**Windows do not line up with the ad tables.** Joining to advertising data gives
you multi-year history on one side and about 13 months on the other. Clamp both sides to
the shorter window, or say plainly that the ad-side numbers cover only part of
the period.

## It is subscription-gated. Check before you write SQL.

The table exists only for advertisers subscribed to the retail purchase paid
feature. Querying it without that subscription fails at compile time, and
**the error does not mention the subscription**, so it reads like a broken query.

```bash
mixshift ads call amc.get_instance --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> \
  --path marketplaceId=<the marketplace that found this instance> --json
```

`instance.optionalDatasets` is an array of `{ label, activationTime }`. Look for
a `label` of `PURCHASE_RETAIL_PROGRAM`, and read its `activationTime` while you
are there, because that is where the data starts. `amc.list_instances` returns
the same array for every instance it lists, so either call answers the question;
prefer `amc.get_instance` once you hold an instance id, since the list pages at
100 and a real entity had more than 100 instances.

There is a second, independent signal: the schema call below returns
`isPremium: true` on this data source. A paid table you cannot reach usually
will not resolve there at all, so a successful schema read is corroboration in
its own right.

Two honest limits. A missing label is a reliable no. A present label is
**necessary but not proven sufficient**, since the entry carries an activation
time and no expiry, so a lapsed subscription may still list. If a query is
rejected at compile time despite the label being present, suspect a lapsed
subscription rather than your SQL.

To see the live column list rather than trusting this file:

```bash
mixshift ads call amc.get_data_source --legacy-seller-id <id> \
  --path instanceId=<instanceId> \
  --path entityId=<entityId> \
  --path marketplaceId=<same marketplace> \
  --path dataSourceName=amazon_retail_purchases --json
```

**Pass the same `marketplaceId` you used to find the instance.** Without it the
header defaults to the seller row's marketplace, and an instance that lives
under a different one returns 404. A 404 from this call is inconclusive on its
own: it can mean a mistyped table name, the wrong marketplace, the wrong entity,
or a table this instance genuinely cannot see. It is **not** proof that the
subscription is off. The `isPremium` flag on the response, or the
`PURCHASE_RETAIL_PROGRAM` label on the instance, speaks to that.

**This call also answers the threshold question**, which is the one that decides
what your query may return. Every column comes back with a `sensitivity` of
`NONE`, `LOW`, `MEDIUM` or `VERY_HIGH`, alongside its `dataType`. Read it from
the response when it matters. The table below is a convenience copy, verified
against a live subscribed instance on 2026-09-09; if it ever disagrees with the
response, the response is right.

## Columns

The `sensitivity` AMC assigns each column governs the **result set**, not the
SQL. `Returnable` below translates each value into what it means in practice.

- **Always** (`NONE`): no floor. Safe in any output.
- **2-user floor** (`LOW`): returnable, but AMC drops rows behind which fewer
  than two distinct shoppers sit.
- **100-user floor** (`MEDIUM`): returnable, but needs 100 distinct shoppers per
  row, so fine grouping usually collapses.
- **Aggregate only** (`VERY_HIGH`): never in the output. Group, join and count on
  it inside a common table expression and return the aggregate.

| Column | Type | Returnable | Notes |
|---|---|---|---|
| `asin` | STRING | 2-user floor | The ASIN purchased. |
| `asin_brand` | STRING | 2-user floor | Brand name. |
| `asin_name` | STRING | 2-user floor | Item name. Changes over time; see trap 6. |
| `asin_parent` | STRING | 2-user floor | Parent ASIN. Rolls variations up. |
| `currency_code` | STRING | 2-user floor | ISO currency code. Read trap 3 before summing money. |
| `event_id` | STRING | aggregate only | One retail event. MANY per `purchase_id`. |
| `is_business_flag` | BOOLEAN | always | Amazon Business order. |
| `is_gift_flag` | BOOLEAN | 2-user floor | Gift order. |
| `marketplace_id` | LONG | 2-user floor | Numeric marketplace id. Returnable, but `marketplace_name` reads better. |
| `marketplace_name` | STRING | 2-user floor | The readable label, e.g. `AMAZON.COM`. Group or filter on this. |
| `no_3p_trackers` | BOOLEAN | always | Third-party tracking flag. |
| `origin_session_id` | STRING | aggregate only | Session the item entered the cart. |
| `purchase_date_utc` | DATE | 2-user floor | **The date column. See trap 1.** |
| `purchase_day_utc` | INTEGER | 2-user floor | Day of month. |
| `purchase_dt_hour_utc` | TIMESTAMP | 2-user floor | Truncated to the hour. |
| `purchase_dt_utc` | TIMESTAMP | **100-user floor** | Full timestamp. Grouping by it usually returns far less than expected. |
| `purchase_hour_utc` | INTEGER | 2-user floor | Hour, 0 to 23. |
| `purchase_id` | STRING | aggregate only | One order. See trap 4. |
| `purchase_month_utc` | INTEGER | 2-user floor | **Month number 1 to 12. See trap 5.** |
| `purchase_order_method` | STRING | 2-user floor | `S` cart, `B` buy now, `1` one-click. |
| `purchase_program_name` | STRING | 2-user floor | Purchase program. |
| `purchase_session_id` | STRING | aggregate only | Session the purchase happened in. |
| `purchase_units_sold` | LONG | always | Units on the event. |
| `unit_price` | DECIMAL(12,2) | always | Price per unit **in the marketplace's local currency**. See trap 3. |
| `user_id` | STRING | aggregate only | The shopper. |
| `user_id_type` | STRING | 2-user floor | Always `adUserId` here. |

## The six traps

Each produces a wrong answer or a rejection, and none announce themselves.

1. **The date column is `purchase_date_utc`, and no two AMC tables agree.**
   `conversions` and `sponsored_ads_traffic` use `event_dt_utc`,
   `dsp_impressions` uses `impression_dt_utc`, `dsp_clicks` uses
   `click_dt_utc`, `dsp_views` uses `view_dt_utc`, and the
   `amazon_attributed_events_by_*` pair use `traffic_event_dt_utc` and
   `conversion_event_dt_utc`. A predicate copied between tables fails on the
   column name, which is the good outcome. Confirm each table's own date column
   when a query spans several.
2. **There is no total-sales column.** Revenue is
   `unit_price * purchase_units_sold`, computed per row and then summed.
3. **`unit_price` is in the marketplace's local currency, not always dollars.**
   An instance covering more than one marketplace will happily add dollars,
   pounds and pesos into one number that looks entirely normal. AMC cannot
   convert. Either filter to one `marketplace_name`, or group by it and convert
   outside AMC. Every recipe below groups or filters accordingly, and you should
   keep that when adapting them.
4. **One order spans many rows.** `purchase_id` is one-to-many with `event_id`,
   so `COUNT(*)` counts line items, not orders. Orders are
   `COUNT(DISTINCT purchase_id)`.
5. **`purchase_month_utc` is 1 to 12.** Grouping by it alone merges every
   January in the history into one bucket. Build a real month key with
   `EXTRACT(YEAR FROM purchase_date_utc)` alongside it, or group on
   `purchase_date_utc` directly.
6. **Item attributes drift over a long window.** `asin_name` and `asin_parent`
   are recorded per event, so a title edit or a variation-family change splits
   one ASIN across several values. Group by `asin` and take `MAX(asin_name)` for
   a label, never group by the label itself.

## The clean-room rule, stated in full

The five `VERY_HIGH` columns (`user_id`, `purchase_id`, `event_id`,
`origin_session_id`, `purchase_session_id`) may be grouped and joined **inside**
common table expressions. They may not appear in the final `SELECT`, the final
`GROUP BY`, or the final `ORDER BY`. All three clauses count.

AMC then suppresses output rows that sit below the threshold for the columns
they carry, so **an empty or short result may be redaction rather than an
absence of sales**. Do not report a zero without checking.

You can measure the redaction instead of guessing at it. The execution request
accepts three optional columns that make it visible:

- `distinctUserCountColumn` adds the distinct-user count AMC actually used.
- `filteredMetricsDiscriminatorColumn` adds a boolean, and changes the behavior:
  rows below threshold are kept with sensitive values nulled and this column set
  true, rather than being dropped silently.
- `filteredReasonColumn` adds the reason a row was filtered.

Set them on anything whose numbers a client will see. They turn "some rows are
missing" into a number you can quote and explain.

## Validate before you spend the compute

A full execution takes minutes. Submitting with `dryRun` set validates the query
and returns in seconds: a valid query resolves `SUCCEEDED`, an invalid one
`REJECTED` with the same parse error a real run would give. Use it on any
query you or the user just wrote, before the real submit.

Poll statuses are `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`, and
`REJECTED`. **`REJECTED` is the clean-room one**: AMC declined to run the query
on privacy, threshold or overlap grounds. Treat it as a signal to coarsen the
grouping or widen the window, not as a transient error to retry.

## Set the window, or every recipe below reports one day

**None of these queries carry a date predicate.** The window comes entirely from
the execution request, and `timeWindowType` **defaults to `MOST_RECENT_DAY`**.
Submit a lifetime-value query without setting it and Amazon returns a single
day's purchases, with no error and no warning. The result looks like a real
answer and is off by orders of magnitude. The worked example elsewhere in this
skill uses `MOST_RECENT_WEEK`, which fails the same way one week at a time.

Every recipe here needs an explicit window:

```json
{
  "workflow": { "sqlQuery": "..." },
  "timeWindowType": "EXPLICIT",
  "timeWindowStart": "2023-09-01T00:00:00",
  "timeWindowEnd": "2026-09-01T00:00:00"
}
```

Start no earlier than the subscription's `activationTime`, because there is
nothing before it. End at least two days before now, because recent days are
still filling in and a short tail reads as a sales decline.

## Query recipes

Each recipe says whether it has been run against a live instance. Do not
present an unproven one to a user as a verified result.

### A. Customer lifetime value segmentation — VERIFIED LIVE

Run in production against a subscribed instance, and reproduced here unchanged.
Segments shoppers by purchase behavior into four value tiers, and reports what
each tier spent and what was spent reaching them. Quartiles are built by hand
because `NTILE` is unsupported, and the window count uses a concrete column
because `COUNT(*) OVER ()` is rejected.

Add a `WHERE marketplace_name = '<one marketplace>'` to `user_purchases` when
the instance spans more than one, per trap 3.

```sql
WITH
  user_purchases AS (
    SELECT
      user_id,
      SUM(unit_price * purchase_units_sold) AS total_sales,
      SUM(purchase_units_sold)              AS total_units,
      COUNT(DISTINCT purchase_id)           AS distinct_purchases
    FROM amazon_retail_purchases
    WHERE user_id IS NOT NULL
    GROUP BY 1
  ),
  user_spend AS (
    SELECT user_id, SUM(spend_dollars) AS total_spend
    FROM (
      SELECT user_id, total_cost / 100000.0    AS spend_dollars
        FROM dsp_impressions       WHERE user_id IS NOT NULL
      UNION ALL
      SELECT user_id, spend / 100000000.0      AS spend_dollars
        FROM sponsored_ads_traffic WHERE user_id IS NOT NULL
    )
    GROUP BY 1
  ),
  ranked AS (
    SELECT
      p.user_id,
      p.total_sales,
      p.distinct_purchases,
      p.total_sales / NULLIF(p.distinct_purchases, 0) AS aov,
      COALESCE(s.total_spend, 0)                      AS total_spend,
      ROW_NUMBER() OVER (ORDER BY p.total_sales DESC)        AS sales_rank,
      ROW_NUMBER() OVER (ORDER BY p.distinct_purchases DESC) AS purch_rank,
      ROW_NUMBER() OVER (
        ORDER BY p.total_sales / NULLIF(p.distinct_purchases, 0) DESC
      )                                                      AS aov_rank,
      COUNT(p.user_id) OVER ()                               AS total_users
    FROM user_purchases p
    LEFT JOIN user_spend s ON s.user_id = p.user_id
  ),
  scored AS (
    SELECT
      user_id, total_sales, distinct_purchases, aov, total_spend,
      CAST(CEIL(sales_rank * 4.0 / total_users) AS INT) AS sales_quartile,
      CAST(CEIL(purch_rank * 4.0 / total_users) AS INT) AS purch_quartile,
      CAST(CEIL(aov_rank   * 4.0 / total_users) AS INT) AS aov_quartile
    FROM ranked
  ),
  segmented AS (
    SELECT
      user_id, total_sales, distinct_purchases, aov, total_spend,
      CASE
        WHEN sales_quartile = 1 AND purch_quartile <= 2 THEN 'High Value Customer'
        WHEN aov_quartile   = 1 AND purch_quartile >= 3 THEN 'Higher Revenue Potential Customer'
        WHEN distinct_purchases >= 2 AND purch_quartile <= 2 THEN 'High Growth Potential Customer'
        ELSE 'Low Value Customer'
      END AS customer_audience_segment
    FROM scored
  )
SELECT
  customer_audience_segment,
  COUNT(DISTINCT user_id)        AS num_users,
  AVG(total_sales)               AS avg_total_sales,
  SUM(total_sales)               AS sum_total_sales,
  AVG(total_spend)               AS avg_total_spend,
  SUM(total_spend)               AS sum_total_spend,
  AVG(total_sales - total_spend) AS avg_cltv,
  SUM(total_sales - total_spend) AS sum_cltv
FROM segmented
GROUP BY 1
ORDER BY num_users DESC
```

Segment definitions, so you can restate them: **High Value** is the top sales
quartile among more frequent buyers. **Higher Revenue Potential** is the top
basket-size quartile among less frequent buyers, the people worth bringing back.
**High Growth Potential** has repeated at least once and buys relatively often.
Everyone else is **Low Value**.

Four things to say out loud whenever you present `avg_cltv` or `sum_cltv`.

- **It is revenue minus advertising cost, not margin.** No product cost, fees or
  returns are in it.
- **The two sides cover different periods.** Sales come from this table's long
  history; spend comes from the ad tables, which retain about 13 months. Over a
  longer window spend is systematically missing and the figure is too generous.
- **Spend counts only people who bought.** Shoppers who saw ads and never
  purchased never enter `user_purchases`, so every dollar spent reaching them is
  excluded. This is customer-level value, not campaign efficiency, and it must
  never be presented as return on ad spend.
- **The frequency quartile is coarse.** Most shoppers buy once, so ranking by
  purchase count puts many tied users in an arbitrary order and the "frequent"
  half of a one-purchase population is not meaningful. Lean on the sales and
  basket-size quartiles, and treat `distinct_purchases >= 2` as the real
  repeat signal.

If any of that is too heavy for the audience, report `sum_total_sales` and
`sum_total_spend` as separate columns and drop the subtraction.

### B. Revenue per buyer by ASIN — NOT YET RUN LIVE

Answers which product earns the most from each customer it wins, and how often
those customers come back to it. Grouping is on `asin` alone, with the label
taken by `MAX`, because item titles drift over a long window (trap 6).

Note what this is **not**: it is revenue from that ASIN per buyer of that ASIN,
not the lifetime value of a customer the ASIN acquired. If someone asks for
"LTV by ASIN" meaning the latter, this recipe does not answer it, and building
that needs a first-purchase attribution step like recipe C's.

```sql
WITH
  buyer_asin AS (
    SELECT
      asin,
      user_id,
      MAX(asin_name)                        AS asin_name,
      MAX(asin_parent)                      AS asin_parent,
      MAX(marketplace_name)                 AS marketplace_name,
      SUM(unit_price * purchase_units_sold) AS user_asin_sales,
      COUNT(DISTINCT purchase_id)           AS user_asin_orders
    FROM amazon_retail_purchases
    WHERE user_id IS NOT NULL
      AND marketplace_name = 'AMAZON.COM'
    GROUP BY 1, 2
  )
SELECT
  asin,
  MAX(asin_name)                                 AS asin_name,
  MAX(asin_parent)                               AS asin_parent,
  MAX(marketplace_name)                          AS marketplace_name,
  COUNT(DISTINCT user_id)                        AS buyers,
  SUM(user_asin_sales)                           AS total_sales,
  SUM(user_asin_sales)
    / NULLIF(COUNT(DISTINCT user_id), 0)         AS sales_per_buyer,
  SUM(user_asin_orders)                          AS orders,
  COUNT(DISTINCT CASE WHEN user_asin_orders > 1 THEN user_id END) AS repeat_buyers,
  COUNT(DISTINCT CASE WHEN user_asin_orders > 1 THEN user_id END) * 1.0
    / NULLIF(COUNT(DISTINCT user_id), 0)         AS repeat_rate
FROM buyer_asin
GROUP BY 1
ORDER BY total_sales DESC
```

Change the `marketplace_name` filter to match the account, or drop it and group
by that column as well when you want every marketplace, remembering that the
money columns are then in mixed currencies and cannot be summed across rows.

To report at the parent level, group the outer query on `asin_parent` instead
and take `MAX` of the other labels.

`buyers` does not add up across rows. Someone who buys two ASINs is counted in
both, so summing the column overstates the customer base. Count distinct
shoppers in a separate query.

Expect low-volume ASINs to disappear under the redaction floor. Set the
filtered-row columns above if the total has to reconcile.

### C. Acquisition cohorts — NOT YET RUN LIVE

Groups shoppers by the month of their first purchase, then follows what each
cohort spent afterward. This is the shape behind a retention curve.

```sql
WITH
  first_purchase AS (
    SELECT user_id, MIN(purchase_date_utc) AS first_dt
    FROM amazon_retail_purchases
    WHERE user_id IS NOT NULL
      AND marketplace_name = 'AMAZON.COM'
    GROUP BY 1
  ),
  activity AS (
    SELECT
      f.user_id,
      EXTRACT(YEAR FROM f.first_dt) * 100 + EXTRACT(MONTH FROM f.first_dt) AS cohort_month,
      (EXTRACT(YEAR  FROM p.purchase_date_utc) - EXTRACT(YEAR  FROM f.first_dt)) * 12
      + (EXTRACT(MONTH FROM p.purchase_date_utc) - EXTRACT(MONTH FROM f.first_dt)) AS months_since,
      p.unit_price * p.purchase_units_sold AS line_sales,
      p.purchase_id
    FROM amazon_retail_purchases p
    JOIN first_purchase f ON f.user_id = p.user_id
    WHERE p.marketplace_name = 'AMAZON.COM'
  )
SELECT
  cohort_month,
  months_since,
  COUNT(DISTINCT user_id)     AS active_buyers,
  COUNT(DISTINCT purchase_id) AS orders,
  SUM(line_sales)             AS sales
FROM activity
GROUP BY 1, 2
ORDER BY cohort_month, months_since
```

Three caveats to pass on.

"First purchase" means first **inside the window you submitted**, not first
ever. Shoppers who were already buying before the window opened are misfiled
into its earliest cohort and look artificially loyal. This is why the window has
to start at the subscription's real beginning rather than wherever is
convenient, and why the earliest cohort should usually be dropped from the read.

A cohort's later months only compare to another cohort's later months when both
have had the same time to accumulate them.

Confirm `EXTRACT` behaves as written on the target instance before presenting
these numbers. It is standard, but this recipe has not been run live, and a
date-function difference would move every number without erroring. A dry run
settles it in seconds.

## Reconciling to numbers the client already has

Be careful to separate two different claims here.

**The table's scope** reconciles to reports the client already has. On Seller
Central it matches Business Reports, by-ASIN detail. On Vendor Central it
matches Retail Analytics sales, distributor view, which is the Manufacturing
view.

**A recipe's output does not**, and should never be presented as if it did.
Every recipe above filters to shoppers AMC could identify (`user_id IS NOT
NULL`), and redaction removes more rows on top of that. The result is a subset
of the table by construction. Quantify the gap with the filtered-row columns
rather than explaining it away.

Neither will match an advertising report, because most of these purchases were
never attributed to an ad. That gap is the point of the dataset, not an error
in it.

## Before you present any of this

- Say which window the numbers cover, and say it in months. Confirm it is the
  window you actually submitted, not the default.
- Say which recipe produced them and whether it has been run against a live
  instance. B and C have not.
- Say whether advertising is in scope. Most of these purchases were never
  ad-attributed, and a reader who assumes otherwise misreads everything.
- Say which marketplace, and never sum money across marketplaces.
- If a segment or ASIN is missing, check the redaction floor before concluding
  it had no sales.
