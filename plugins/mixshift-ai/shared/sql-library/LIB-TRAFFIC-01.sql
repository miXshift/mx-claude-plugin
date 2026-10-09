-- ID: LIB-TRAFFIC-01
-- Purpose: Sessions, page views, units and sales per ASIN for ONE Seller
--          Central seller over a date range, from business_reports_dpst_sku,
--          with each product's traffic counted once per day. Also the unit
--          session % and page-view-weighted Buy Box % over the days the
--          product sold (see the selling-days note below before quoting them).
-- Params: :seller_id, :start_date, :end_date, :asin
--         (:asin is a single ASIN, or NULL for every ASIN of the seller;
--          the dates are inclusive days, 'YYYY-MM-DD')
-- Consumers: mx-data-explore (ad-hoc traffic by ASIN)
-- Tier: 1
--
-- Grain of business_reports_dpst_sku: one row per SKU per day. Amazon
-- reports traffic per product (ASIN): Sessions, PageViews,
-- BuyBoxPercentage, SessionPercentage, PageViewsPercentage and their
-- Browser / MobileApp variants. The SKU-level report repeats them on each
-- of the product's SKU rows for the day, while UnitsOrdered, Amount and
-- TotalOrderItems (and their B2B twins) are each SKU's own. So the inner
-- level takes one row per (SellerID, ChildAsin, day): MAX of the traffic
-- columns, SUM of the sales columns. The outer level adds the days up per
-- ASIN. Buy Box % is weighted by page views over those daily rows
-- (BuyBoxPercentage is stored as a fraction, 0.9 = 90%). Unit session % is
-- recomputed from the sums; UnitSessionPercentage is per SKU and is never
-- averaged.
-- Selling days only: the table has a row only on days a SKU sold, so these
-- are sessions on selling days. The sum over ASINs is below the account's
-- sessions, and unit_session_pct_selling_days and buy_box_pct_selling_days
-- leave out every day the product did not sell, so they read high for slow
-- sellers (a day the product lost the Buy Box and sold nothing has no row).
-- Compare days_with_sales with days_in_range before quoting either. Do not
-- quote them as the product's conversion or Buy Box rate: for all days,
-- pull Amazon's Sales and Traffic report at CHILD grain (mx-amazon-report).
-- For account sessions and conversion use business_reports_dpst_date.
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
                                                                  AS unit_session_pct_selling_days,
    ROUND(100 * SUM(d.BuyBoxPercentage * d.PageViews)
          / NULLIF(SUM(d.PageViews), 0), 1)                       AS buy_box_pct_selling_days,
    COUNT(*)                                                      AS days_with_sales,
    DATEDIFF(:end_date, :start_date) + 1                          AS days_in_range
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
ORDER BY sessions DESC, asin
LIMIT 500;
