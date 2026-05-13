-- ID: CS-15
-- Purpose: Spend trend — T-30 vs T-90 daily averages from campaignmetric.
-- Params: :seller_id
-- Consumers: account-cold-start (Query 11)
-- Tier: 1

SELECT
    ROUND(SUM(CASE WHEN DateTime >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                   THEN Cost ELSE 0 END) / 30, 2) AS daily_avg_t30,
    ROUND(SUM(CASE WHEN DateTime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
                   THEN Cost ELSE 0 END) / 90, 2) AS daily_avg_t90
FROM campaignmetric
WHERE SellerID = :seller_id
  AND DateTime >= DATE_SUB(CURDATE(), INTERVAL 90 DAY);
