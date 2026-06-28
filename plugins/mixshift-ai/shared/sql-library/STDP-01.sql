-- ID: STDP-01
-- Purpose: Build the existing-negatives exclusion mask — every enabled
--          negative KEYWORD (negativeExact + negativePhrase) on the account.
-- Params: :seller_id
-- Consumers: search-term-data-pull (Phase 0a)
-- Tier: 1
--
-- Caller materializes three views from the result:
--   campaign_negatives     {(CampaignID, KeywordText.lower(), MatchType)}
--   adgroup_negatives      {(CampaignID, AdGroupID, KeywordText.lower(), MatchType)}
--   existing_negatives_by_phrase  root terms already phrase-negated
--
-- KEYWORD negatives only. `asinSameAs` entries are negative ASIN/product
-- targets: they belong to the ASIN-target flow (mx-asin-target-negation /
-- STDP-02), never match a search term, and on high-negative accounts they
-- dominate the row count (observed: 43,770 asinSameAs of 57,464 total on one
-- account) — which blew the 50k service row cap and failed the whole pull.
-- Filtering to keyword match types fixes BOTH the correctness (a search-term
-- mask must not contain ASIN negatives) and the row cap.

SELECT CampaignID, CampaignName, AdGroupID, AdGroupName,
       KeywordText, MatchType, IsNegative, State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND IsNegative = 1
  AND State = 'enabled'
  AND MatchType IN ('negativeExact', 'negativePhrase');
