-- ID: CS-28
-- Purpose: Attribution settlement curve by campaign type x day-of-week.
--          Trailing 90 days. Expands the single CS-06/CS-07 improvement_pts
--          number into a daily-curve shape for cold-start v2.3 enrichment.
-- Params: :seller_id_list
-- Consumers: account-cold-start (v2.3 enrichment)
-- Tier: 1
--
-- Output is reshaped by enrich-context.py into:
--   capture_rate_calibration.daily_settlement_curve.by_campaign_type[CT]
--   capture_rate_calibration.daily_settlement_curve.dow_offset_pts[DOW]
-- DAYOFWEEK convention: 1=Sunday, 2=Monday, ..., 7=Saturday.
-- Multi-seller: spans every seller_id in accounts[] (example brand rolls up the
-- legacy Glacier VC seller 114 alongside active 113).

SELECT
    CampaignType                                                       AS campaign_type,
    DAYOFWEEK(DateTime)                                                AS dow,
    ROUND(SUM(Cost), 2)                                                AS spend,
    ROUND(SUM(AttributedSales1day), 2)                                 AS sales_1day,
    ROUND(SUM(AttributedSales7day), 2)                                 AS sales_7day,
    ROUND(SUM(AttributedSales14day), 2)                                AS sales_14day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)  * 100, 2)   AS acos_1day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0)  * 100, 2)   AS acos_7day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2)   AS acos_14day,
    ROUND((SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)
         - SUM(Cost) / NULLIF(SUM(AttributedSales7day), 0))  * 100, 2) AS improvement_pts_1_to_7,
    ROUND((SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)
         - SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0)) * 100, 2) AS improvement_pts_1_to_14,
    ROUND(SUM(AttributedSales1day) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2)
                                                                       AS settled_pct_1_of_14
FROM campaignmetric
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
  AND DateTime <  CURDATE()
GROUP BY CampaignType, DAYOFWEEK(DateTime)
ORDER BY CampaignType, dow;
