-- ID: DHC-05
-- Purpose: T-30 daily actuals (Spend, AdSale, ACOS, Sales, TACOS) plus
--          winsorized rolling means for CI percentile computation.
-- Params: :seller_id, :yesterday
-- Consumers: daily-health-check (Batch D)
-- Tier: 1
--
-- Caller sorts the T-30 daily values per metric and applies the
-- UpperSensitivityLimit / LowerSensitivityLimit from DHC-04 to compute
-- upper/lower CI cutoffs (linear interpolation when no exact match).
-- The _Mean columns are pre-computed; use for context only.

SELECT Date, Spend, AdSale, ACOS, Sales, TACOS,
       Spend_Mean, AdSale_Mean, ACOS_Mean, Sales_Mean, TACOS_Mean
FROM anomaly_detection_MV
WHERE SellerID = :seller_id
  AND Date >= DATE_SUB(:yesterday, INTERVAL 30 DAY)
  AND Date <= :yesterday
ORDER BY Date ASC;
