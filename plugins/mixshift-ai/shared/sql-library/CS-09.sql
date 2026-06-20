-- ID: CS-09
-- Purpose: VC sub-brand and item group structure with ASIN counts and
--          target ACOS averages.
-- Params: :seller_id
-- Consumers: brand-context (Query 6, VC path)
-- Tier: 1

SELECT CustomBrand, ItemGroup, COUNT(*) AS asin_count,
       AVG(TargetACOS) * 100 AS target_acos_pct
FROM vendor_items
WHERE SellerID = :seller_id
  AND CustomBrand != ''
  AND ItemGroup != ''
GROUP BY CustomBrand, ItemGroup
ORDER BY CustomBrand, ItemGroup;
