-- ID: CS-29
-- Purpose: Inventory-health historical snapshots for stockout window detection.
--          Trailing 365 days, FBA-only. Pre-filtered to "in trouble" rows so
--          enrich-context.py only has to group consecutive dates per ASIN to
--          form contiguous OOS windows.
-- Params: :seller_id_list, :days_of_supply_threshold
-- Consumers: account-cold-start (v2.3 enrichment)
-- Tier: 1
--
-- Default :days_of_supply_threshold = 14 (matches DHC-12).
-- VC limitation: data is FBA-only; MFN inventory not tracked here. Renderer
-- annotates the rendered output with this caveat for VC accounts.
--
-- Pattern mirrors DHC-12 (live stockout follow-up); adds DateTime filter for
-- historical reconstruction and a date-grouping convenience column.

SELECT
    DATE(DateTime)         AS snapshot_date,
    ASIN,
    ItemName,
    SellableQuantity,
    DaysOfSupply,
    Alert,
    FulfillmentChannel,
    WeeksOfCoverT7,
    SalesShippedLast7Days
FROM mws_inventory_health
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
  AND DateTime <  CURDATE()
  AND FulfillmentChannel = 'AFN'
  AND (SellableQuantity = 0
       OR Alert IS NOT NULL
       OR DaysOfSupply < :days_of_supply_threshold)
ORDER BY ASIN, snapshot_date;
