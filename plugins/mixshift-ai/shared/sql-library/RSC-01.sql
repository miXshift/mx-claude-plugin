-- ID: RSC-01
-- Purpose: Acute keyword runaway detection -- T-1 keyword performance with
--          T-30 baseline in a single round trip. Returns one row per
--          (KeywordText, MatchType, CampaignName, AdGroupName) tuple
--          showing both yesterday's spend / sales / conversions and the
--          full T-30 totals for comparison.
-- Params: :seller_id, :yesterday, :lookback_days
-- Consumers: runaway-spend-check (Round 1)
-- Tier: 1
--
-- The runaway-spend-check skill consumes this output:
--   1. T-1 columns (spend_t1, adsales_t1, conversions_t1) drive the
--      "current day" view -- the value to flag.
--   2. T-30 columns (spend_t30, adsales_t30, conversions_t30) feed the
--      historical baseline used for CI breach detection and the
--      "material history" filter on zero-conversion alerts.
--
-- The denominator inside the CASE expressions uses GREATEST(:lookback_days, 1)
-- to make the daily-avg comparison safe for short windows. ACOS columns
-- guard against zero sales via NULLIF.
--
-- Filters:
--   - SellerID restricted (single account per run)
--   - DateTime within [yesterday - lookback_days + 1, yesterday]
--   - Campaign state = 'enabled' (paused campaigns excluded entirely)
--   - costType IN ('cpc', '') and recordType = 'Keyword Targeting' --
--     matches the conventions in KBH-01 / DHC-* so we don't pick up
--     vCPM / PAT rows.

SELECT
    ktm.KeywordText,
    ktm.MatchType,
    ktm.CampaignName,
    ktm.AdGroupName,
    c.CampaignType,

    -- T-1 (yesterday only)
    ROUND(SUM(CASE WHEN ktm.DateTime = :yesterday THEN ktm.Cost ELSE 0 END), 2)
        AS spend_t1,
    ROUND(SUM(CASE WHEN ktm.DateTime = :yesterday THEN ktm.AttributedSales14day ELSE 0 END), 2)
        AS adsales_t1,
    SUM(CASE WHEN ktm.DateTime = :yesterday THEN ktm.AttributedConversions14day ELSE 0 END)
        AS conversions_t1,
    SUM(CASE WHEN ktm.DateTime = :yesterday THEN ktm.Clicks ELSE 0 END)
        AS clicks_t1,
    ROUND(
        SUM(CASE WHEN ktm.DateTime = :yesterday THEN ktm.Cost ELSE 0 END)
        / NULLIF(SUM(CASE WHEN ktm.DateTime = :yesterday
                          THEN ktm.AttributedSales14day ELSE 0 END), 0)
        * 100, 2)
        AS acos_t1,

    -- T-30 window (lookback_days back from yesterday, inclusive)
    ROUND(SUM(ktm.Cost), 2)                                       AS spend_t30,
    ROUND(SUM(ktm.AttributedSales14day), 2)                       AS adsales_t30,
    SUM(ktm.AttributedConversions14day)                           AS conversions_t30,
    SUM(ktm.Clicks)                                               AS clicks_t30,
    ROUND(SUM(ktm.Cost)
          / NULLIF(SUM(ktm.AttributedSales14day), 0)
          * 100, 2)                                               AS acos_t30,
    ROUND(SUM(ktm.Cost) / GREATEST(:lookback_days, 1), 2)         AS spend_t30_daily_avg
FROM keywordtargetingmetric ktm
JOIN campaign c
  ON c.ID       = ktm.CampaignID
 AND c.SellerID = ktm.SellerID
WHERE ktm.SellerID = :seller_id
  AND ktm.DateTime >= DATE_SUB(:yesterday, INTERVAL (:lookback_days - 1) DAY)
  AND ktm.DateTime <= :yesterday
  AND c.State = 'enabled'
  AND ktm.costType IN ('cpc', '')
  AND ktm.recordType = 'Keyword Targeting'
GROUP BY ktm.KeywordText, ktm.MatchType, ktm.CampaignName, ktm.AdGroupName, c.CampaignType
HAVING SUM(ktm.Cost) > 0
ORDER BY spend_t1 DESC;
