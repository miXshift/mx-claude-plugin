- **Feedback and usage reports are no longer lost when several commands run at
  once, and one that can't be stored no longer holds up the rest.** When your
  assistant ran MixShift commands in parallel, a report written by one of them
  could be lost before it was sent. And a single report the server could not
  store could hold up every report queued behind it on that computer. Reports
  now wait on your computer until they are sent; one the server refuses is set
  aside there instead of blocking the others, is tried again after your next
  plugin update, and `mixshift telemetry status` tells you if any are waiting.
