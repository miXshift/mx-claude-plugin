-- ID: ANEG-02
-- Purpose: Phase 0 window pull — PAT-only rows from keywordtargetingmetric for
--          the configured negation review window. Aggregated to
--          (campaign, ad group, keyword, search term, match type).
-- Params: :seller_id, :window_start, :window_end
-- Consumers: asin-target-negation (Phase 0)
-- Tier: 1
--
-- recordType is constrained to 'Product Attribute Targeting' so this
-- excludes keyword-triggered traffic. Caller normalizes target ASIN from
-- SearchTerm/KeywordText downstream.

SELECT
    CampaignID, CampaignName, AdGroupID, AdGroupName,
    KeywordText, SearchTerm, MatchType, recordType,
    SUM(Cost)                       AS window_spend,
    SUM(AttributedSales14day)       AS window_sales,
    SUM(AttributedConversions14day) AS window_orders,
    SUM(Clicks)                     AS window_clicks
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND DateTime >= :window_start
  AND DateTime <= :window_end
  AND recordType = 'Product Attribute Targeting'
GROUP BY CampaignID, CampaignName, AdGroupID, AdGroupName,
         KeywordText, SearchTerm, MatchType, recordType
ORDER BY window_spend DESC;
