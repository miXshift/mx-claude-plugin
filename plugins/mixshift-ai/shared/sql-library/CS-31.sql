-- ID: CS-31
-- Purpose: Account-level converting search-term corpus, trailing 90 days.
--          Used by enrich-context.py for brand-name typo detection
--          (Levenshtein 1-2 hits vs brand_terms canonicals/variants).
-- Params: :seller_id_list
-- Consumers: account-cold-start (v2.3 enrichment)
-- Tier: 1
--
-- Aggregated to SearchTerm grain (campaign / ad group / match type rolled up).
-- Filtered to terms with at least 1 attributed order — typo detection only
-- cares about converting terms.

SELECT
    SearchTerm,
    SUM(Clicks)                                                       AS clicks,
    ROUND(SUM(Cost), 2)                                               AS spend,
    ROUND(SUM(AttributedSales14day), 2)                               AS sales,
    SUM(AttributedConversions14day)                                   AS orders,
    ROUND(SUM(Cost) / NULLIF(SUM(AttributedSales14day), 0) * 100, 2)  AS acos
FROM keywordtargetingmetric
WHERE SellerID IN (:seller_id_list)
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
  AND DateTime <  CURDATE()
GROUP BY SearchTerm
HAVING SUM(AttributedConversions14day) >= 1
ORDER BY orders DESC, sales DESC;
