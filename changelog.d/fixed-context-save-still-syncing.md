- **A brand context save that is still syncing is no longer reported as failed.** When
  a save took more than a couple of seconds to reach your team, the plugin said it
  could not sync, even though the save went through shortly after. It now says the
  save is still syncing and will finish in the background, and shows how to check it
  (`mixshift context status`). A save that really fails is still reported as a
  failure, with the command to retry it.
