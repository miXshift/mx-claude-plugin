- **`amazon call listings.patch_listings_item` checks a change set before
  sending it.** A change set holds 1 to 10 items (split more SKUs into several
  change sets) with at most 20 patches per item, and nothing beside `items`. One
  outside these limits, an empty one, or a body with extra keys is refused with
  the reason and nothing is sent, instead of failing at the service. The limits
  are in `amazon call --help`. A body whose `mode` is `"preview"` is no longer
  turned into a commit by `--commit`: the two must agree.
