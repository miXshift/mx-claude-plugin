-- ID: ANEG-04
-- Purpose: Phase 3 lifetime performance join by location (campaign + ad
--          group) for ASINs that passed PDP relevance review. Reads
--          keywordtargetingmetric only (Product Attribute Targeting rows).
-- Params: :seller_id, :window_asin_set, :window_asin_set_lower
-- Consumers: asin-target-negation (Phase 3)
-- Tier: 1
--
-- RULE: keywordtargetingmetric ONLY. Sponsored Products target search-term
-- rows can be duplicated across keywordtargetingmetric (recordType
-- 'Product Attribute Targeting') and targetexpressionsmetric, with the same
-- search term, campaign, ad group, spend, sales, orders and clicks. Never sum
-- the two tables (no UNION ALL then SUM, no join that adds their columns):
-- each duplicated row would count twice, and doubled lifetime orders can lift
-- a losing location over the lifetime-orders floor and off the loser list.
-- ANEG-04 and loser lists use keywordtargetingmetric alone (Sam 2026-11-09).
-- This replaces the earlier note that keywordtargetingmetric alone undercounts
-- manual CONQ/PROF asinSameAs targets.
--
-- :window_asin_set / :window_asin_set_lower are list params populated by the
-- skill model from ANEG-02 output: the ASINs as pulled, and the same ASINs
-- lower-cased. A row matches either list, so a letter-case difference in the
-- ASIN text cannot drop a location to zero rows (zero lifetime orders would
-- read as "never converted"). Each row is still counted once. Prefetch skips
-- this query unless the skill provides both lists via paramOverrides (or runs
-- it inline via `mixshift data query` after building the set).

SELECT
    SearchTerm                          AS target_asin,
    CampaignName,
    AdGroupName,
    ROUND(SUM(Cost), 2)                 AS lifetime_spend,
    ROUND(SUM(AttributedSales14day), 2) AS lifetime_sales,
    SUM(AttributedConversions14day)     AS lifetime_orders,
    SUM(Clicks)                         AS lifetime_clicks,
    CASE WHEN SUM(AttributedSales14day) > 0
         THEN ROUND(SUM(Cost) / SUM(AttributedSales14day) * 100, 1)
         ELSE NULL END                  AS lifetime_acos
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND recordType = 'Product Attribute Targeting'
  AND (SearchTerm IN (:window_asin_set)
       OR LOWER(SearchTerm) IN (:window_asin_set_lower))
GROUP BY SearchTerm, CampaignName, AdGroupName
ORDER BY target_asin, lifetime_spend DESC;
