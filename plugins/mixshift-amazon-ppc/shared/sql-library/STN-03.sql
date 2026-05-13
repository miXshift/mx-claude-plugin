-- ID: STN-03
-- Purpose: Historical performance for a single search term across T-30 and
--          T-60 windows. Returns one row per period for trend comparison
--          before negation decisions on borderline terms.
-- Params: :seller_id, :search_term, :end_date
-- Consumers: search-term-negation (Historical Performance Analysis)
-- Tier: 1
--
-- Used when a candidate term is on the fence — confirms the term is a
-- persistent loser rather than a recent stockout / bid-change artifact.

SELECT 'T-30' AS period, SearchTerm,
       SUM(Cost)                  AS cost,
       SUM(AttributedSales14day)  AS sales,
       ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2) AS ACOS
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND SearchTerm = :search_term
  AND DateTime >= DATE_SUB(:end_date, INTERVAL 30 DAY)

UNION

SELECT 'T-60' AS period, SearchTerm,
       SUM(Cost)                  AS cost,
       SUM(AttributedSales14day)  AS sales,
       ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2) AS ACOS
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND SearchTerm = :search_term
  AND DateTime >= DATE_SUB(:end_date, INTERVAL 60 DAY)

ORDER BY period;
