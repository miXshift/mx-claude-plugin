-- ID: CS-10
-- Purpose: SC item-group derivation from CampaignName (last hyphen
--          segment) for accounts without explicit ItemGroup metadata.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 6, SC path)
-- Tier: 1
--
-- This is a coarse heuristic — relies on the convention that
-- CampaignName ends in the item group token (`...-PROF-BRAND-Spartan`).
-- Caller validates against the brand-context taxonomy before relying on
-- the result.

SELECT
    SUBSTRING_INDEX(SUBSTRING_INDEX(CampaignName, '-', -1), '-', 1) AS item_group_raw,
    ROUND(SUM(Cost), 2) AS spend,
    ROUND(SUM(Sales), 2) AS ad_sales,
    COUNT(DISTINCT CampaignName) AS campaign_count
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
  AND DateTime <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
GROUP BY item_group_raw
ORDER BY spend DESC;
