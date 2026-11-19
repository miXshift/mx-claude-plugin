- **A finished Amazon report no longer looks stuck when you check it with `report get`.**
  Checking a run only with `mixshift amazon report get` could keep answering
  "not ready" after Amazon had finished, until a single `report poll` moved it
  along. The report skill now says to poll until it is done and then get, and
  the not-ready message names `mixshift amazon report poll <runId>` as the next
  step.
