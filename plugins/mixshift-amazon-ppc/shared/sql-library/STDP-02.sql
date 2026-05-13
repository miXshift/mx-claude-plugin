-- ID: STDP-02
-- Purpose: Build the manual ASIN-target dedup mask — every enabled,
--          positive ASIN-targeting row across the account.
-- Params: :seller_id
-- Consumers: search-term-data-pull (Phase 0b)
-- Tier: 1
--
-- Caller strips the asin* wrapper from KeywordText to populate
-- manual_targets = { strip_asin_wrapper(row.KeywordText) }.
-- Used to dedupe Phase 1 Stream 2 (PAT) rows so we never re-recommend
-- harvesting an ASIN that is already manually targeted.

SELECT CampaignName, CampaignID, AdGroupName, AdGroupID,
       KeywordText, MatchType, State
FROM keywordtargeting
WHERE SellerID = :seller_id
  AND State = 'enabled'
  AND IsNegative = 0
  AND MatchType IN ('asinSameAs', 'asinExpanded');
