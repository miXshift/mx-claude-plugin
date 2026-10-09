- **On Windows, commands no longer end with "Assertion failed" and a failure code
  after they worked.** With Node 24 on Windows, almost every `mixshift` command (and
  the plugin's start-of-session check) finished by printing
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exiting as if it had
  failed, so scripts and Claude could read a successful command as a failed one. This
  was a Node.js bug on Windows triggered by how the plugin exited after sending a
  network request. Commands now exit cleanly with the right code.
