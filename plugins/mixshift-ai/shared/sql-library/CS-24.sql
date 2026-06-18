-- ID: CS-24
-- Purpose: Objective Config classification at the campaign level for the
--          last 30 days — buckets each campaign into brand_defense /
--          discovery_auto / brand_conquest / conquest / awareness_sb /
--          awareness_sd / unknown via CampaignName tag patterns.
-- Params: :seller_id
-- Consumers: brand-context (Query 18)
-- Tier: 1

SELECT
    CampaignName,
    CampaignType,
    ROUND(SUM(Cost), 2) AS t30_spend,
    ROUND(SUM(Sales), 2) AS t30_sales,
    ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS t30_acos,
    CASE
        WHEN CampaignName LIKE '%-PROF-BRAND-%'
          OR CampaignName LIKE '%-HDLN-PROF-BRAND-%' THEN 'brand_defense'
        WHEN CampaignName LIKE '%-DISC-%'         THEN 'discovery_auto'
        WHEN CampaignName LIKE '%-CONQ-BRAND-%'   THEN 'brand_conquest'
        WHEN CampaignName LIKE '%-CONQ-%'         THEN 'conquest'
        WHEN CampaignName LIKE '%-HDLN-%'         THEN 'awareness_sb'
        WHEN CampaignName LIKE '%-SD-%'           THEN 'awareness_sd'
        ELSE 'unknown'
    END AS objective_class
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY CampaignName, CampaignType
HAVING t30_spend > 0
ORDER BY objective_class, t30_spend DESC;
