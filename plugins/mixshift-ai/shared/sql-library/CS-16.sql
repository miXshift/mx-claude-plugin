-- ID: CS-16
-- Purpose: Inventory history check — surface structural stockout pattern
--          (low/zero fulfillable quantity rows per month) over the last
--          14 months.
-- Params: :seller_id
-- Consumers: brand-context (Query 12, SC only)
-- Tier: 1
--
-- 2026-05-21 update: removed the "empty-column stub" framing. The table
-- has data; the earlier note was incorrect. Use FulfillableQuantity
-- (sellable count, FBA semantic) instead of generic Quantity.
--
-- 2026-06-14 fix (verified on the live warehouse): the FBA filter was
-- FulfillmentChannel = 'AFN', which matches ZERO rows — channel here is the
-- SP-API region (AMAZON_NA / AMAZON_EU / AMAZON_FE, plus '' and a stray
-- 'Amazon') plus a 'DEFAULT' bucket = merchant-fulfilled (MFN) rows. So
-- 'AFN' returned nothing (the same dead-filter bug as DHC-12 / CS-29). Keep
-- FBA-only by excluding the MFN bucket (FulfillmentChannel <> 'DEFAULT')
-- rather than naming a dead channel; this matches CS-29's FBA-only intent.
--
-- Why FulfillableQuantity over Quantity: the bare `Quantity` field on
-- mws_inventory_history is total units (including reserved + inbound),
-- which doesn't reflect what's available to sell. FulfillableQuantity is
-- the operative metric for "are we actually able to fulfill orders."

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       COUNT(DISTINCT ASIN) AS asin_count,
       ROUND(AVG(FulfillableQuantity), 1) AS avg_fulfillable,
       SUM(CASE WHEN FulfillableQuantity <= 10 THEN 1 ELSE 0 END) AS low_qty_rows,
       SUM(CASE WHEN FulfillableQuantity = 0  THEN 1 ELSE 0 END) AS zero_qty_rows
FROM mws_inventory_history
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 14 MONTH)
  AND FulfillmentChannel <> 'DEFAULT'
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
