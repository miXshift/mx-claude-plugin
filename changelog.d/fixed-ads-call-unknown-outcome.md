- **A slow Ads call no longer tells you to just try again.** When a call that
  creates a report or changes a bid takes too long to answer, the plugin now says
  it may already have gone through and to check before sending it again, instead
  of calling the service unreachable. Resending a report request can create a
  duplicate report. The plugin also waits longer for these calls (90 seconds), so
  it no longer gives up before MixShift does. With `--json`, these failures carry
  `request_outcome: "unknown"`.
