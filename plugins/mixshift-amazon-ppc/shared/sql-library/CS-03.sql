-- ID: CS-03
-- Purpose: VC 24-month revenue baseline by month — ordered revenue and
--          ordered units.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 2, VC path)
-- Tier: 1
--
-- Source: vendor_sales_manufacturing_asin. No sessions/CVR for VC.

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       ROUND(SUM(OrderedRevenueAmount), 2) AS ordered_revenue,
       SUM(OrderedUnits) AS ordered_units
FROM vendor_sales_manufacturing_asin
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
