-- ID: CS-08
-- Purpose: Daily 1-day vs 7-day attribution calibration distribution over
--          the last ~90 settled days. Caller computes the median or mean
--          improvement_pts to derive the daily backfill multiplier.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 5, daily calibration)
-- Tier: 1
--
-- Window: T-104 through T-7 (T-7 ceiling guarantees attribution settled).

SELECT DATE(DateTime) AS d,
       ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0) * 100, 2) AS acos_1day,
       ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0) * 100, 2) AS acos_7day,
       ROUND((SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)
            - SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0)) * 100, 2) AS improvement_pts
FROM campaignmetric
WHERE SellerID = :seller_id
  AND CampaignType = 'sponsoredProducts'
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 104 DAY)
  AND DateTime <  DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY DATE(DateTime)
HAVING acos_1day IS NOT NULL AND acos_7day IS NOT NULL
ORDER BY DATE(DateTime);
