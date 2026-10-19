- **A call MixShift refuses before it reaches Amazon now says so, with the fix.**
  When a request has a parameter missing, one it does not take, or an
  operation name that does not exist, MixShift stops it before anything is
  sent to Amazon and says what to change. The plugin labelled these as an
  unexpected failure and the skills told the agent to try again shortly, so
  agents re-sent the identical call several times before reading the message.
  They now arrive as `invalid_request` (exit code 15) with the `fix` and the
  parameter names. Every failure the MixShift service answers on the Amazon
  and Walmart commands also says in `--json` who has to act (`source`) and
  whether retrying can help (`retryable`), and, when Amazon answered, gives
  Amazon's own status, code and message (`amazon`). The Amazon and Walmart
  skills tell the agent not to resend a refused call unchanged.
