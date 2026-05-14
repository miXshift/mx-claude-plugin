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

SELECT
    SearchTerm,
    CampaignName,
    CampaignID,
    AdGroupName,
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
FROM KW_Target_ST_report_MV
WHERE SellerID = :seller_id
  AND recordType = 'Keyword Targeting'
  AND SearchTerm IN (:search_term_list)
GROUP BY SearchTerm, CampaignName, CampaignID, AdGroupName, AdGroupID, KeywordText, MatchType
ORDER BY SearchTerm, lifetime_spend DESC;
