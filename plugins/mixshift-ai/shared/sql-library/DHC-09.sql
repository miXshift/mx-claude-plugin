-- ID: DHC-09
-- Purpose: Per-Brand metrics (campaignmetric JOIN campaign) for T-1, T-7
--          total, T-30 averages. Conditional — run only when brand context
--          documents sub-brand segmentation.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (Batch E0, conditional)
-- Tier: 1

SELECT
    c.Brand,
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Cost  ELSE 0 END) AS spend_t1,
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Sales ELSE 0 END) AS adsales_t1,
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Cost  ELSE 0 END) AS spend_t7_total,
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Sales ELSE 0 END) AS adsales_t7_total,
    SUM(m.Cost)  / 30 AS spend_t30_avg,
    SUM(m.Sales) / 30 AS adsales_t30_avg,
    SUM(m.Cost)  / NULLIF(SUM(m.Sales), 0) * 100 AS acos_t30
FROM campaignmetric m
JOIN campaign c ON m.CampaignID = c.ID
WHERE m.SellerID = :seller_id
  AND m.DateTime >= DATE_SUB(:yesterday, INTERVAL 29 DAY)
  AND m.DateTime <= :yesterday
  AND c.Brand IS NOT NULL AND c.Brand != ''
GROUP BY c.Brand
ORDER BY spend_t1 DESC;
