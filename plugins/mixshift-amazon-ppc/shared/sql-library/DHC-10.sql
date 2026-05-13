-- ID: DHC-10
-- Purpose: Data-lag check comparing T-1 campaign-level vs keyword-level
--          spend totals. If gap > 10%, dimensional ACOS figures are still
--          settling and should be flagged as directional.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (data-lag check)
-- Tier: 1

SELECT
    (SELECT SUM(Cost) FROM campaignmetric
     WHERE SellerID = :seller_id AND DateTime = :yesterday) AS campaign_spend_t1,
    (SELECT SUM(Cost) FROM keywordtargetingmetric
     WHERE SellerID = :seller_id AND DateTime = :yesterday) AS keyword_spend_t1;
