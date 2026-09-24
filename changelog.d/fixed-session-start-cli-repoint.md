- **After you update the plugin, a conversation you resume now runs the new
  version.** A resumed Claude Code conversation kept running the copy of MixShift
  it had started with, even though the update had installed a newer one, so the
  fixes you had just updated to never reached your commands. A resumed or
  compacted conversation now switches to the version you are on, and Claude is
  told to look the plugin up again rather than reuse an old copy's location
  from earlier in the conversation. When your organization installs MixShift
  for you, Claude Code now uses that copy directly instead of searching the
  machine for one, and wherever a search is still needed (including setting up
  a scheduled task), it picks the newest copy instead of the first one it finds.
