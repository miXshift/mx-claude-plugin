- **A flag given the wrong kind of value now says which flag and what to pass.**
  Passing JSON to `--query` or `--path` on `amazon call` or `ads call`, or an
  AmazonSellerID to `--seller-id` on the `data` commands, used to stop with
  "Expected k=v" or "Expected integer", which named neither the flag nor the
  fix, so the assistant often got it wrong again on the next try. The message
  now names the flag and the right form: one `--query key=value` per parameter,
  with the corrected flags spelled out for the value you passed and JSON sent in
  `--body`, and for `data --seller-id` the numeric warehouse SellerID from the
  `legacySellerId` column of `mixshift amazon merchants`. With `--json`, these
  errors and an unknown or missing option now return the same
  `{"status": "error"}` result as every other failure instead of plain text. The
  data exploration guidance also no longer suggests a `--seller-id` flag on
  `data query`, which does not have one.
