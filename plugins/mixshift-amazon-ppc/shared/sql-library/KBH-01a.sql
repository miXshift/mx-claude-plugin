-- ID: KBH-01a
-- Purpose: T-7 keyword performance metrics for weekly bid health review --
--          spend, ad sales, ACOS, conversions, clicks, CPC per keyword across
--          enabled, non-VCPM campaigns. Used for trend-direction column and
--          T-7 Bid/CPC cell in the report.
-- Params: :seller_id, :run_date
-- Consumers: keyword-bid-health (Round 1 -- Batch 1a)
-- Tier: 1
-- Note: Same grain and filters as KBH-01. Lookback window hardcoded to 7 days.
--       Column aliases use _t7 suffix to distinguish from KBH-01 results
--       when both are held in memory simultaneously.

SELECT
    ktm.KeywordText,
    ktm.MatchType,
    ktm.CampaignName,
    ktm.AdGroupName,
    ROUND(SUM(ktm.Cost), 2)                                                AS spend_t7,
    ROUND(SUM(ktm.AttributedSales14day), 2)                                AS adsales_t7,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.AttributedSales14day), 0) * 100, 2) AS acos_t7,
    SUM(ktm.AttributedConversions14day)                                    AS conversions_t7,
    SUM(ktm.Clicks)                                                        AS clicks_t7,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.Clicks), 0), 2)                  AS cpc_t7
FROM keywordtargetingmetric ktm
JOIN campaign c
  ON c.ID         = ktm.CampaignID
 AND c.SellerID   = ktm.SellerID
WHERE ktm.SellerID = :seller_id
  AND ktm.DateTime >= DATE_SUB(:run_date, INTERVAL 7 DAY)
  AND ktm.DateTime <  :run_date
  AND c.State = 'enabled'
  AND ktm.costType IN ('cpc', '')
  AND ktm.recordType = 'Keyword Targeting'
GROUP BY ktm.KeywordText, ktm.MatchType, ktm.CampaignName, ktm.AdGroupName
HAVING SUM(ktm.Cost) > 0
ORDER BY spend_t7 DESC;
