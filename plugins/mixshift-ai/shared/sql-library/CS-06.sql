-- ID: CS-06
-- Purpose: SC SP attribution window comparison (1-day vs 7-day) for the
--          most recent full month — derives the attribution-window factor
--          and the daily-backfill calibration baseline.
-- Params: :seller_id
-- Consumers: brand-context (Query 5, SC SP path)
-- Tier: 1

SELECT
    ROUND(SUM(Cost), 2) AS spend,
    ROUND(SUM(AttributedSales1day), 2) AS sales_1day,
    ROUND(SUM(AttributedSales7day), 2) AS sales_7day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0) * 100, 2) AS acos_1day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0) * 100, 2) AS acos_7day,
    ROUND((SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)
         - SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0)) * 100, 2) AS improvement_pts
FROM campaignmetric
WHERE SellerID = :seller_id
  AND CampaignType = 'sponsoredProducts'
  AND DateTime >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND DateTime <  DATE_FORMAT(CURDATE(), '%Y-%m-01');
