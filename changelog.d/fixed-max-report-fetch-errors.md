- **A passing service problem during Report Max no longer reads as an account with no
  data.** When fetching the report figures failed for a moment, the error could read as
  if the account had no data for the period. Report Max now retries the fetch once,
  never works from a figures file that was not written, and if the fetch still fails
  says plainly that the figures could not be fetched and why. The MixShift Intelligence
  commands also say that an engine error is usually temporary and worth a retry, and
  that a "no data for this period" answer is worth one retry before concluding the
  account has no data.
