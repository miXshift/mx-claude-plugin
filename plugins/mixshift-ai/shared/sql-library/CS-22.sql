-- ID: CS-22
-- Purpose: Per-campaign T-30 budget utilization — surfaces campaigns
--          consuming the largest share of their daily budget cap.
-- Params: :seller_id, :limit
-- Consumers: brand-context (Query 17, budget utilization)
-- Tier: 1
--
-- Default :limit = 50.

SELECT
    CampaignName,
    CampaignType,
    ROUND(SUM(Cost), 2) AS t30_spend,
    ROUND(AVG(CampaignBudget), 2) AS daily_budget,
    ROUND(AVG(CampaignBudget) * 30, 2) AS t30_budget_cap,
    CASE
        WHEN AVG(CampaignBudget) > 0
            THEN ROUND(SUM(Cost) / NULLIF(AVG(CampaignBudget) * 30, 0) * 100, 1)
        ELSE NULL
    END AS budget_utilization_pct
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY CampaignName, CampaignType
HAVING t30_spend > 0
ORDER BY t30_spend DESC
LIMIT :limit;
