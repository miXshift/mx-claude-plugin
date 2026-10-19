- **Walmart ads changes now come back with a change id.** Every committed
  Walmart change, and its preview, is recorded in MixShift's change log, and
  the reply carries the record's id (`auditId`), shown in the call output.
  A committed change also returns the entities' values from before the change.
  If Walmart does not confirm a change (no answer, or the answer was cut off),
  the failure now says the outcome is unknown and carries the same id, so you
  can check the entity before trying again.
