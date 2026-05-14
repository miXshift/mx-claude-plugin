-- ID: MPR-02
-- Purpose: SC monthly ad totals computed from daily campaignmetric with
--          attribution-window CASE (SP=7day, SB/SD=14day). Aggregates to
--          calendar month for blended ACOS and MoM trend.
-- Params: :seller_id, :prior_month_start, :current_month_end
-- Consumers: monthly-performance-report (SC path)
-- Tier: 1
--
-- The CASE block is the canonical SC attribution window rule. Do not
-- change without updating context.yaml::attribution_rule.per_campaign_type
-- in every client — the two must stay in lockstep.

SELECT
    DATE_FORMAT(DateTime, '%Y-%m') AS month,
    SUM(Cost) AS ad_spend,
    SUM(CASE
        WHEN CampaignType = 'sponsoredProducts' THEN AttributedSales7day
        ELSE AttributedSales14day
    END) AS ad_sales,
    SUM(CASE
        WHEN CampaignType = 'sponsoredProducts' THEN AttributedConversions7day
        ELSE AttributedConversions14day
    END) AS orders
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= :prior_month_start
  AND DateTime <= :current_month_end
GROUP BY DATE_FORMAT(DateTime, '%Y-%m')
ORDER BY month;
