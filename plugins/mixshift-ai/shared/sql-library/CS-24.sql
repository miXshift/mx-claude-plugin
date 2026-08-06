-- ID: CS-24
-- Purpose: Per-campaign trailing-30-day spend, sales and ACOS for the
--          brand-context campaign-structure pass. Dimensions only — the
--          objective classification belongs to the skill layer, which has the
--          brand's own naming context.
-- Params: :seller_id
-- Consumers: brand-context (Query 18)
-- Tier: 1
--
-- Returns DIMENSIONS ONLY. It deliberately does NOT classify campaigns into an
-- objective bucket, and must not be changed back to doing so.
--
-- History: this query used to emit an `objective_class` column derived from a
-- hardcoded CASE over seven literal CampaignName tag patterns
-- (-PROF-BRAND-, -DISC-, -CONQ-, -HDLN-, -SD-) with ELSE 'unknown'. Those tags
-- encode ONE naming convention as if it were universal, so every brand that
-- names campaigns differently got 'unknown' for every campaign — while the
-- query still returned rows and the skill still rendered, making the failure
-- silent and the output confidently wrong. Measured across the fleet, no other
-- account shares that tag vocabulary. It was also incomplete for the very
-- convention it encoded (no research-lane arm), so even a conforming account
-- got a PARTIAL match, which never tripped the all-unknown gap text. And it
-- false-positived on ordinary names: a campaign called SUMMER-DISC-SALE
-- classified as discovery_auto.
--
-- A campaign name is advertiser-authored free text — customer data, not a
-- schema. Interpreting it is the skill layer's job, where per-brand context
-- exists to do it. SB/SD are derivable from CampaignType, which this query
-- returns. Auto-vs-manual (the old discovery_auto bucket) is NOT derivable
-- from campaignmetric, but IS available as campaign.TargetingType.
--
-- Keep at parity with the server-side query pack entry (cs-24.ts); fix both or
-- neither.

SELECT
    CampaignName,
    CampaignType,
    ROUND(SUM(Cost), 2) AS t30_spend,
    ROUND(SUM(Sales), 2) AS t30_sales,
    ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS t30_acos
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
GROUP BY CampaignName, CampaignType
HAVING t30_spend > 0
ORDER BY t30_spend DESC;
