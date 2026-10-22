-- ID: BB-02
-- Purpose: Latest settings snapshot per enabled Sponsored Products campaign
--          for the weekly budget-mix pass -- DailyBudget, BudgetType, State,
--          ServingStatus, Amazon's trailing 7-day PercentTimeInBudget and
--          suggestedBudget, and Amazon's own campaign id (the id
--          sp.update_campaigns takes).
-- Params: :seller_id, :run_date
-- Consumers: budget-balance (Round 1)
-- Tier: 1
-- Notes: campaign_tracking_3mo holds one settings row per campaign per day;
--        this keeps only each campaign's newest row inside the last 7 days,
--        so a campaign not snapshotted in a week (archived) drops out. Only
--        enabled campaigns are returned: a campaign in BB-01 but absent here
--        is not enabled now and is never changed. PercentTimeInBudget is a
--        fraction (0.84 = 84 percent of the last 7 days in budget) and -1
--        means Amazon returned no recommendation: treat -1 and NULL as
--        unknown, never as 0 percent. suggestedBudget can be below, equal to
--        or above DailyBudget; only a value above DailyBudget is a raise
--        ceiling.

SELECT
    t.CampaignID,
    t.AmazonCampaignID,
    t.CampaignName,
    t.CampaignType,
    t.State,
    t.ServingStatus,
    t.DailyBudget,
    t.BudgetType,
    t.PercentTimeInBudget,
    t.suggestedBudget,
    t.SuggestedBudgetIncreasePercent,
    t.DateTime AS snapshot_date
FROM campaign_tracking_3mo t
JOIN (
    SELECT CampaignID, MAX(DateTime) AS latest
    FROM campaign_tracking_3mo
    WHERE SellerID = :seller_id
      AND CampaignType = 'sponsoredProducts'
      AND DateTime >= DATE_SUB(:run_date, INTERVAL 7 DAY)
    GROUP BY CampaignID
) l
  ON l.CampaignID = t.CampaignID
 AND l.latest     = t.DateTime
WHERE t.SellerID = :seller_id
  AND t.CampaignType = 'sponsoredProducts'
  AND t.State = 'enabled'
ORDER BY t.DailyBudget DESC;
