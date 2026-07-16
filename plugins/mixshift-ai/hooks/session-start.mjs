#!/usr/bin/env node
/**
 * SessionStart hook: register the `mixshift` CLI shim on the session's PATH.
 *
 * The claude.ai plugin validator forbids top-level bin/ executables (which the
 * CLI runtime used to PATH-register automatically), so the shim now lives at
 * harness/bin/mixshift and this hook performs the PATH registration instead,
 * by appending an export to the session env file the host exposes via
 * CLAUDE_ENV_FILE (sourced by the Bash tool).
 *
 * Contract: fast, offline, and silent. This hook must NEVER block or fail a
 * session start — on any error it exits 0 having done nothing, and skills
 * fall back to `node "$CLAUDE_PLUGIN_ROOT/harness/dist/cli.js"`.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const pluginRoot =
      process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    let binDir = join(pluginRoot, 'harness', 'bin');
    if (process.platform === 'win32') {
      // The env file is sourced by Git Bash, whose PATH is colon-separated —
      // a `C:/...` entry would split at the drive colon. Use the /c/... form.
      binDir = binDir.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
    }
    const exportLine = `export PATH="${binDir}:$PATH"`;
    // SessionStart fires more than once per session (startup, then again on
    // every resume/compact) against the SAME env file — append only once.
    let already = false;
    try {
      already = readFileSync(envFile, 'utf8').includes(exportLine);
    } catch {}
    if (!already) appendFileSync(envFile, `\n${exportLine}\n`);
  }
} catch {
  // Never surface errors from a session-start hook; fallback invocation covers us.
}
process.exit(0);
