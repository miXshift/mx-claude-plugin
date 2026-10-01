- **Competitive Summary now works for lists longer than 20 ASINs.** Asking for
  Buy Box and competitive prices on 21 or more ASINs used to fail outright,
  because Amazon only accepts 20 at a time and the service sent more. The
  service now splits the list into batches of 20 for you, so the request
  works the first time. A single call accepts up to 100 ASINs and takes a
  few minutes; for larger lists, run it in the background and check back for the
  results.
