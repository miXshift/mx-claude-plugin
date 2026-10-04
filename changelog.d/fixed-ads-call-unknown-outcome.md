- **A report request or a bid change that loses its answer no longer tells you
  to just try again.** When a call that creates a report or applies a change
  times out or loses its answer, the plugin now says it may already have gone
  through and to check before sending it again, instead of calling the service
  unreachable. Resending a report request can create a duplicate report. The
  plugin also waits longer for these calls (90 seconds), so a slow report
  request is less likely to be cut off. With `--json`, these failures, and the
  ones MixShift itself reports this way, carry `request_outcome: "unknown"`.
