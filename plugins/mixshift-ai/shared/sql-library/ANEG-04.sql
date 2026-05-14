-- ID: ANEG-04
-- Purpose: Phase 3 lifetime performance join by location (campaign + ad
--          group) for ASINs that passed PDP relevance review. UNIONs
--          keywordtargetingmetric (auto/DISC PAT) and targetexpressionsmetric
--          (manual asinSameAs / SD targeting expressions) before aggregating.
-- Params: :seller_id, :window_asin_set, :window_asin_set_lower
-- Consumers: asin-target-negation (Phase 3)
-- Tier: 1
--
-- CRITICAL: Manual CONQ/PROF asinSameAs targets only record performance in
-- targetexpressionsmetric. Querying keywordtargetingmetric alone undercounts
-- lifetime conversions and produces false negate recommendations.
-- :window_asin_set / :window_asin_set_lower are runtime IN-list expansions
-- of the Phase 0 target ASIN set.

SELECT
    target_asin, CampaignName, AdGroupName,
    ROUND(SUM(lt_spend), 2)  AS lifetime_spend,
    ROUND(SUM(lt_sales), 2)  AS lifetime_sales,
    SUM(lt_orders)           AS lifetime_orders,
    SUM(lt_clicks)           AS lifetime_clicks,
    CASE WHEN SUM(lt_sales) > 0
         THEN ROUND(SUM(lt_spend) / SUM(lt_sales) * 100, 1)
         ELSE NULL END       AS lifetime_acos
FROM (
    SELECT
        SearchTerm AS target_asin, CampaignName, AdGroupName,
        SUM(Cost)                       AS lt_spend,
        SUM(AttributedSales14day)       AS lt_sales,
        SUM(AttributedConversions14day) AS lt_orders,
        SUM(Clicks)                     AS lt_clicks
    FROM keywordtargetingmetric
    WHERE SellerID = :seller_id
      AND recordType = 'Product Attribute Targeting'
      AND SearchTerm IN ([window_asin_set])
    GROUP BY SearchTerm, CampaignName, AdGroupName

    UNION ALL

    SELECT
        SearchTerm AS target_asin, CampaignName, AdGroupName,
        SUM(Cost)                       AS lt_spend,
        SUM(AttributedSales14day)       AS lt_sales,
        SUM(AttributedConversions14day) AS lt_orders,
        SUM(Clicks)                     AS lt_clicks
    FROM targetexpressionsmetric
    WHERE SellerID = :seller_id
      AND LOWER(SearchTerm) IN ([window_asin_set_lower])
    GROUP BY SearchTerm, CampaignName, AdGroupName
) combined
GROUP BY target_asin, CampaignName, AdGroupName
ORDER BY target_asin, lifetime_spend DESC;
