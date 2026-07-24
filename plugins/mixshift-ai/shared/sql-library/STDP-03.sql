-- ID: STDP-03
-- Purpose: Window search-term report pull — per-(campaign, adgroup,
--          keyword, search term, match type, recordType) rollup of
--          spend / sales / orders / clicks for the analysis window.
-- Params: :seller_id, :window_start, :window_end
-- Consumers: search-term-data-pull (Phase 1)
-- Tier: 1
--
-- Source: keywordtargetingmetric (the live base metric table). Date
-- field is DateTime. NOTE: the legacy KW_Target_ST_report_MV rollup this
-- query used to read is a frozen dashboard snapshot (its dtCreatedOn is a
-- one-time materialization timestamp, its Period column holds text labels
-- like 'Last 30 Days'), so a date-window filter against it returned zero
-- rows. keywordtargetingmetric carries the same columns (recordType,
-- SearchTerm, Cost/Sales/Orders/Clicks) plus a real per-day DateTime.
-- Caller partitions into Stream 1 ('Keyword Targeting') and
-- Stream 2 ('Product Attribute Targeting') and applies the exclusion
-- mask (STDP-01), the ASIN dedup mask (STDP-02, Stream 2 only), and the
-- spend floor downstream.

SELECT
    CampaignName, AdGroupName, KeywordText, SearchTerm,
    MatchType, recordType,
    SUM(Cost)   AS window_spend,
    SUM(Sales)  AS window_sales,
    SUM(Orders) AS window_orders,
    SUM(Clicks) AS window_clicks
FROM keywordtargetingmetric
WHERE SellerID = :seller_id
  AND DateTime >= :window_start
  AND DateTime <= :window_end
GROUP BY CampaignName, AdGroupName, KeywordText, SearchTerm, MatchType, recordType
ORDER BY window_spend DESC;
