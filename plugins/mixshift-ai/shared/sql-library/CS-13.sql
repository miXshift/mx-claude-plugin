-- ID: CS-13
-- Purpose: VC monthly ASP (average selling price) by sub-brand and item
--          group across T-12 months — used as a promotional-pricing flag.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 9, VC only)
-- Tier: 1

SELECT vi.CustomBrand AS sub_brand,
       vi.ItemGroup   AS item_group,
       DATE_FORMAT(vs.DateTime, '%Y-%m') AS month,
       ROUND(SUM(vs.OrderedRevenueAmount) / NULLIF(SUM(vs.OrderedUnits), 0), 2) AS avg_asp
FROM vendor_sales_manufacturing_asin vs
JOIN vendor_items vi
  ON vs.Asin = vi.Asin
 AND vs.SellerID = vi.SellerID
WHERE vs.SellerID = :seller_id
  AND vi.CustomBrand != ''
  AND vi.ItemGroup != ''
  AND vs.DateTime >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
GROUP BY vi.CustomBrand, vi.ItemGroup, DATE_FORMAT(vs.DateTime, '%Y-%m')
ORDER BY sub_brand, item_group, month;
