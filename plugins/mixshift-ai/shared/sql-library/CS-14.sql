-- ID: CS-14
-- Purpose: Per-campaign monthly spend, ad sales and ACOS for the trailing 6
--          months. Dimensions only — the brand vs non-brand split belongs to
--          the skill layer, which resolves it against the brand's own labels
--          and declared vocabulary.
-- Params: :seller_id
-- Consumers: brand-context (Query 10)
-- Tier: 1
--
-- Returns DIMENSIONS ONLY, at campaign x month grain. It deliberately does NOT
-- split spend into Brand vs NonBrand, and must not be changed back to doing so.
--
-- History: this query used to emit a `brand_type` column ('Brand'/'NonBrand')
-- derived from a hardcoded CASE over three literal CampaignName tag patterns.
-- That encodes ONE naming convention as universal, so any brand naming
-- campaigns differently had 100% of spend labelled NonBrand — and it was worse
-- than the sibling CS-24 defect in two ways. First, it GROUP BY-ed on the
-- derived label, which DESTROYED CampaignName before the skill could see it:
-- the output was one bucket per month with no way to recover the real split, so
-- the error was unfixable downstream rather than merely wrong. Second, CS-14
-- had no gap-text safeguard at all, so "brand spend = $0 / 0% of spend is brand
-- defense" was rendered as fact into the onboarding artifact a human trusts.
--
-- Because the grain is now campaign x month, CampaignName survives into the
-- skill, which is what makes the split recoverable per brand at all. How the
-- skill should resolve it: prefer the tenant's own campaign.Brand label where
-- populated; otherwise test each delimited NAME SEGMENT for membership in that
-- brand's declared vocabulary, and report a match rate. Note what that does NOT
-- mean. It is not a brand_terms substring match — that mechanism works at
-- KEYWORD grain but matched 0 of 43 campaigns at CAMPAIGN grain on the account
-- it was measured against, so borrowing it here would reproduce the same
-- confidently wrong answer by a different route. And it is not a POSITIONAL
-- naming-pattern slot — one account carries its classifying token at segment
-- index 1, 2 and 3 across different campaigns, so position cannot resolve even
-- a single convention.
--
-- Row-count note: grain changed from ~2 rows/month to (campaigns x months), so
-- HAVING spend > 0 now prunes zero-spend campaign-months. Zero-spend rows
-- contribute nothing to any sum or share, so no denominator changes.
--
-- Sort is month DESCENDING on purpose. Consumers that cap a result for display
-- take a HEAD slice, so ascending order would show the OLDEST (usually partial)
-- month and hide the current one. Order affects no sum, and the full result is
-- always in the structured artifact.
--
-- Keep at parity with the server-side query pack entry (cs-14.ts); fix both or
-- neither.

SELECT DATE_FORMAT(DateTime, '%Y-%m') AS month,
       CampaignName,
       CampaignType,
       ROUND(SUM(Cost), 2) AS spend,
       ROUND(SUM(Sales), 2) AS ad_sales,
       ROUND(SUM(Cost) / NULLIF(SUM(Sales), 0) * 100, 2) AS acos_pct
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
GROUP BY DATE_FORMAT(DateTime, '%Y-%m'), CampaignName, CampaignType
HAVING spend > 0
ORDER BY month DESC, spend DESC;
