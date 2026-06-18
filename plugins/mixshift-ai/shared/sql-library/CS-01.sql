-- ID: CS-01
-- Purpose: Confirm account identity and merchant type (SC vs VC) for each
--          seller in the cold-start scope.
-- Params: :seller_id_list
-- Consumers: brand-context (Query 1)
-- Tier: 1
--
-- :seller_id_list is a comma-separated INT list expanded by the caller.
-- Result drives downstream branching: SC -> business_reports_dpst_date,
-- VC -> vendor_sales_manufacturing_asin. Use the seller table for identity;
-- VC/SC-specific reporting tables can be empty for the opposite account type.

SELECT
    ID AS SellerID,
    COALESCE(Name, MerchantAlias) AS SellerName,
    MerchantType,
    AmazonSellerID,
    MarketPlaceName
FROM seller
WHERE ID IN (:seller_id_list)
  AND COALESCE(IsDeleted, 0) = 0;
