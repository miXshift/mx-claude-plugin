-- ID: CS-04
-- Purpose: 24-month ACOS baseline by month — total spend, ad sales, ACOS%.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 3)
-- Tier: 1

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       ROUND(SUM(Cost), 2) AS spend,
       ROUND(SUM(Sales), 2) AS ad_sales,
       ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS acos_pct
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
