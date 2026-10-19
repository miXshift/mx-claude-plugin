- **A call MixShift refuses before it reaches Amazon now says so, with the fix.**
  When a request has a parameter missing, one it does not take, or an
  operation name that does not exist, MixShift stops it before anything is
  sent to Amazon and says what to change. The plugin used to report these as
  an "unexpected failure, try again shortly", so agents re-sent the identical
  call several times before reading the message. They now arrive as
  `invalid_request` (exit code 15) with the `fix`, and every Amazon and Walmart
  failure in `--json` also says who has to act (`source`), whether retrying can
  help (`retryable`), and, when Amazon answered, Amazon's own status, code and
  message (`amazon`). The Amazon and Walmart skills tell the agent not to
  resend a refused call unchanged.
