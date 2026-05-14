-- ID: CS-07
-- Purpose: VC SP attribution window comparison (1-day vs 14-day) for the
--          most recent full month.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 5, VC SP path)
-- Tier: 1
--
-- Kept separate from CS-06 because the comparison column differs
-- (AttributedSales14day for VC vs AttributedSales7day for SC) — not just
-- a parameter flip. Promote to a single ID only if a future merchant-type
-- branch is introduced consistently across consumers.

SELECT
    ROUND(SUM(Cost), 2) AS spend,
    ROUND(SUM(AttributedSales1day), 2) AS sales_1day,
    ROUND(SUM(AttributedSales14day), 2) AS sales_14day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0) * 100, 2) AS acos_1day,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2) AS acos_14day,
    ROUND((SUM(Cost) / NULLIF(SUM(AttributedSales1day), 0)
         - SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0)) * 100, 2) AS improvement_pts
FROM campaignmetric
WHERE SellerID = :seller_id
  AND CampaignType = 'sponsoredProducts'
  AND DateTime >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND DateTime <  DATE_FORMAT(CURDATE(), '%Y-%m-01');
