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
-- mws_inventory_health is a snapshot-style table; the subquery picks the
-- latest snapshot per ASIN and the outer query filters that snapshot's flags
-- so resolved/old stockout windows don't surface as current state.
--
-- 2026-06-12 fix (verified on the live warehouse across all active SP-API
-- sellers): drop the FulfillmentChannel = 'AFN' filter and stop reading
-- SellableQuantity.
--   * FulfillmentChannel is the SP-API region (AMAZON_NA / AMAZON_EU / a few
--     '') plus a constantly-rewritten 'DEFAULT' bucket that never carries
--     stock. 'AFN' matches ZERO rows, so the old filter returned nothing.
--   * SellableQuantity / TotalQuantity are deprecated (always 0). The live
--     sellable count is `Available` (a varchar; '' when the row carries none,
--     which is exactly the noise DEFAULT rows).
--   * Alert uses '' (not NULL) for "no alert", so the at-risk test is
--     Alert <> '' rather than IS NOT NULL.
-- The latest-snapshot anchor is restricted to rows that actually carry
-- Available, so a fresh blank DEFAULT row can't win MAX(DateTime) and blank
-- the result. A seller is region-scoped (one marketplace per SellerID), so
-- this is channel-agnostic. Output column names are unchanged
-- (SellableQuantity is now sourced from Available) to keep the
-- daily-health-check consumer stable. Pattern proven by BRAIN-HERO-SC in the
-- mx-legacy-auth query pack.

SELECT h.ASIN,
       h.ItemName,
       CAST(NULLIF(h.Available, '') AS UNSIGNED) AS SellableQuantity,
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
      AND NULLIF(Available, '') IS NOT NULL
    GROUP BY ASIN
) latest ON h.ASIN = latest.ASIN AND h.DateTime = latest.max_dt
WHERE h.SellerID = :seller_id
  AND NULLIF(h.Available, '') IS NOT NULL
  AND (h.DaysOfSupply < :days_of_supply_threshold
       OR (h.Alert IS NOT NULL AND h.Alert <> '')
       OR CAST(NULLIF(h.Available, '') AS UNSIGNED) = 0)
ORDER BY h.DaysOfSupply ASC;
