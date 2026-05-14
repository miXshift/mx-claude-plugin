-- ID: DHC-03
-- Purpose: VC ordered revenue windows (T-1, T-7, T-30, MTD) from
--          vendor_sales_manufacturing_asin in a single query.
-- Params: :seller_id, :yesterday, :month_start, :vc_lag
-- Consumers: daily-health-check (Batch B alternative, VC accounts)
-- Tier: 1
--
-- VC accounts lag :vc_lag days (typically 2). Confirm last available date
-- from brand context before running. Use this INSTEAD of DHC-02 for VC.

SELECT
    -- T-1 Ordered Revenue
    SUM(CASE WHEN DateTime = DATE_SUB(:yesterday, INTERVAL :vc_lag DAY)
             THEN OrderedRevenueAmount ELSE 0 END) AS ordered_rev_t1,

    -- T-7 total
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 6 + :vc_lag DAY)
              AND DateTime <= DATE_SUB(:yesterday, INTERVAL :vc_lag DAY)
             THEN OrderedRevenueAmount ELSE 0 END) AS ordered_rev_t7_total,

    -- T-30 total
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 29 + :vc_lag DAY)
              AND DateTime <= DATE_SUB(:yesterday, INTERVAL :vc_lag DAY)
             THEN OrderedRevenueAmount ELSE 0 END) AS ordered_rev_t30_total,

    -- MTD
    SUM(CASE WHEN DateTime >= :month_start
             THEN OrderedRevenueAmount ELSE 0 END) AS ordered_rev_mtd
FROM vendor_sales_manufacturing_asin
WHERE SellerID = :seller_id
  AND DateTime >= LEAST(:month_start, DATE_SUB(:yesterday, INTERVAL 30 + :vc_lag DAY));
