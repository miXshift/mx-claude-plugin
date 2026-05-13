-- ID: DHC-01
-- Purpose: Account-level spend/sales/orders aggregated across all DHC time
--          windows (T-1, T-7 total, T-30 total, MTD, plus T-2 and TACOS-
--          matched windows) in a single round trip.
-- Params: :seller_id, :yesterday, :month_start
-- Consumers: daily-health-check (Batch A)
-- Tier: 1
--
-- Returns a single row. Caller derives daily averages (T-7/7, T-30/30) and
-- ratios (ACOS, TACOS) downstream. TACOS-matched windows lag spend to T-2
-- so they can divide cleanly against business_reports_dpst_date sales.

SELECT
    -- T-1
    SUM(CASE WHEN DateTime = :yesterday THEN Cost   ELSE 0 END) AS spend_t1,
    SUM(CASE WHEN DateTime = :yesterday THEN Sales  ELSE 0 END) AS adsales_t1,
    SUM(CASE WHEN DateTime = :yesterday THEN Orders ELSE 0 END) AS orders_t1,

    -- T-7 total (divide by 7 or active days for daily avg)
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN Cost  ELSE 0 END) AS spend_t7_total,
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN Sales ELSE 0 END) AS adsales_t7_total,

    -- T-30 total (full window, also used for CI data)
    SUM(Cost)  AS spend_t30_total,
    SUM(Sales) AS adsales_t30_total,

    -- MTD (1st of month through yesterday)
    SUM(CASE WHEN DateTime >= :month_start THEN Cost  ELSE 0 END) AS spend_mtd,
    SUM(CASE WHEN DateTime >= :month_start THEN Sales ELSE 0 END) AS adsales_mtd,

    -- T-2 spend (TACOS ratio sides must align)
    SUM(CASE WHEN DateTime = DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN Cost ELSE 0 END) AS spend_t2,

    -- TACOS-matched windows (spend ceiling = T-2, matches SC sales)
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 7 DAY)
              AND DateTime <= DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN Cost ELSE 0 END) AS spend_t7_tacos_window,
    SUM(CASE WHEN DateTime <= DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN Cost ELSE 0 END) AS spend_t30_tacos_window,
    SUM(CASE WHEN DateTime >= :month_start
              AND DateTime <= DATE_SUB(:yesterday, INTERVAL 1 DAY)
             THEN Cost ELSE 0 END) AS spend_mtd_tacos_window
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= LEAST(:month_start, DATE_SUB(:yesterday, INTERVAL 29 DAY))
  AND DateTime <= :yesterday;
