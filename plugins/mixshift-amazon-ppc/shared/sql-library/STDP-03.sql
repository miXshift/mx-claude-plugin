-- ID: STDP-03
-- Purpose: Window search-term report pull — per-(campaign, adgroup,
--          keyword, search term, match type, recordType) rollup of
--          spend / sales / orders / clicks for the analysis window.
-- Params: :seller_id, :window_start, :window_end
-- Consumers: search-term-data-pull (Phase 1)
-- Tier: 1
--
-- Source: KW_Target_ST_report_MV. Date field is dtCreatedOn (NOT
-- DateTime). Caller partitions into Stream 1 ('Keyword Targeting') and
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
FROM KW_Target_ST_report_MV
WHERE SellerID = :seller_id
  AND dtCreatedOn >= :window_start
  AND dtCreatedOn <= :window_end
GROUP BY CampaignName, AdGroupName, KeywordText, SearchTerm, MatchType, recordType
ORDER BY window_spend DESC;
