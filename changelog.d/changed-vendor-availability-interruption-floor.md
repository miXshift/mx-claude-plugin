- **Vendor Central out-of-stock and availability-interruption figures now use
  tighter defaults.** An ASIN-day counts as out of stock at a procurable
  out-of-stock rate of 0.25 or above (was 0.99), and one of those out-of-stock
  ASIN-days also counts as an availability interruption when at least 40 sellable
  units were on hand (previously any stock at all), so the interruption count
  stays a subset of the out-of-stock count rather than a separate bucket. Both
  thresholds are overridable per run with `--oos-rate-threshold` and the new
  `--min-sellable-units`.
