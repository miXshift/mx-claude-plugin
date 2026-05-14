-- ID: CS-18
-- Purpose: SC ads-as-percent-of-total-sales stability check by month —
--          monthly ACOS, TACOS, and ads-share derived from
--          business_reports_dpst_date (total) joined to campaignmetric
--          (ad).
-- Params: :seller_id
-- Consumers: account-cold-start (Query 14, SC only)
-- Tier: 1

SELECT br.month,
       ROUND(cm.ad_sales / NULLIF(br.total_sales, 0) * 100, 1) AS ads_pct_of_sales,
       ROUND(cm.spend    / NULLIF(cm.ad_sales,    0) * 100, 2) AS acos_pct,
       ROUND(cm.spend    / NULLIF(br.total_sales, 0) * 100, 2) AS tacos_pct
FROM (
    SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
           ROUND(SUM(SalesAmount), 2) AS total_sales
    FROM business_reports_dpst_date
    WHERE SellerID = :seller_id
      AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 14 MONTH)
    GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
) br
LEFT JOIN (
    SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
           ROUND(SUM(Cost), 2)  AS spend,
           ROUND(SUM(Sales), 2) AS ad_sales
    FROM campaignmetric
    WHERE SellerID = :seller_id
      AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 14 MONTH)
    GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
) cm ON br.month = cm.month
ORDER BY br.month;
