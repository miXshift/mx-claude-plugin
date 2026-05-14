-- ID: CS-26
-- Purpose: T-90 ordered revenue for a specified ASIN list — used to filter
--          blank-ItemGroup ASINs (CS-25) down to the active subset.
-- Params: :seller_id_list
-- Consumers: account-cold-start (Query 19, T-90 revenue check)
-- Tier: 1

SELECT Asin, ROUND(SUM(OrderedRevenueAmount), 2) AS t90_revenue
FROM vendor_sales_manufacturing_asin
WHERE SellerID IN (:seller_id_list)
  AND Asin IN (
      SELECT Asin
      FROM vendor_items
      WHERE SellerID IN (:seller_id_list)
        AND (ItemGroup IS NULL OR ItemGroup = '')
  )
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
GROUP BY Asin
HAVING t90_revenue > 0;
