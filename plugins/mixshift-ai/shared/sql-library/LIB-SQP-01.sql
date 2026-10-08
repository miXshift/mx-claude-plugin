-- ID: LIB-SQP-01
-- Purpose: Search demand and share per search query for ONE Seller Central
--          seller over a date range, from Brand Analytics Search Query
--          Performance (sqp_weekly). Query volume is counted once per query
--          per week, the seller's own funnel counts are summed over their
--          ASINs, and each share is computed from counts.
-- Params: :seller_id, :start_date, :end_date, :asin
--         (:asin is a single ASIN, or NULL for every ASIN of the seller)
-- Consumers: mx-data-explore (ad-hoc SQP questions)
-- Tier: 1
--
-- Grain of sqp_weekly: ASIN x SearchQuery x week (StartDate = week start;
-- ReportDate is the LOAD date and several weeks can share one, so the date
-- range below is on StartDate, never ReportDate).
-- Amazon states the query-level columns (SearchQueryVolume, Total*Count)
-- ONCE per query per week; the warehouse repeats them on every one of the
-- seller's ASIN rows that showed for the query. So the inner level takes MAX
-- of the query-level columns and SUM of the Asin*Count columns per
-- (query, week); the outer level adds the weeks up.
-- Shares: 100 * own count / query total, only over weeks with a positive
-- total. Never AVG/SUM the rounded Asin*Share percent columns.
-- With :asin set, the share columns are that ASIN's share of the query.
-- search_query_volume stays the whole query's volume either way.
-- The table only holds queries where one of the seller's ASINs showed, and
-- GROUP BY SearchQuery merges accent variants (the collation ignores accents).
-- Seller Central only (Brand Analytics); vendors have no SQP. SQP clicks do
-- not foot to sessions and must not be divided by ad clicks.
-- LIMIT 500 returns only the top queries by volume: totals over the result
-- are not account totals. Raise it or page for a full list.
-- With :asin set, weeks_covered is that ASIN's weeks, not the query's.
-- weeks_covered counts the weeks the query appeared in, so compare two periods
-- only over queries present in both.

SELECT
    w.search_query,
    SUM(w.q_volume)       AS search_query_volume,
    SUM(w.own_impressions) AS own_impressions,
    SUM(w.own_clicks)      AS own_clicks,
    SUM(w.own_cart_adds)   AS own_cart_adds,
    SUM(w.own_purchases)   AS own_purchases,
    ROUND(100 * SUM(CASE WHEN w.q_impressions > 0 THEN w.own_impressions END)
          / NULLIF(SUM(CASE WHEN w.q_impressions > 0 THEN w.q_impressions END), 0), 2) AS impression_share_pct,
    ROUND(100 * SUM(CASE WHEN w.q_clicks > 0 THEN w.own_clicks END)
          / NULLIF(SUM(CASE WHEN w.q_clicks > 0 THEN w.q_clicks END), 0), 2)           AS click_share_pct,
    ROUND(100 * SUM(CASE WHEN w.q_cart_adds > 0 THEN w.own_cart_adds END)
          / NULLIF(SUM(CASE WHEN w.q_cart_adds > 0 THEN w.q_cart_adds END), 0), 2)     AS cart_add_share_pct,
    ROUND(100 * SUM(CASE WHEN w.q_purchases > 0 THEN w.own_purchases END)
          / NULLIF(SUM(CASE WHEN w.q_purchases > 0 THEN w.q_purchases END), 0), 2)     AS purchase_share_pct,
    COUNT(DISTINCT w.week_start) AS weeks_covered
FROM (
    SELECT
        SearchQuery                    AS search_query,
        StartDate                      AS week_start,
        MAX(SearchQueryVolume)         AS q_volume,
        MAX(TotalQueryImpressionCount) AS q_impressions,
        MAX(TotalClickCount)           AS q_clicks,
        MAX(TotalCartAddCount)         AS q_cart_adds,
        MAX(TotalPurchaseCount)        AS q_purchases,
        SUM(AsinImpressionCount)       AS own_impressions,
        SUM(AsinClickCount)            AS own_clicks,
        SUM(AsinCartAddCount)          AS own_cart_adds,
        SUM(AsinPurchaseCount)         AS own_purchases
    FROM sqp_weekly
    WHERE SellerID = :seller_id
      AND StartDate >= :start_date
      AND StartDate <= :end_date
      AND (:asin IS NULL OR ASIN = :asin)
    GROUP BY SearchQuery, StartDate
) w
GROUP BY w.search_query
ORDER BY search_query_volume DESC, w.search_query ASC
LIMIT 500;
