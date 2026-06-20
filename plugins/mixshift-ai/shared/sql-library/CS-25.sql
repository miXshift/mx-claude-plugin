-- ID: CS-25
-- Purpose: VC catalog completeness — list ASINs missing ItemGroup tagging.
-- Params: :seller_id_list
-- Consumers: brand-context (Query 19, blank ItemGroup pull)
-- Tier: 1

SELECT Asin, ItemName, CustomBrand
FROM vendor_items
WHERE SellerID IN (:seller_id_list)
  AND (ItemGroup IS NULL OR ItemGroup = '')
ORDER BY Asin;
