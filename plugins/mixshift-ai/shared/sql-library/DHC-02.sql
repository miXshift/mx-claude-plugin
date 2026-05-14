-- ID: DHC-02
-- Purpose: SC total sales windows (T-1, T-7, T-30, MTD) from
--          business_reports_dpst_date in a single query.
-- Params: :seller_id, :yesterday, :month_start
-- Consumers: daily-health-check (Batch B, SC accounts)
-- Tier: 1
--
-- SC total sales lag T-2 (one-day lag from T-1). The T-1 column here is
-- the T-2 ceiling. Window upper bound is DATE_SUB(:yesterday, 1 DAY) so
-- TACOS denominators line up against DHC-01's `*_tacos_window` columns.

SELECT
    -- T-1 Total Sales (T-2 date due to SC lag)
    SUM(CASE WHEN DateTime = DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN SalesAmount ELSE 0 END) AS total_sales_t1,

    -- T-7 total (T-7 through T-2)
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 7 DAY)
              AND DateTime <= DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN SalesAmount ELSE 0 END) AS total_sales_t7_total,

    -- T-30 total (T-30 through T-2)
    SUM(SalesAmount) AS total_sales_t30_total,

    -- MTD (MONTH_START through T-2)
    SUM(CASE WHEN DateTime >= :month_start
             THEN SalesAmount ELSE 0 END) AS total_sales_mtd_tacos
FROM business_reports_dpst_date
WHERE SellerID = :seller_id
  AND DateTime >= LEAST(:month_start, DATE_SUB(:yesterday, INTERVAL 30 DAY))
  AND DateTime <= DATE_SUB(:yesterday, INTERVAL 1 DAY);
