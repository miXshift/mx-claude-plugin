-- ID: STDP-06
-- Purpose: Lifetime performance — full specific-location grain (Stream 1).
--          One row per SearchTerm at one (Campaign, AdGroup, Keyword,
--          MatchType) so downstream skills can place a negative or
--          harvest at the precise correct location.
-- Params: :seller_id, :search_term_list
-- Consumers: search-term-data-pull (Phase 2c)
-- Tier: 1
--
-- This is the most granular lifetime view. Used by exact negation
-- (correct ad-group placement) and harvest extraction (which ad group
-- to credit).

-- Group by the STABLE ids (CampaignID, AdGroupID), not the names:
-- keywordtargetingmetric carries the as-of-day CampaignName/AdGroupName on
-- every daily row, so a renamed campaign/ad group would otherwise fragment one
-- location into several rows (each with only part of its lifetime spend/sales/
-- orders). MAX() picks a single representative name per id. (Same pattern as
-- ANEG-01.) The frozen MV this query used to read had pre-normalized names, so
-- this guard is new with the move to the live base table.
SELECT
    SearchTerm,
    MAX(CampaignName) AS CampaignName,
    CampaignID,
    MAX(AdGroupName)  AS AdGroupName,
    AdGroupID,
    KeywordText,
    MatchType,
    SUM(Cost)   AS lifetime_spend,
    SUM(Sales)  AS lifetime_sales,
    SUM(Orders) AS lifetime_orders,
    CASE WHEN SUM(Sales) > 0
         THEN ROUND(SUM(Cost) / SUM(Sales) * 100, 1)
         ELSE NULL
    END AS lifetime_acos
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND recordType = 'Keyword Targeting'
  AND SearchTerm IN (:search_term_list)
GROUP BY SearchTerm, CampaignID, AdGroupID, KeywordText, MatchType
ORDER BY SearchTerm, lifetime_spend DESC;
