-- ID: STN-04
-- Purpose: Theme analysis — pull all search terms containing a theme
--          substring (e.g., 'leather', 'kids') with spend / sales / orders
--          aggregated per (campaign, search term).
-- Params: :seller_id, :theme_pattern
-- Consumers: search-term-negation (Theme Analysis)
-- Tier: 1
--
-- :theme_pattern is a LIKE expression assembled by the caller, e.g.
-- '%leather%'. Used to assess whether a candidate theme should be promoted
-- to a phrase negative or kept as a per-term review.

SELECT
    CampaignName,
    SearchTerm,
    SUM(Clicks)                          AS clicks,
    ROUND(SUM(Cost), 2)                  AS cost,
    ROUND(SUM(AttributedSales14day), 2)  AS sales14d,
    SUM(AttributedConversions14day)      AS orders
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND SearchTerm LIKE :theme_pattern
GROUP BY CampaignName, SearchTerm
ORDER BY cost DESC;
