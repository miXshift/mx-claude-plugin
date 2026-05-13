-- ID: KBH-03
-- Purpose: Lifetime keyword performance metrics for weekly bid health review --
--          all-time spend, ad sales, ACOS, conversions, clicks, CPC per keyword.
--          Enables Lifetime CPC column (bid headroom signal) and LT ACOS context.
-- Params: :seller_id
-- Consumers: keyword-bid-health (Round 2 -- Batch 2)
-- Tier: 1
-- Note: No date filter -- aggregates all history for the seller_id.
--       Scoped to currently-enabled campaigns to stay consistent with
--       KBH-01/KBH-01a. CPC computed from SUM(Cost)/SUM(Clicks) to avoid
--       averaging pre-computed daily CPC values (which would weight incorrectly).

SELECT
    ktm.KeywordText,
    ktm.MatchType,
    ktm.CampaignName,
    ktm.AdGroupName,
    ROUND(SUM(ktm.Cost), 2)                                                AS lifetime_spend,
    ROUND(SUM(ktm.AttributedSales14day), 2)                                AS lifetime_adsales,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.AttributedSales14day), 0) * 100, 2) AS lifetime_acos,
    SUM(ktm.AttributedConversions14day)                                    AS lifetime_conversions,
    SUM(ktm.Clicks)                                                        AS lifetime_clicks,
    ROUND(SUM(ktm.Cost) / NULLIF(SUM(ktm.Clicks), 0), 2)                  AS lifetime_cpc
FROM keywordtargetingmetric ktm
JOIN campaign c
  ON c.ID         = ktm.CampaignID
 AND c.SellerID   = ktm.SellerID
WHERE ktm.SellerID = :seller_id
  AND c.State = 'enabled'
  AND ktm.costType IN ('cpc', '')
  AND ktm.recordType = 'Keyword Targeting'
GROUP BY ktm.KeywordText, ktm.MatchType, ktm.CampaignName, ktm.AdGroupName
HAVING SUM(ktm.Cost) > 0
ORDER BY lifetime_spend DESC;
