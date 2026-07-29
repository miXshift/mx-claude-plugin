-- ID: KBH-01
-- Purpose: T-30 keyword performance metrics for weekly bid health review --
--          spend, ad sales, ACOS, conversions, clicks, CPC per keyword across
--          enabled, non-VCPM campaigns. Drives both High-ACOS bid-cut
--          candidates and Scale-Opportunity surfacing.
-- Params: :seller_id, :lookback_days, :run_date
-- Consumers: keyword-bid-health (Round 1 -- Batch 1)
-- Tier: 1
-- Note: MatchType is LOWER()-normalized because keywordtargetingmetric stores
--       keyword match types in a different letter case than keywordtargeting
--       (KBH-02) in real tenant data; without normalization the documented
--       app-layer join on (KeywordText, MatchType, CampaignName, AdGroupName)
--       can match zero rows. All KBH-* queries normalize the same way.

SELECT
    ktm.KeywordText,
    LOWER(ktm.MatchType)                                                   AS MatchType,
    ktm.CampaignName,
    ktm.AdGroupName,
    ROUND(SUM(ktm.Cost), 2)                                                AS spend_t30,
    ROUND(SUM(ktm.AttributedSales14day), 2)                                AS adsales_t30,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.AttributedSales14day), 0) * 100, 2) AS acos_t30,
    SUM(ktm.AttributedConversions14day)                                    AS conversions_t30,
    SUM(ktm.Orders)                                                        AS orders_t30,
    SUM(ktm.Clicks)                                                        AS clicks_t30,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.Clicks), 0), 2)                  AS cpc_t30
FROM keywordtargetingmetric ktm
JOIN campaign c
  ON c.ID         = ktm.CampaignID
 AND c.SellerID   = ktm.SellerID
WHERE ktm.SellerID = :seller_id
  AND ktm.DateTime >= DATE_SUB(:run_date, INTERVAL :lookback_days DAY)
  AND ktm.DateTime <  :run_date
  AND c.State = 'enabled'
  AND ktm.costType IN ('cpc', '')
  AND ktm.recordType = 'Keyword Targeting'
GROUP BY ktm.KeywordText, LOWER(ktm.MatchType), ktm.CampaignName, ktm.AdGroupName
HAVING SUM(ktm.Cost) > 0
ORDER BY spend_t30 DESC;
