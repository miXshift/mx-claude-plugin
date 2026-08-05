-- ID: DHC-08
-- Purpose: Per-ItemGroup metrics (campaignmetric JOIN campaign) for T-1,
--          T-7 total, T-30 averages. Campaigns without an ItemGroup label
--          roll up under '(unclassified)' so the table always adds up to the
--          account total.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (Batch G)
-- Tier: 1
--
-- Same source pattern as DHC-07 (Objective). ItemGroup populated by the
-- account's campaign tagging.
--
-- Same defect and same fix as DHC-07: campaign.ItemGroup is operator-filled
-- free text that most accounts never fill, and the old blank filter
-- (c.ItemGroup IS NOT NULL AND c.ItemGroup != '') silently returned zero
-- rows for them, and silently dropped the unlabelled share of spend for
-- partially labelled accounts. Unlabelled spend now lands in an explicit
-- '(unclassified)' bucket. Keep at parity with the server-side query pack
-- entry (dhc-08.ts); fix both or neither.
--
-- The GROUP BY repeats the full COALESCE expression ON PURPOSE (same as
-- DHC-07): a bare alias in GROUP BY resolves to the raw table column when
-- the alias shadows it, splitting NULL and '' into two '(unclassified)'
-- rows. ItemGroup is NOT NULL today so only '' occurs; the expression form
-- is defensive parity. Do not simplify it back.

SELECT
    COALESCE(NULLIF(c.ItemGroup, ''), '(unclassified)') AS ItemGroup,
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Cost  ELSE 0 END) AS spend_t1,
    SUM(CASE WHEN m.DateTime = :yesterday THEN m.Sales ELSE 0 END) AS adsales_t1,
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Cost  ELSE 0 END) AS spend_t7_total,
    SUM(CASE WHEN m.DateTime >= DATE_SUB(:yesterday, INTERVAL 6 DAY)
             THEN m.Sales ELSE 0 END) AS adsales_t7_total,
    SUM(m.Cost)  / 30 AS spend_t30_avg,
    SUM(m.Sales) / 30 AS adsales_t30_avg,
    SUM(m.Cost)  / NULLIF(SUM(m.Sales), 0) * 100 AS acos_t30
FROM campaignmetric m
JOIN campaign c ON m.CampaignID = c.ID
WHERE m.SellerID = :seller_id
  AND m.DateTime >= DATE_SUB(:yesterday, INTERVAL 29 DAY)
  AND m.DateTime <= :yesterday
GROUP BY COALESCE(NULLIF(c.ItemGroup, ''), '(unclassified)')
ORDER BY spend_t1 DESC;
