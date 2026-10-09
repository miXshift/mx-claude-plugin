-- ID: LIB-PT-01
-- Purpose: Price-test comparison at the ASIN level. Compares total
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
--
-- One row per ASIN, with each product's sessions counted once per day.
-- Amazon reports sessions per product (ASIN); this SKU-level table repeats
-- them on each of the product's SKU rows for the day, while Amount and
-- UnitsOrdered are each SKU's own. So the inner level takes one row per
-- (SellerID, ChildAsin, day): MAX of Sessions, SUM of Amount and
-- UnitsOrdered. The outer level adds the days up per ASIN.

SELECT
    MAX(d.Title) AS Title,
    d.ChildAsin,
    SUM(CASE WHEN d.DateTime BETWEEN :prior_start AND :prior_end
             THEN d.Amount        ELSE 0 END) AS sales_prior,
    SUM(CASE WHEN d.DateTime BETWEEN :test_start  AND :test_end
             THEN d.Amount        ELSE 0 END) AS sales_test,
    SUM(CASE WHEN d.DateTime BETWEEN :prior_start AND :prior_end
             THEN d.UnitsOrdered  ELSE 0 END) AS units_prior,
    SUM(CASE WHEN d.DateTime BETWEEN :test_start  AND :test_end
             THEN d.UnitsOrdered  ELSE 0 END) AS units_test,
    SUM(CASE WHEN d.DateTime BETWEEN :prior_start AND :prior_end
             THEN d.Sessions      ELSE 0 END) AS sessions_prior,
    SUM(CASE WHEN d.DateTime BETWEEN :test_start  AND :test_end
             THEN d.Sessions      ELSE 0 END) AS sessions_test
FROM (
    SELECT
        s.SellerID,
        s.ChildAsin,
        DATE(s.DateTime)    AS DateTime,
        MAX(s.Title)        AS Title,
        SUM(s.Amount)       AS Amount,
        SUM(s.UnitsOrdered) AS UnitsOrdered,
        MAX(s.Sessions)     AS Sessions
    FROM business_reports_dpst_sku s
    WHERE s.SellerID = :seller_id
      AND s.Title LIKE :title_pattern
    GROUP BY s.SellerID, s.ChildAsin, DATE(s.DateTime)
) d
GROUP BY d.ChildAsin
ORDER BY sales_test DESC;
