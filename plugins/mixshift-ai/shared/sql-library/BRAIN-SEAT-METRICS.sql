-- ID: BRAIN-SEAT-METRICS
-- Purpose: Per-seat trailing-window USD-normalized RETAIL REVENUE + AD SPEND,
--          one row per seller seat, so the brain can pick a brand's PRIMARY
--          seat by economic activity (revenue + spend, high->low) instead of
--          the registry heuristic (SC>VC, US-first), which mis-ranks
--          VC-primary brands.
-- Params: :seller_ids  (a brand's seller seat ids; numeric IN-list)
-- Consumers: brand-brain-fetch
-- Tier: 1
-- Dispatch: named  (PROD body lives server-side in the mx-legacy-auth query
--          pack, keyed by this id; this committed .sql is the DEV-FALLBACK
--          read via MIXSHIFT_QUERY_PACK_DIR=<...>/shared/sql-library and the
--          byte-diff reference for the server-side entry, mirroring DHC-01.)
--
-- Returns one row per supplied seat: seller_id, usd_revenue, usd_spend.
-- Caller ranks by (usd_revenue + usd_spend) DESC (lib/brain/fetch.ts
-- pickPrimarySeatByMetrics). Seats absent from the metric tables (dormant /
-- not-yet-pulled) return 0/0 and naturally sink to the bottom.
--
-- WINDOW: trailing TRAILING_WINDOW_DAYS = 30 days. One constant, applied
-- identically to spend (campaignmetric) and revenue (SC + VC) so the two
-- sides of the ranking score cover the same period. To change the window,
-- edit all three INTERVAL clauses below (kept inline because the named-query
-- backend binds only :seller_ids; the window is a fixed query constant, not a
-- caller param).
--
-- CHANNEL: a seat is SC or VC per seller.MerchantType ('Vendor' => VC, else
-- SC). SC retail revenue = business_reports_dpst_date.SalesAmount; VC retail
-- revenue = vendor_sales_manufacturing_asin.OrderedRevenueAmount. A seat reads
-- exactly one revenue source (its channel's); the other is NULL->0.
--
-- CURRENCY: amounts are each marketplace's LOCAL currency. currency_metric is
-- keyed (MarketPlaceID, DateTime) and is SPARSE in time (not daily), so we do
-- NOT equi-join on metric date — we take the LATEST rate row per marketplace
-- and use its USD column, which is that marketplace's local->USD multiplier
-- (verified 2026-06-23: UK/GBP row USD=1.32, EUR row USD=1.146, CAD row
-- USD=0.707, US row USD=1.0 — i.e. usd = local * currency_metric.USD).
-- Marketplaces absent from currency_metric COALESCE to 1.0 (no-op convert).

WITH cm_latest AS (
    SELECT cm.MarketPlaceID, cm.USD AS local_to_usd
    FROM currency_metric cm
    JOIN (
        SELECT MarketPlaceID, MAX(DateTime) AS mx
        FROM currency_metric
        GROUP BY MarketPlaceID
    ) m ON m.MarketPlaceID = cm.MarketPlaceID AND m.mx = cm.DateTime
),
seats AS (
    SELECT
        s.ID AS seller_id,
        CASE WHEN s.MerchantType = 'Vendor' THEN 'VC' ELSE 'SC' END AS channel,
        COALESCE(fx.local_to_usd, 1.0) AS to_usd
    FROM seller s
    LEFT JOIN cm_latest fx ON fx.MarketPlaceID = s.MarketPlaceID
    WHERE s.ID IN (:seller_ids)
),
spend AS (
    SELECT SellerID AS seller_id, SUM(Cost) AS local_spend
    FROM campaignmetric
    WHERE SellerID IN (:seller_ids)
      AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY SellerID
),
rev_sc AS (
    SELECT SellerID AS seller_id, SUM(SalesAmount) AS local_rev
    FROM business_reports_dpst_date
    WHERE SellerID IN (:seller_ids)
      AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY SellerID
),
rev_vc AS (
    SELECT SellerID AS seller_id, SUM(OrderedRevenueAmount) AS local_rev
    FROM vendor_sales_manufacturing_asin
    WHERE SellerID IN (:seller_ids)
      AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    GROUP BY SellerID
)
SELECT
    seats.seller_id,
    ROUND(COALESCE(
        CASE WHEN seats.channel = 'VC' THEN rvc.local_rev ELSE rsc.local_rev END,
        0) * seats.to_usd, 2) AS usd_revenue,
    ROUND(COALESCE(sp.local_spend, 0) * seats.to_usd, 2) AS usd_spend
FROM seats
LEFT JOIN spend  sp  ON sp.seller_id  = seats.seller_id
LEFT JOIN rev_sc rsc ON rsc.seller_id = seats.seller_id
LEFT JOIN rev_vc rvc ON rvc.seller_id = seats.seller_id
ORDER BY (
    COALESCE(CASE WHEN seats.channel = 'VC' THEN rvc.local_rev ELSE rsc.local_rev END, 0)
    + COALESCE(sp.local_spend, 0)
) * seats.to_usd DESC;
