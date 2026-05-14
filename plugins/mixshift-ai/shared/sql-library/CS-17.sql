-- ID: CS-17
-- Purpose: Same-SKU vs Other-SKU cross-sell ratio per campaign type for
--          the most recent full month (productadmetric).
-- Params: :seller_id
-- Consumers: account-cold-start (Query 13)
-- Tier: 1

SELECT CampaignType,
       ROUND(SUM(Cost), 2) AS spend,
       ROUND(SUM(Sales), 2) AS total_attributed_sales,
       ROUND(SUM(SameSKUSales), 2) AS same_sku_sales,
       ROUND(SUM(Sales) - SUM(SameSKUSales), 2) AS other_sku_sales,
       ROUND(SUM(SameSKUSales) / NULLIF(SUM(Sales), 0) * 100, 2) AS pct_same_sku
FROM productadmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND DateTime <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
GROUP BY CampaignType;
