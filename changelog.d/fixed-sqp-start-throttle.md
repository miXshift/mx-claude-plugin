- **A report request that Amazon rate-limits now waits and asks again, instead
  of failing immediately.** Asking Amazon to build a report can come back "too
  many requests", which is a momentary condition and not a problem with the
  request. Waiting on a report that already exists has always handled that
  gracefully; asking for one in the first place did not, so a busy moment ended
  the whole pull and anything running it on a schedule recorded a failure and
  tried again from scratch on its own timer. Both sides now behave the same way:
  wait a little longer each time, then ask again, within the time budget you set.
  A request that is genuinely wrong still fails straight away rather than being
  retried.
