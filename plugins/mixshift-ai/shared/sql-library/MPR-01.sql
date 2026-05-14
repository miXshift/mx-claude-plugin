-- ID: MPR-01
-- Purpose: VC monthly ad totals across SP, SB (Headline), SD for current,
--          prior, and prior-year months. Source for blended ACOS, MoM/YoY
--          deltas, and channel mix in monthly-performance-report.
-- Params: :seller_id, :curr_month, :prior_month, :prior_year_month
-- Consumers: monthly-performance-report (VC path)
-- Tier: 1
--
-- DateTime in sellermonthmetric is a month-start date (YYYY-MM-01).
-- Caller passes three explicit month-start dates rather than a range so
-- prior-year alignment is exact even when month-length differs.

SELECT
    DateTime,
    ROUND(SPAAdSpend  + HeadlineAdSpend  + SDAdSpend,  2) AS total_spend,
    ROUND(SPAAdSales  + HeadlineAdSales  + SDAdSales,  2) AS total_ad_sales,
    SPAAdOrders   + HeadlineAdOrders   + SDAdOrders   AS total_orders,
    SPAAdClicks   + HeadlineAdClicks   + SDAdClicks   AS total_clicks
FROM sellermonthmetric
WHERE SellerID = :seller_id
  AND DateTime IN (:curr_month, :prior_month, :prior_year_month)
ORDER BY DateTime DESC;
