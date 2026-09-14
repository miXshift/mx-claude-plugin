- **Vendor Central out-of-stock and availability-interruption figures move to
  calibrated thresholds.** An ASIN-day counts as out of stock at a procurable
  out-of-stock rate of 0.25 or above (previously 0.99), and one of those
  out-of-stock ASIN-days also counts as an availability interruption when at
  least 40 sellable units were on hand (previously any stock at all), so the
  interruption count stays a subset of the out-of-stock count rather than a
  separate bucket. Both thresholds are set in the MixShift service, so the
  figures change when that change goes live rather than when you update the
  plugin, and every run reports the pair it actually applied under
  `thresholds_applied`. `mixshift report battery` carries a
  `--min-sellable-units` flag for setting the interruption floor per run,
  alongside the existing `--oos-rate-threshold`, but it only does anything once
  the service change is live: a service that predates it rejects the run on the
  unknown parameter. Leave the flag off until your Vendor Central figures move
  to the new thresholds, and let the service default apply.
