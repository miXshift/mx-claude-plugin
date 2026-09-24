- **After you update the plugin, a conversation you resume now runs the new
  version.** A resumed Claude Code conversation kept running the copy of MixShift
  it had started with, even though the update had installed a newer one, so the
  fixes you had just updated to never reached your commands. A resumed
  conversation now switches to the version you are on, and skills no longer
  carry an old copy's location forward from earlier in the conversation.
  Setting up a scheduled task also picks the newest copy when a machine holds
  several, instead of the first one it finds.
