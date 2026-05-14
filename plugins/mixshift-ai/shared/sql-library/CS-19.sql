-- ID: CS-19
-- Purpose: VC brand catalog — distinct (CustomBrand, Brand, ItemGroup)
--          combinations with ASIN counts.
-- Params: :seller_id_list
-- Consumers: account-cold-start (Query 15, VC path)
-- Tier: 1

SELECT DISTINCT
       vi.CustomBrand,
       vi.Brand,
       vi.ItemGroup,
       COUNT(DISTINCT vi.Asin) AS asin_count
FROM vendor_items vi
WHERE vi.SellerID IN (:seller_id_list)
  AND vi.CustomBrand IS NOT NULL AND vi.CustomBrand != ''
GROUP BY vi.CustomBrand, vi.Brand, vi.ItemGroup
ORDER BY vi.CustomBrand, vi.ItemGroup;
