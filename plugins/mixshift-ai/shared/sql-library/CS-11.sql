-- ID: CS-11
-- Purpose: VC sub-brand monthly revenue split (T-12 months) joined to
--          vendor_items for CustomBrand attribution.
-- Params: :seller_id
-- Consumers: brand-context (Query 7, VC only)
-- Tier: 1

SELECT vi.CustomBrand AS sub_brand,
       DATE_FORMAT(vs.DateTime, '%Y-%m') AS month,
       ROUND(SUM(vs.OrderedRevenueAmount), 2) AS ordered_revenue,
       SUM(vs.OrderedUnits) AS ordered_units
FROM vendor_sales_manufacturing_asin vs
JOIN vendor_items vi
  ON vs.Asin = vi.Asin
 AND vs.SellerID = vi.SellerID
WHERE vs.SellerID = :seller_id
  AND vi.CustomBrand != ''
  AND vs.DateTime >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
GROUP BY vi.CustomBrand, DATE_FORMAT(vs.DateTime, '%Y-%m')
ORDER BY month, sub_brand;
