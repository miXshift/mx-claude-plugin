-- ID: CS-29
-- Purpose: Inventory-health historical snapshots for stockout window detection.
--          Trailing 365 days. Pre-filtered to "in trouble" rows so
--          enrich-context.py only has to group consecutive dates per ASIN to
--          form contiguous OOS windows.
-- Params: :seller_id_list, :days_of_supply_threshold
-- Consumers: account-cold-start (v2.3 enrichment)
-- Tier: 1
--
-- Default :days_of_supply_threshold = 14 (matches DHC-12).
-- VC limitation: inventory health is FBA/SP-API-sourced; MFN inventory not
-- tracked here. Renderer annotates the rendered output with this caveat for
-- VC accounts.
--
-- 2026-06-12 fix (verified on the live warehouse, mirrors DHC-12): drop the
-- FulfillmentChannel = 'AFN' filter and stop reading SellableQuantity.
--   * 'AFN' matches ZERO rows — FulfillmentChannel is the SP-API region
--     (AMAZON_NA / AMAZON_EU / a few '') plus a blank 'DEFAULT' noise bucket.
--   * SellableQuantity / TotalQuantity are deprecated (always 0); the live
--     sellable count is `Available` (a varchar; '' on the noise DEFAULT rows).
--   * Alert uses '' (not NULL) for "no alert", so the test is Alert <> ''.
-- Keep only rows that actually carry Available so the blank DEFAULT rows
-- don't read as in-trouble. Output column names are unchanged
-- (SellableQuantity is now sourced from Available) to keep the cold-start
-- stockout-window consumer (harness enrichment/stockout-windows.ts) stable.
--
-- DATA NOTE: mws_inventory_health currently holds current-state snapshots,
-- not an accumulating daily history (only today's pull plus sparse prior
-- pulls exist), so this trailing-365d, excludes-today query yields little
-- until daily history builds up. The AFN/Available fix is still required for
-- correctness (without it the query is doubly broken). See
-- internal/BACKGROUND-DISCOVERY.md.

SELECT
    DATE(DateTime)         AS snapshot_date,
    ASIN,
    ItemName,
    CAST(NULLIF(Available, '') AS UNSIGNED) AS SellableQuantity,
    DaysOfSupply,
    Alert,
    FulfillmentChannel,
    WeeksOfCoverT7,
    SalesShippedLast7Days
FROM mws_inventory_health
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)
  AND DateTime <  CURDATE()
  AND NULLIF(Available, '') IS NOT NULL
  AND (CAST(NULLIF(Available, '') AS UNSIGNED) = 0
       OR (Alert IS NOT NULL AND Alert <> '')
       OR DaysOfSupply < :days_of_supply_threshold)
ORDER BY ASIN, snapshot_date;
