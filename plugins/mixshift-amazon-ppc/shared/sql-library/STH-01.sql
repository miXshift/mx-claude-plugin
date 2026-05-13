-- ID: STH-01
-- Purpose: Build the explicit-keyword exclusion mask — every enabled
--          positive keyword targeting row across exact/phrase/broad.
-- Params: :seller_id
-- Consumers: search-term-harvest (Step 1)
-- Tier: 1
--
-- Caller materializes explicit_keywords = {KeywordText.lower()} and uses it
-- to drop search terms already present in explicit targeting before
-- classifying Tier S harvest candidates.

SELECT DISTINCT
    KeywordText, MatchType, CampaignName, AdGroupName, State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND State = 'enabled'
  AND IsNegative = 0
  AND MatchType IN ('exact', 'phrase', 'broad');
