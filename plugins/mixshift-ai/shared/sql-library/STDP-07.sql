-- ID: STDP-07
-- Purpose: Lifetime performance — aggregate per ASIN target for Stream 2
--          (Product Attribute Targeting).
-- Params: :seller_id, :asin_target_list
-- Consumers: search-term-data-pull (Phase 2d)
-- Tier: 1
--
-- :asin_target_list is the unique KeywordText list from Phase 1 Stream
-- 2. ASIN-stream item-group/location context comes from Phase 1 Stream 2
-- location data — not derived again here.

SELECT
    KeywordText AS asin_target,
    SUM(Cost)   AS lifetime_spend,
    SUM(Sales)  AS lifetime_sales,
    SUM(Orders) AS lifetime_orders,
    CASE WHEN SUM(Sales) > 0
         THEN ROUND(SUM(Cost) / SUM(Sales) * 100, 1)
         ELSE NULL
    END AS lifetime_acos
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND recordType = 'Product Attribute Targeting'
  AND KeywordText IN (:asin_target_list)
GROUP BY KeywordText
ORDER BY lifetime_spend DESC;
