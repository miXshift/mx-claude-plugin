- **You can now retire a brand your team no longer works on, and bring it back
  any time.** When a client leaves, or a brand turns out to be a duplicate,
  `mixshift brand retire <slug>` (or say "retire Acme Snacks" in chat) stops it
  showing as an active brand in your team's shared brand context, and bulk
  context syncs skip it with a one-line note, for everyone on your team.
  Nothing is deleted: its brand context docs and their history, its timeline,
  its Amazon accounts, billing, reports and totals all stay as they are, and
  run files never leave your computer. The command tells you who the change was
  recorded as, whether your local copy can now be deleted, and the exact undo,
  `mixshift brand restore <slug>`. Teammates who still ask for the brand by
  name get it, with a note saying who retired it and when; `brand list` hides
  retired brands unless you add `--all`; and a scheduled task that names a
  retired brand still runs, with a warning, instead of stopping (tasks set up
  from now on skip that brand and say so at the top of their output).
  `mixshift brand archive`, which used to do nothing, now does the same as
  retire. Retiring needs the MixShift service update that ships alongside this
  release; until it is live, the command says so and changes nothing.
