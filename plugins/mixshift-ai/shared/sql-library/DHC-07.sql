-- ID: DHC-07
-- Purpose: Per-Objective metrics (campaign-level via campaignmetric JOIN
--          campaign) for T-1, T-7 total, T-30 averages.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (Batch F)
-- Tier: 1
--
-- Uses campaignmetric JOIN campaign — matches Report Center. Do NOT
-- substitute keywordtargetingmetric here; keyword-level data lags
-- differently and produces different totals.

SELECT
    c.Objective,
    -- T-1
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Cost  ELSE 0 END) AS spend_t1,
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Sales ELSE 0 END) AS adsales_t1,
    -- T-7 total
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Cost  ELSE 0 END) AS spend_t7_total,
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Sales ELSE 0 END) AS adsales_t7_total,
    -- T-30 avg
    SUM(m.Cost)  / 30 AS spend_t30_avg,
    SUM(m.Sales) / 30 AS adsales_t30_avg,
    SUM(m.Cost)  / NULLIF(SUM(m.Sales), 0) * 100 AS acos_t30
FROM campaignmetric m
JOIN campaign c ON m.CampaignID = c.ID
WHERE m.SellerID = :seller_id
  AND m.DateTime >= DATE_SUB(:yesterday, INTERVAL 29 DAY)
  AND m.DateTime <= :yesterday
  AND c.Objective IS NOT NULL AND c.Objective != ''
GROUP BY c.Objective
ORDER BY spend_t1 DESC;
