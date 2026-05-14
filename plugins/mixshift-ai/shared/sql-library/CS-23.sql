-- ID: CS-23
-- Purpose: T-30 keyword spend concentration — top keywords by spend with
--          14-day attributed conversions.
-- Params: :seller_id, :limit
-- Consumers: account-cold-start (Query 17, keyword concentration)
-- Tier: 1
--
-- Default :limit = 50. Filters to recordType = 'Keyword Targeting' to
-- exclude PAT (ASIN) rows.

SELECT
    CampaignName,
    AdGroupName,
    KeywordText,
    MatchType,
    ROUND(SUM(Cost), 2) AS t30_spend,
    ROUND(SUM(Sales), 2) AS t30_sales,
    ROUND(SUM(AttributedConversions14day), 0) AS t30_orders
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND recordType = 'Keyword Targeting'
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY CampaignName, AdGroupName, KeywordText, MatchType
ORDER BY t30_spend DESC
LIMIT :limit;
