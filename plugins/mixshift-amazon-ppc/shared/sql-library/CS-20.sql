-- ID: CS-20
-- Purpose: SC brand catalog -- distinct brands and enabled ASIN counts
--          derived from campaign.Brand x productad.ASIN.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 15, SC path)
-- Tier: 1
--
-- Fix (2026-04-27): original query targeted business_reports_dpst_date.Brand
-- and .Asin -- columns confirmed absent from that table per shared/tables.yaml.
-- Neither business_reports_dpst_date nor business_reports_dpst_sku carries a
-- Brand column. The canonical brand label lives on campaign.Brand (set by the
-- account manager). ASIN counts come from productad.ASIN (the ad-level ASIN
-- associated with each campaign). This is the correct source for cold-start
-- brand structure discovery.

SELECT   c.Brand,
         COUNT(DISTINCT pa.ASIN) AS asin_count
FROM     campaign c
JOIN     productad pa ON pa.CampaignID = c.ID
WHERE    c.SellerID   = :seller_id
  AND    c.Brand      IS NOT NULL
  AND    c.Brand      != ''
  AND    pa.State     = 'enabled'
GROUP BY c.Brand
ORDER BY asin_count DESC;
