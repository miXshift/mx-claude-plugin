-- ID: LIB-PT-01
-- Purpose: Price-test comparison at the ASIN/SKU level. Compares total
--          ordered product sales, units, and sessions between a "test"
--          window and a "prior" window for a title pattern (e.g.,
--          "Spartan", "Bottle Bright").
-- Params: :seller_id, :title_pattern, :prior_start, :prior_end,
--         :test_start, :test_end
-- Consumers: daily-health-check (price-test sub-section),
--            runaway-spend-check (when context.yaml::structural_events
--            includes an active price_test event)
-- Tier: 1
--
-- Source: business_reports_dpst_sku — total ordered product sales
-- (organic + ad). Do NOT use business_reports_dpst_item (legacy/dormant,
-- last data 2021). Do NOT compute CVR at the ASIN level — sessions are
-- only reported on conversion days, creating survivorship bias.

SELECT
    Title,
    ChildAsin,
    SUM(CASE WHEN DateTime BETWEEN :prior_start AND :prior_end
             THEN Amount         ELSE 0 END) AS sales_prior,
    SUM(CASE WHEN DateTime BETWEEN :test_start  AND :test_end
             THEN Amount         ELSE 0 END) AS sales_test,
    SUM(CASE WHEN DateTime BETWEEN :prior_start AND :prior_end
             THEN UnitsOrdered   ELSE 0 END) AS units_prior,
    SUM(CASE WHEN DateTime BETWEEN :test_start  AND :test_end
             THEN UnitsOrdered   ELSE 0 END) AS units_test,
    SUM(CASE WHEN DateTime BETWEEN :prior_start AND :prior_end
             THEN Sessions       ELSE 0 END) AS sessions_prior,
    SUM(CASE WHEN DateTime BETWEEN :test_start  AND :test_end
             THEN Sessions       ELSE 0 END) AS sessions_test
FROM business_reports_dpst_sku
WHERE SellerID = :seller_id
  AND Title LIKE :title_pattern
GROUP BY Title, ChildAsin
ORDER BY sales_test DESC;
