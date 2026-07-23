-- ID: STDP-04
-- Purpose: Lifetime performance — aggregate (account-wide) per search
--          term for Stream 1 (Keyword Targeting).
-- Params: :seller_id, :search_term_list
-- Consumers: search-term-data-pull (Phase 2a)
-- Tier: 1
--
-- :search_term_list is the unique-SearchTerm list from Phase 1 Stream 1.
-- Used by phrase negation (n-gram corpus), harvest extraction (account-
-- wide conversion confirmation), and exact negation (overall lifetime
-- evidence base).

SELECT
    SearchTerm,
    SUM(Cost)   AS lifetime_spend,
    SUM(Sales)  AS lifetime_sales,
    SUM(Orders) AS lifetime_orders,
    CASE WHEN SUM(Sales) > 0
         THEN ROUND(SUM(Cost) / SUM(Sales) * 100, 1)
         ELSE NULL
    END AS lifetime_acos
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND recordType = 'Keyword Targeting'
  AND SearchTerm IN (:search_term_list)
GROUP BY SearchTerm
ORDER BY lifetime_spend DESC;
