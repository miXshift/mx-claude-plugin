-- ID: STN-01
-- Purpose: Window search-term performance pull at
--          (campaign, ad group, keyword, search term, match type) grain.
--          Returns impressions, clicks, cost, 14d attributed sales, ACOS,
--          and 14d attributed orders for relevance / negation review.
-- Params: :seller_id, :start_date, :end_date
-- Consumers: search-term-negation (Data Preparation)
-- Tier: 1
--
-- General-purpose window pull. For the canonical multi-stream pull used by
-- the data-pull skill, see STDP-03.

SELECT
    CampaignName, AdGroupName, KeywordText, SearchTerm, MatchType,
    SUM(Impressions)                                       AS impressions,
    SUM(Clicks)                                            AS clicks,
    ROUND(SUM(Cost), 2)                                    AS cost,
    ROUND(SUM(AttributedSales14day), 2)                    AS sales14d,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2) AS ACOS,
    SUM(AttributedConversions14day)                        AS orders
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND DateTime >= :start_date
  AND DateTime <= :end_date
GROUP BY CampaignName, AdGroupName, KeywordText, SearchTerm, MatchType
ORDER BY cost DESC;
