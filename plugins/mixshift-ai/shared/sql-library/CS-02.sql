-- ID: CS-02
-- Purpose: SC 24-month revenue baseline by month — total sales, units,
--          sessions, and CVR.
-- Params: :seller_id
-- Consumers: brand-context (Query 2, SC path)
-- Tier: 1
--
-- Source: business_reports_dpst_date. Column names: DateTime, SalesAmount,
-- UnitsOrdered, Sessions.

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       ROUND(SUM(SalesAmount), 2) AS ordered_revenue,
       SUM(UnitsOrdered) AS ordered_units,
       SUM(Sessions) AS sessions,
       ROUND(SUM(UnitsOrdered) / NULLIF(SUM(Sessions), 0) * 100, 2) AS cvr_pct
FROM business_reports_dpst_date
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 24 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
