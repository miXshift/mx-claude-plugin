-- ID: CS-27
-- Purpose: Campaign-objective completeness check — surface T-30 spending
--          campaigns whose CampaignName lacks any of the canonical
--          objective tags (CONQ, DISC, PROF, RSCH, HDLN, SBV, SD).
-- Params: :seller_id_list, :spend_floor, :limit
-- Consumers: brand-context (Query 19, campaign objective completeness)
-- Tier: 1
--
-- Default :spend_floor = 5, :limit = 30.

SELECT
    CampaignName,
    CampaignType,
    ROUND(SUM(Cost), 2) AS t30_spend,
    ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS t30_acos
FROM campaignmetric
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
  AND CampaignName NOT REGEXP '-CONQ-|-DISC-|-PROF-|-RSCH-|-HDLN-|-SBV-|-SD-'
GROUP BY CampaignName, CampaignType
HAVING t30_spend > :spend_floor
ORDER BY t30_spend DESC
LIMIT :limit;
