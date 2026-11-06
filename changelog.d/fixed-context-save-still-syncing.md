- **A slow brand context save is no longer reported as failed.** When a save took
  more than a couple of seconds to reach your team, the plugin said it could not sync,
  even though it usually went up with the next sync. It now says the save is kept on
  your computer and should reach your team on the next sync, and shows how to check it
  (`mixshift context status`). A save that really fails is still reported as a
  failure, with the command to retry it.
