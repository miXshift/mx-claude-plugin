-- ID: DHC-06
-- Purpose: Per-CampaignType metrics for T-1, T-7 total, T-30 averages.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (Batch E)
-- Tier: 1
--
-- Caller derives spend_t7_avg (= spend_t7_total / 7) and acos_t7
-- (= spend_t7_total / adsales_t7_total * 100) downstream.

SELECT
    CampaignType,
    -- T-1
    SUM(CASE WHEN DateTime = :yesterday THEN Cost  ELSE 0 END) AS spend_t1,
    SUM(CASE WHEN DateTime = :yesterday THEN Sales ELSE 0 END) AS adsales_t1,
    -- T-7 total
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN Cost  ELSE 0 END) AS spend_t7_total,
    SUM(CASE WHEN DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN Sales ELSE 0 END) AS adsales_t7_total,
    -- T-30 avg
    SUM(Cost)  / 30 AS spend_t30_avg,
    SUM(Sales) / 30 AS adsales_t30_avg,
    SUM(Cost)  / NULLIF(SUM(Sales), 0) * 100 AS acos_t30
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(:yesterday, INTERVAL 29 DAY)
  AND DateTime <= :yesterday
GROUP BY CampaignType
ORDER BY spend_t1 DESC;
