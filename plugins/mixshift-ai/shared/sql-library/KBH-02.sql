-- ID: KBH-02
-- Purpose: Current bid and Amazon bid guidance (SuggestedBid, BidRangeStart,
--          BidRangeEnd) per enabled keyword. Joined to KBH-01 results to
--          ground formula-derived bid-cut ceilings against Amazon's
--          published guidance bands.
-- Params: :seller_id
-- Consumers: keyword-bid-health (Round 2 — Batch 1b)
-- Tier: 1
-- Note: MatchType is LOWER()-normalized to match KBH-01/01a/03 output; the two
--       source tables store match-type letter case differently in real tenant
--       data, which broke the documented app-layer join before normalization.

SELECT
    kt.KeywordText,
    LOWER(kt.MatchType)  AS MatchType,
    kt.CampaignName,
    kt.AdGroupName,
    kt.Bid           AS current_bid,
    kt.SuggestedBid  AS amazon_suggested_bid,
    kt.BidRangeStart AS amazon_bid_range_start,
    kt.BidRangeEnd   AS amazon_bid_range_end
FROM keywordtargeting kt
WHERE kt.SellerID = :seller_id
  AND kt.State    = 'enabled'
  AND kt.IsNegative = 0
  AND kt.recordType = 'Keyword Targeting';
