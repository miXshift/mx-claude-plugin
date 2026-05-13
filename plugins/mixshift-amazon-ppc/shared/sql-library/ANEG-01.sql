-- ID: ANEG-01
-- Purpose: ASIN-target candidates for negation review.
-- Params: :seller_id, :run_date, :lookback_days, :lifetime_orders_threshold
-- Consumers: asin-target-negation
-- Tier: 1
--
-- Surfaces ASIN targets that have spent in the lookback window and have
-- lifetime orders below the threshold (default 10 from
-- context.yaml::negation.asin_negation.pre_check_lifetime_orders_threshold).
-- Caller filters further by Layer-1 manual list and brand-term match
-- before recommending negation.

SELECT
    tem.TargetExpressionId,
    tem.AsinTarget,
    tem.CampaignId,
    SUM(tem.Spend)        AS WindowSpend,
    SUM(tem.AdSales)      AS WindowSales,
    SUM(tem.AdOrders)     AS WindowOrders,
    SUM(tem_life.AdOrders) AS LifetimeOrders
FROM targetexpressionsmetric tem
LEFT JOIN targetexpressionsmetric tem_life
       ON tem_life.TargetExpressionId = tem.TargetExpressionId
      AND tem_life.SellerId = tem.SellerId
WHERE tem.SellerId = :seller_id
  AND tem.Date BETWEEN DATE_SUB(:run_date, INTERVAL :lookback_days DAY)
                   AND DATE_SUB(:run_date, INTERVAL 1 DAY)
  AND tem.AsinTarget IS NOT NULL
GROUP BY tem.TargetExpressionId, tem.AsinTarget, tem.CampaignId
HAVING LifetimeOrders < :lifetime_orders_threshold
   AND WindowSpend > 0;
