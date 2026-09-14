- **Vendor Central out-of-stock and availability-interruption figures now use
  tighter defaults.** An ASIN-day counts as out of stock at a procurable
  out-of-stock rate of 0.25 or above (was 0.99), and counts as an availability
  interruption only when at least 40 sellable units were on hand (previously any
  stock at all). Both are overridable per run with `--oos-rate-threshold` and the
  new `--min-sellable-units`, and every figures document now states the rule it
  applied in `thresholds_applied`.
