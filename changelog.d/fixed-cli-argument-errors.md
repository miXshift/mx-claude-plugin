- **A flag given the wrong kind of value now says which flag and what to pass.**
  Passing JSON to `--query` or `--path` on `amazon call` or `ads call`, or an
  AmazonSellerID to `--seller-id` on the `data` commands, used to stop with
  "Expected k=v" or "Expected integer", which named neither the flag nor the
  fix, so the assistant often got it wrong again on the next try. For `--query`
  and `--path`, the message now says to pass one `key=value` per flag and
  spells out the corrected flags for the value you passed. For
  `data --seller-id`, it points to the numeric warehouse SellerID in the
  `legacySellerId` column of `mixshift amazon merchants`. With `--json`, these
  errors and an unknown or missing option now return the same
  `{"status": "error"}` result as every other failure instead of plain text. The
  data exploration guidance also no longer suggests a `--seller-id` flag on
  `data query`, which does not have one.
