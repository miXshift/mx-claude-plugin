-- ID: CS-21
-- Purpose: Enabled negative-keyword inventory by campaign / ad group.
-- Params: :seller_id, :limit
-- Consumers: brand-context (Query 16)
-- Tier: 1
--
-- Default :limit = 1000.

SELECT
    CampaignName,
    AdGroupName,
    KeywordText,
    MatchType,
    State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND State = 'enabled'
  AND IsNegative = 1
ORDER BY CampaignName, AdGroupName, KeywordText
LIMIT :limit;
