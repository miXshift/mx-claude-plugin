-- ID: CS-29
-- Purpose: Historical stockout-window detection. Emits one row per FBA
--          out-of-stock ASIN-day over the trailing 365 days, so
--          enrich-context only has to group consecutive dates per ASIN into
--          contiguous out-of-stock windows.
-- Params: :seller_id_list
-- Consumers: account-cold-start (v2.3 enrichment, harness stockout-windows.ts)
-- Tier: 1
--
-- 2026-06-14 re-point: source is now `mws_inventory_history`, NOT
-- `mws_inventory_health`. Health is a current-state table (overwritten per
-- pull, no accumulating daily history), so a trailing-365d query found
-- nothing there. mws_inventory_history carries real daily snapshots back
-- 14+ months with a LIVE `FulfillableQuantity` (int) — the right source for
-- historical OOS reconstruction.
--
-- An ASIN-day is out of stock when its total FBA fulfillable quantity is 0:
-- SUM(FulfillableQuantity) across the ASIN's FBA rows (SKUs/channels) for the
-- day, kept only when that total is 0. FBA-only via FulfillmentChannel <>
-- 'DEFAULT' (the DEFAULT bucket is merchant-fulfilled; 'AFN' is dead — see
-- DHC-12 / CS-16). DateTime is a DATE here (one snapshot per day).
-- VC limitation: FBA-sourced; MFN inventory not tracked.
--
-- Output column SellableQuantity (= summed FulfillableQuantity, always 0 for
-- emitted rows) is retained so the stockout-window consumer is unchanged: it
-- reads SellableQuantity = 0 as the `sellable_zero` signal. mws_inventory_
-- history has no DaysOfSupply / Alert columns, so the consumer's secondary
-- days_of_supply_low / alert_active signals simply don't fire (the health
-- "Alert" was marketing alerts — Low traffic / Low conversion — not stock
-- signals anyway). days_of_supply_threshold is no longer needed.

SELECT
    DATE(h.DateTime) AS snapshot_date,
    h.ASIN,
    MAX(h.ItemName) AS ItemName,
    SUM(h.FulfillableQuantity) AS SellableQuantity
FROM mws_inventory_history h
WHERE h.SellerID IN (:seller_id_list)
  AND h.DateTime >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
  AND h.DateTime <  CURDATE()
  AND h.FulfillmentChannel <> 'DEFAULT'
GROUP BY h.ASIN, DATE(h.DateTime)
HAVING SUM(h.FulfillableQuantity) = 0
ORDER BY h.ASIN, snapshot_date;
