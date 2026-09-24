- **A warehouse query that runs past its time limit no longer reports a network
  problem.** On a connection that adds a few seconds, the plugin used to stop
  waiting before the service's answer arrived and say it had "timed out
  connecting", with a pointer to `mixshift doctor`. Nothing was wrong with the
  network. It now says the query did not finish within the 60 second limit and
  points at the fix: check that the date filter is on the table's own date
  column, then narrow the date range. Library queries name the query and
  suggest a narrower date range or fewer sellers.
