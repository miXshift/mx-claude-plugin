-- ID: DHC-11
-- Purpose: Budget cap follow-up — campaigns at >=90% utilization on
--          yesterday. Run when account-level spend is below lower CI to
--          determine whether budget caps explain the underrun.
-- Params: :seller_id, :yesterday, :utilization_threshold
-- Consumers: daily-health-check (diagnostic follow-up)
-- Tier: 1
--
-- Default :utilization_threshold = 0.90.

SELECT CampaignName, CampaignBudget, Cost,
       ROUND(Cost / CampaignBudget * 100, 1) AS utilization_pct
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime = :yesterday
  AND Cost >= CampaignBudget * :utilization_threshold
ORDER BY Cost DESC;
