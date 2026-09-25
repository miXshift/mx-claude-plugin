- **A result that is slow to download now says so, instead of reading as a slow
  query.** When the service had already answered but a large result took too
  long to arrive over a slow connection, the plugin stopped with a bare
  "operation was aborted" message or treated it as a slow query, and narrowing
  the date range would not have helped. It now says the result did not finish
  downloading, and suggests checking the connection or asking for fewer columns
  or rows.
