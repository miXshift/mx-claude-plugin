-- ID: DHC-12
-- Purpose: Inventory follow-up — surface ASINs at risk (low days of supply,
--          alerts, or zero sellable). Run when an item group shows
--          conversion drop with clicks present.
-- Params: :seller_id, :days_of_supply_threshold
-- Consumers: daily-health-check (diagnostic follow-up)
-- Tier: 1
--
-- Default :days_of_supply_threshold = 14.

SELECT ASIN, ItemName, SellableQuantity, DaysOfSupply, Alert,
       WeeksOfCoverT7, SalesShippedLast7Days
FROM mws_inventory_health
WHERE SellerID = :seller_id
  AND (DaysOfSupply < :days_of_supply_threshold
       OR Alert IS NOT NULL
       OR SellableQuantity = 0)
ORDER BY DaysOfSupply ASC;
