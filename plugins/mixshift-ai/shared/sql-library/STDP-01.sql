-- ID: STDP-01
-- Purpose: Build the existing-negatives exclusion mask — every enabled
--          negative keyword on the account.
-- Params: :seller_id
-- Consumers: search-term-data-pull (Phase 0a)
-- Tier: 1
--
-- Caller materializes three views from the result:
--   campaign_negatives     {(CampaignID, KeywordText.lower(), MatchType)}
--   adgroup_negatives      {(CampaignID, AdGroupID, KeywordText.lower(), MatchType)}
--   existing_negatives_by_phrase  root terms already phrase-negated

SELECT CampaignID, CampaignName, AdGroupID, AdGroupName,
       KeywordText, MatchType, IsNegative, State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND IsNegative = 1
  AND State = 'enabled';
