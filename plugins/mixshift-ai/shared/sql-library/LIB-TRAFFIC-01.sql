-- ID: LIB-TRAFFIC-01
-- Purpose: Sessions, page views, units, sales, unit session % and
--          page-view-weighted Buy Box % per ASIN for ONE Seller Central
--          seller over a date range, from business_reports_dpst_sku, with
--          each product's traffic counted once per day.
-- Params: :seller_id, :start_date, :end_date, :asin
--         (:asin is a single ASIN, or NULL for every ASIN of the seller;
--          the dates are inclusive days, 'YYYY-MM-DD')
-- Consumers: mx-data-explore (ad-hoc traffic and conversion by ASIN)
-- Tier: 1
--
-- Grain of business_reports_dpst_sku: one row per SKU per day. Amazon
-- reports traffic per product (ASIN): Sessions, PageViews, BuyBoxPercentage
-- and the Browser*, MobileApp* and *Percentage traffic columns. The
-- SKU-level report repeats them on each of the product's SKU rows for the
-- day, while UnitsOrdered, Amount and TotalOrderItems are each SKU's own.
-- So the inner level takes one row per (SellerID, ChildAsin, day): MAX of
-- the traffic columns, SUM of the sales columns. The outer level adds the
-- days up per ASIN. Buy Box % is weighted by page views over those daily
-- rows (BuyBoxPercentage is stored as a fraction, 0.9 = 90%). Unit session %
-- is recomputed from the sums; UnitSessionPercentage is per SKU and is never
-- averaged.
-- The table has rows only on days a SKU sold, so these are sessions on
-- selling days: the sum over ASINs is below the account's sessions, and an
-- ASIN's unit session % reads higher than over all of its days. For account
-- sessions and conversion use business_reports_dpst_date (one row per day).
-- LIMIT 500 returns the top ASINs by sessions: totals over the result are
-- not account totals. Raise it or page for a full list.

SELECT
    d.ChildAsin                                                   AS asin,
    MAX(d.Title)                                                  AS title,
    SUM(d.Sessions)                                               AS sessions,
    SUM(d.PageViews)                                              AS page_views,
    SUM(d.UnitsOrdered)                                           AS units,
    ROUND(SUM(d.Amount), 2)                                       AS sales,
    ROUND(100 * SUM(d.UnitsOrdered) / NULLIF(SUM(d.Sessions), 0), 2)
                                                                  AS unit_session_pct,
    ROUND(100 * SUM(d.BuyBoxPercentage * d.PageViews)
          / NULLIF(SUM(d.PageViews), 0), 1)                       AS buy_box_pct,
    COUNT(*)                                                      AS days_with_sales
FROM (
    SELECT
        s.SellerID,
        s.ChildAsin,
        DATE(s.DateTime)          AS day,
        MAX(s.Title)              AS Title,
        MAX(s.Sessions)           AS Sessions,
        MAX(s.PageViews)          AS PageViews,
        MAX(s.BuyBoxPercentage)   AS BuyBoxPercentage,
        SUM(s.UnitsOrdered)       AS UnitsOrdered,
        SUM(s.Amount)             AS Amount
    FROM business_reports_dpst_sku s
    WHERE s.SellerID = :seller_id
      AND s.DateTime BETWEEN :start_date AND :end_date
      AND (:asin IS NULL OR s.ChildAsin = :asin)
    GROUP BY s.SellerID, s.ChildAsin, DATE(s.DateTime)
) d
GROUP BY d.ChildAsin
ORDER BY sessions DESC
LIMIT 500;
