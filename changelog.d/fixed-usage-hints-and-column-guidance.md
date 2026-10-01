- **A wrong guess now tells your assistant the right command or column, so it
  recovers on the next try instead of stopping.** `mixshift auth status` is now
  a real command: it shows whether you are signed in, as whom, which tenant
  login, and when the access token expires, without signing you in or touching
  the network (and when you are signed out it says how to sign in from a chat).
  Passing `--seller-id` to `mixshift data query` now explains that data query
  takes SQL and the seller goes in the SQL (`WHERE SellerID = ...`), and common
  mistyped commands such as `data tables`, `amazon list` or `amazon ops` name
  the command that exists. A query that fails on a column that does not exist
  now points to `mixshift data describe <table>`, a reserved word used as a
  column name (like `rows` or `lines`) is called out with the fix, and the
  table notes now list the wrong column names people most often try on
  `seller`, `campaign`, `campaignmetric`, `business_reports_dpst_sku` and
  `vendor_items`.
