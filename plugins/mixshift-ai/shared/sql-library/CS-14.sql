-- ID: CS-14
-- Purpose: Brand vs NonBrand spend split (trailing 6 months), classified
--          via CampaignName tag patterns (-PROF-BRAND-, -HDLN-PROF-BRAND-,
--          -HDLN-BRAND-).
-- Params: :seller_id
-- Consumers: account-cold-start (Query 10)
-- Tier: 1

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       CASE
           WHEN CampaignName LIKE '%-PROF-BRAND-%'
             OR CampaignName LIKE '%-HDLN-PROF-BRAND-%'
             OR CampaignName LIKE '%-HDLN-BRAND-%' THEN 'Brand'
           ELSE 'NonBrand'
       END AS brand_type,
       ROUND(SUM(Cost), 2) AS spend,
       ROUND(SUM(Sales), 2) AS ad_sales,
       ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS acos_pct
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m'), brand_type
ORDER BY month, brand_type;
