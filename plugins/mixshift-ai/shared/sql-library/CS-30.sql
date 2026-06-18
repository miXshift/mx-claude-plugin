-- ID: CS-30
-- Purpose: Daily account-level ad metrics (spend, ad sales, ACOS, clicks,
--          orders, CVR, CTR) over trailing 365 days. Used by enrich-context.py
--          for statistical change-point detection across the historical window.
-- Params: :seller_id_list
-- Consumers: brand-context (v2.3 enrichment)
-- Tier: 1
--
-- 365 daily rows. Account-type-agnostic (campaignmetric works for both SC and
-- VC). Output is fed to ruptures.Pelt for change-point detection on revenue,
-- ACOS, and CVR series.

SELECT
    DATE(DateTime)                                          AS metric_date,
    ROUND(SUM(Cost), 2)                                     AS spend,
    ROUND(SUM(Sales), 2)                                    AS ad_sales,
    SUM(Clicks)                                             AS clicks,
    SUM(Impressions)                                        AS impressions,
    SUM(Orders)                                             AS orders,
    ROUND(SUM(Cost)   / NULLIF(SUM(Sales), 0)       * 100, 2) AS acos_pct,
    ROUND(SUM(Orders) / NULLIF(SUM(Clicks), 0)      * 100, 4) AS cvr_pct,
    ROUND(SUM(Clicks) / NULLIF(SUM(Impressions), 0) * 100, 4) AS ctr_pct
FROM campaignmetric
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
  AND DateTime <  CURDATE()
GROUP BY DATE(DateTime)
ORDER BY metric_date;
