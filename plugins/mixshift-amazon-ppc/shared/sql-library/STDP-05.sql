-- ID: STDP-05
-- Purpose: Lifetime performance — by SearchTerm x CampaignName for
--          Stream 1, used to derive item-group splits in the application
--          layer (do not parse CampaignName in SQL).
-- Params: :seller_id, :search_term_list
-- Consumers: search-term-data-pull (Phase 2b)
-- Tier: 1
--
-- After execution, caller maps each CampaignName to its item group via
-- the brand-context taxonomy. Unmapped CampaignNames are labeled
-- item_group = 'unknown' and logged — never discarded.

SELECT
    SearchTerm,
    CampaignName,
    SUM(Cost)   AS lifetime_spend,
    SUM(Sales)  AS lifetime_sales,
    SUM(Orders) AS lifetime_orders,
    CASE WHEN SUM(Sales) > 0
         THEN ROUND(SUM(Cost) / SUM(Sales) * 100, 1)
         ELSE NULL
    END AS lifetime_acos
FROM KW_Target_ST_report_MV
WHERE SellerID = :seller_id
  AND recordType = 'Keyword Targeting'
  AND SearchTerm IN (:search_term_list)
GROUP BY SearchTerm, CampaignName
ORDER BY SearchTerm, lifetime_spend DESC;
