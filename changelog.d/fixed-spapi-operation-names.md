- **A wrong live-lookup operation name now tells the agent the right one.** Agents
  were guessing operation names such as `product_pricing.get_item_offers` or
  `catalog.get_catalog_item`, getting refused, and trying again several times. The
  Amazon Retail skill now lists the exact names for the common lookups (offers,
  catalog item, orders, listings, vendor orders), and a refused name shows the
  nearest valid operations once the service is updated, in the text output and as
  `suggested_operations` in `--json`.
