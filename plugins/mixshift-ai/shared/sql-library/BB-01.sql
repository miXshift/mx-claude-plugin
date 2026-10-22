-- ID: BB-01
-- Purpose: Per-campaign trailing-14-day performance and budget pressure for
--          the weekly budget-mix pass -- spend, sales, orders, ACoS, average
--          daily budget, days at or above the utilization threshold of the
--          budget, days with spend, and overall budget utilization.
--          Sponsored Products only (the only family v1 writes budgets for).
-- Params: :seller_id, :run_date, :utilization_threshold, :limit
-- Consumers: budget-balance (Round 1)
-- Tier: 1
-- Grain: campaignmetric holds one row per campaign per day for Sponsored
--        Products (AdvertisingPlacement is empty there), so Cost compares
--        directly with that day's CampaignBudget and no day is double
--        counted. Cost can exceed the budget on a day (Amazon may spend
--        above the daily budget on some days), so utilization above 100 is
--        valid, not an error.
-- Window: the 14 complete days before :run_date (today is excluded).
-- Default :utilization_threshold = 0.90; default :limit = 1000.

SELECT
    cm.CampaignID,
    cm.AmazonCampaignID,
    cm.CampaignName,
    ROUND(SUM(cm.Cost), 2)                                                    AS spend_14d,
    ROUND(SUM(cm.Sales), 2)                                                   AS sales_14d,
    SUM(cm.Orders)                                                            AS orders_14d,
    ROUND(SUM(cm.Cost) / NULLIF(SUM(cm.Sales), 0) * 100, 2)                   AS acos_14d,
    ROUND(AVG(cm.CampaignBudget), 2)                                          AS avg_daily_budget,
    SUM(CASE WHEN cm.Cost > 0 THEN 1 ELSE 0 END)                              AS days_with_spend,
    SUM(CASE WHEN cm.CampaignBudget > 0
              AND cm.Cost >= cm.CampaignBudget * :utilization_threshold
             THEN 1 ELSE 0 END)                                               AS days_at_cap,
    ROUND(SUM(cm.Cost) / NULLIF(SUM(cm.CampaignBudget), 0) * 100, 1)          AS budget_utilization_pct
FROM campaignmetric cm
WHERE cm.SellerID = :seller_id
  AND cm.CampaignType = 'sponsoredProducts'
  AND cm.DateTime >= DATE_SUB(:run_date, INTERVAL 14 DAY)
  AND cm.DateTime <  :run_date
GROUP BY cm.CampaignID, cm.AmazonCampaignID, cm.CampaignName
ORDER BY spend_14d DESC
LIMIT :limit;
