- **A result that is slow to download now says so, instead of a bare
  "operation was aborted" message.** When the service had already answered but
  the result took too long to arrive, the plugin stopped with that message and
  no next step. It now says the result did not finish downloading, and
  suggests checking the connection or asking for fewer rows or columns.
