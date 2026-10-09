- **On Windows, commands no longer end with "Assertion failed" and a failure code
  after they worked.** With Node 24 on Windows, most `mixshift` commands finished by
  printing `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exiting as if
  they had failed, so scripts and Claude could read a successful command as a failed
  one. The plugin's daily update check hit the same problem, so on Windows the "a newer
  version is available" notice could go missing. This was a Node.js bug on Windows
  triggered by how the plugin exited after a network request. Commands now exit
  cleanly with the right code, and the update notice shows again.
