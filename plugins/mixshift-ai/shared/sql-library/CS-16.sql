-- ID: CS-16
-- Purpose: Inventory history check — surface structural stockout pattern
--          (low/zero quantity rows per month) over the last 14 months.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 12, SC only)
-- Tier: 1
--
-- Source: mws_inventory_history (column dump pending in tables.yaml; the
-- drift checker treats it as a stub with column verification skipped).

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       COUNT(DISTINCT ASIN) AS asin_count,
       ROUND(AVG(Quantity), 1) AS avg_qty,
       SUM(CASE WHEN Quantity <= 10 THEN 1 ELSE 0 END) AS low_qty_rows,
       SUM(CASE WHEN Quantity = 0  THEN 1 ELSE 0 END) AS zero_qty_rows
FROM mws_inventory_history
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 14 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
