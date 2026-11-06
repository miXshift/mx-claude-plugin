- **A passing service problem during Report Max no longer reads as an account with no
  data.** When fetching the report figures failed for a moment, the error could read as
  if the account had no data for the period. Report Max now starts one fresh run, never
  works from a figures file that was not written, and if the fresh run fails too says
  plainly that the figures could not be fetched and why. The MixShift Intelligence
  commands also say that an engine error is usually temporary, and that a "no data for
  this period" answer is worth one fresh run before concluding the account has no data.
