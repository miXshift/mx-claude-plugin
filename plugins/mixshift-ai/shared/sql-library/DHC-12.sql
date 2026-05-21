-- ID: DHC-12
-- Purpose: Inventory follow-up — surface ASINs at risk (low days of supply,
--          alerts, or zero sellable). Run when an item group shows
--          conversion drop with clicks present.
-- Params: :seller_id, :days_of_supply_threshold
-- Consumers: daily-health-check (diagnostic follow-up)
-- Tier: 1
--
-- Default :days_of_supply_threshold = 14.
--
-- 2026-05-21 fix: mws_inventory_health is a snapshot-style table with
-- historical rows (the same ASIN appears once per snapshot day). The
-- previous SQL had no DateTime filter, so it returned every historical
-- "in trouble" row mixed with current state — including stockout windows
-- that have long since resolved. The AOP test surfaced this when every
-- active SKU appeared as "SellableQuantity = 0" despite verified in-stock
-- + DaysOfSupply > 100 on the same row (cross-contamination from old
-- snapshots).
--
-- The subquery picks the latest snapshot per ASIN; outer query filters
-- that snapshot's flags. Mirrors CS-29's pattern but for live state
-- instead of trailing-365d history. Also adds FulfillmentChannel = 'AFN'
-- to match CS-29 — MFN inventory doesn't carry the same Sellable/DoS/
-- Alert semantics.

SELECT h.ASIN,
       h.ItemName,
       h.SellableQuantity,
       h.DaysOfSupply,
       h.Alert,
       h.WeeksOfCoverT7,
       h.SalesShippedLast7Days,
       h.DateTime AS snapshot_date
FROM mws_inventory_health h
JOIN (
    SELECT ASIN, MAX(DateTime) AS max_dt
    FROM mws_inventory_health
    WHERE SellerID = :seller_id
      AND FulfillmentChannel = 'AFN'
    GROUP BY ASIN
) latest ON h.ASIN = latest.ASIN AND h.DateTime = latest.max_dt
WHERE h.SellerID = :seller_id
  AND h.FulfillmentChannel = 'AFN'
  AND (h.DaysOfSupply < :days_of_supply_threshold
       OR h.Alert IS NOT NULL
       OR h.SellableQuantity = 0)
ORDER BY h.DaysOfSupply ASC;
