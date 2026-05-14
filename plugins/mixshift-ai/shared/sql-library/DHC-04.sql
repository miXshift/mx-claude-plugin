-- ID: DHC-04
-- Purpose: CI thresholds and pre-computed pacing/MTD per metric for the
--          account.
-- Params: :seller_id
-- Consumers: daily-health-check (Batch C)
-- Tier: 1
--
-- Returns one row per metric (Sales, Units, Spend, AdSale, ACOS, TACOS).
-- UpperSensitivityLimit / LowerSensitivityLimit are percentile cutoffs;
-- Pacing and MTD are pre-computed values to use directly when available.

SELECT Metric, Sensitivity, UpperSensitivityLimit, LowerSensitivityLimit,
       Pacing, MTD
FROM anomaly_detection_settings
WHERE SellerID = :seller_id;
