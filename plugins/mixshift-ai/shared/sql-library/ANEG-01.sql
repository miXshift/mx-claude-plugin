-- ID: ANEG-01
-- Purpose: ASIN-target candidates for negation review.
-- Params: :seller_id, :window_start, :window_end, :lifetime_orders_threshold
-- Consumers: asin-target-negation
-- Tier: 1
--
-- Surfaces ASIN targets that have spent in the lookback window and whose
-- lifetime orders are below the threshold (default 3 from
-- context.yaml::negation.asin_negation.pre_check_lifetime_orders_threshold).
-- Caller filters further by Layer-1 manual list and brand-term match
-- before recommending negation.
--
-- Source: targetexpressionsmetric. ASIN targets are identified by
-- `targetingText LIKE 'asin=%'` (e.g. `asin="B071FXZBMV"`). The window
-- aggregation uses conditional SUM so we can derive both the window and
-- the full-lifetime totals in a single pass.

SELECT
    AmazonTargetID,
    targetingText                                  AS AsinTarget,
    CampaignID,
    -- Display name only. CampaignName is denormalized onto these daily rows and
    -- a campaign rename leaves old rows with the old name, so it VARIES within a
    -- CampaignID. Aggregate it (MAX) instead of adding it to GROUP BY: putting a
    -- rename-variable column in GROUP BY would split one target into per-name
    -- subgroups and fragment LifetimeOrders, defeating the `LifetimeOrders <
    -- threshold` negation gate (a converting target could surface as a false
    -- candidate). The grain stays (AmazonTargetID, targetingText, CampaignID).
    MAX(CampaignName)                              AS CampaignName,
    ROUND(SUM(CASE WHEN DateTime >= :window_start AND DateTime <= :window_end
                   THEN Cost ELSE 0 END), 2)     AS WindowSpend,
    ROUND(SUM(CASE WHEN DateTime >= :window_start AND DateTime <= :window_end
                   THEN AttributedSales14day ELSE 0 END), 2) AS WindowSales,
    SUM(CASE WHEN DateTime >= :window_start AND DateTime <= :window_end
             THEN AttributedConversions14day ELSE 0 END)     AS WindowOrders,
    SUM(AttributedConversions14day)                AS LifetimeOrders
FROM targetexpressionsmetric
WHERE SellerID = :seller_id
  AND targetingText LIKE 'asin=%'
GROUP BY AmazonTargetID, targetingText, CampaignID
HAVING WindowSpend > 0
   AND LifetimeOrders < :lifetime_orders_threshold
ORDER BY WindowSpend DESC;
