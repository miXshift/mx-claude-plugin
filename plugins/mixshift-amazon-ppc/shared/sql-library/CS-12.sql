-- ID: CS-12
-- Purpose: VC item group revenue concentration for the most recent full
--          month (sub_brand x item_group breakdown).
-- Params: :seller_id
-- Consumers: account-cold-start (Query 8, VC only)
-- Tier: 1

SELECT vi.CustomBrand AS sub_brand,
       vi.ItemGroup   AS item_group,
       ROUND(SUM(vs.OrderedRevenueAmount), 2) AS ordered_revenue,
       SUM(vs.OrderedUnits) AS units
FROM vendor_sales_manufacturing_asin vs
JOIN vendor_items vi
  ON vs.Asin = vi.Asin
 AND vs.SellerID = vi.SellerID
WHERE vs.SellerID = :seller_id
  AND vi.CustomBrand != ''
  AND vi.ItemGroup != ''
  AND vs.DateTime >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND vs.DateTime <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
GROUP BY vi.CustomBrand, vi.ItemGroup
ORDER BY vi.CustomBrand, ordered_revenue DESC;
