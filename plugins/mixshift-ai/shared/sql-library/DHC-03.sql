-- ID: DHC-03
-- Purpose: VC ordered revenue windows (T-1, T-7, T-30, MTD) from
--          vendor_sales_manufacturing_asin, and the ad spend from
--          campaignmetric over exactly the same days, in a single query.
-- Params: :seller_id, :yesterday, :run_date, :month_start, :vc_lag
-- Consumers: daily-health-check (Batch B alternative, VC accounts)
-- Tier: 1
--
-- Every window ends at vc_window_end: the latest date that has loaded in
-- vendor_sales_manufacturing_asin for this seller, no later than yesterday.
-- Vendor Central data lands with a lag that varies (2 days is common, longer
-- happens), so the windows follow the data, not a fixed lag. The vc_lag
-- param is only the fallback when no VC row has loaded at all: then the
-- windows end at run_date minus vc_lag days.
--
--   T-1  = vc_window_end
--   T-7  = vc_window_end - 6 days .. vc_window_end
--   T-30 = vc_window_end - 29 days .. vc_window_end
--   MTD  = month_start .. vc_window_end (NULL when vc_window_end is before
--          month_start: no VC day of this month has loaded yet)
--
-- The spend_*_vc_window columns cover the same days as the matching
-- ordered_rev_* columns, so VC TACOS = spend_*_vc_window / ordered_rev_*.
-- Do not divide DHC-01's *_tacos_window columns by these: those end at
-- yesterday - 1 day, the SC convention. Use this INSTEAD of DHC-02 for VC.

SELECT
    w.vc_window_end,

    -- T-1 Ordered Revenue and spend (the latest loaded VC day)
    (SELECT COALESCE(SUM(OrderedRevenueAmount), 0)
       FROM vendor_sales_manufacturing_asin
      WHERE SellerID = :seller_id
        AND DateTime = w.vc_window_end) AS ordered_rev_t1,
    (SELECT COALESCE(SUM(Cost), 0)
       FROM campaignmetric
      WHERE SellerID = :seller_id
        AND DateTime = w.vc_window_end) AS spend_t1_vc_window,

    -- T-7 totals
    (SELECT COALESCE(SUM(OrderedRevenueAmount), 0)
       FROM vendor_sales_manufacturing_asin
      WHERE SellerID = :seller_id
        AND DateTime >= DATE_SUB(w.vc_window_end, INTERVAL 6 DAY)
        AND DateTime <= w.vc_window_end) AS ordered_rev_t7_total,
    (SELECT COALESCE(SUM(Cost), 0)
       FROM campaignmetric
      WHERE SellerID = :seller_id
        AND DateTime >= DATE_SUB(w.vc_window_end, INTERVAL 6 DAY)
        AND DateTime <= w.vc_window_end) AS spend_t7_vc_window,

    -- T-30 totals
    (SELECT COALESCE(SUM(OrderedRevenueAmount), 0)
       FROM vendor_sales_manufacturing_asin
      WHERE SellerID = :seller_id
        AND DateTime >= DATE_SUB(w.vc_window_end, INTERVAL 29 DAY)
        AND DateTime <= w.vc_window_end) AS ordered_rev_t30_total,
    (SELECT COALESCE(SUM(Cost), 0)
       FROM campaignmetric
      WHERE SellerID = :seller_id
        AND DateTime >= DATE_SUB(w.vc_window_end, INTERVAL 29 DAY)
        AND DateTime <= w.vc_window_end) AS spend_t30_vc_window,

    -- MTD (bounded above by vc_window_end on both sides)
    CASE WHEN w.vc_window_end >= :month_start THEN
    (SELECT COALESCE(SUM(OrderedRevenueAmount), 0)
       FROM vendor_sales_manufacturing_asin
      WHERE SellerID = :seller_id
        AND DateTime >= :month_start
        AND DateTime <= w.vc_window_end) END AS ordered_rev_mtd,
    CASE WHEN w.vc_window_end >= :month_start THEN
    (SELECT COALESCE(SUM(Cost), 0)
       FROM campaignmetric
      WHERE SellerID = :seller_id
        AND DateTime >= :month_start
        AND DateTime <= w.vc_window_end) END AS spend_mtd_vc_window
FROM (
    SELECT COALESCE(MAX(DateTime), DATE_SUB(:run_date, INTERVAL :vc_lag DAY)) AS vc_window_end
    FROM vendor_sales_manufacturing_asin
    WHERE SellerID = :seller_id
      AND DateTime <= :yesterday
) w;
