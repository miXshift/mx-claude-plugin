-- ID: ANEG-03
-- Purpose: Phase 1 manual ASIN-target suppression set — currently enabled
--          positive (non-negative) targets on the account.
-- Params: :seller_id
-- Consumers: asin-target-negation (Phase 1)
-- Tier: 1
--
-- Caller intersects normalized window ASINs against this set; matches route
-- to "Protected Manual Targets" and skip negation review.

SELECT
    CampaignID, CampaignName, AdGroupID, AdGroupName,
    KeywordText, MatchType, IsNegative, State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND State = 'enabled'
  AND IsNegative = 0;
