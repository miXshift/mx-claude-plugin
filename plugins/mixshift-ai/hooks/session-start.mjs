#!/usr/bin/env node
/**
 * SessionStart hook: register the `mixshift` CLI shim on the session's PATH.
 *
 * The claude.ai plugin validator forbids top-level bin/ executables (which the
 * CLI runtime used to PATH-register automatically), so the shim now lives at
 * harness/bin/mixshift and this hook performs the PATH registration instead,
 * by appending exports to the session env file the host exposes via
 * CLAUDE_ENV_FILE (sourced by the Bash tool). It also exports MIXSHIFT_CLI
 * (absolute path to the bundled cli.js) so skills have a PATH-independent
 * invocation: `node "$MIXSHIFT_CLI" <args>`.
 *
 * Contract: fast, offline, and silent. This hook must NEVER block or fail a
 * session start — on any error it exits 0 having done nothing, and skills
 * fall back to resolving the plugin root from their own base directory.
 *
 * Security: the exported lines are sourced by every Bash invocation of the
 * session, so the interpolated paths are (a) restricted to a conservative
 * character allowlist and (b) single-quoted. If the install path fails the
 * allowlist, we write nothing rather than risk a malformed or injectable
 * line; skills' fallback covers functionality.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = '# mixshift-ai session PATH registration';
const SAFE = /^[A-Za-z0-9 _/:.\-]+$/;

function posixify(p) {
  if (process.platform !== 'win32') return p;
  // The env file is sourced by Git Bash, whose PATH is colon-separated —
  // a `C:/...` entry would split at the drive colon. Use the /c/... form.
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`);
}

try {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (envFile) {
    const pluginRoot =
      process.env.CLAUDE_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
    const binDir = posixify(join(pluginRoot, 'harness', 'bin'));
    const cliPath = posixify(join(pluginRoot, 'harness', 'dist', 'cli.js'));
    if (SAFE.test(binDir) && SAFE.test(cliPath)) {
      // SessionStart fires more than once per session (startup, then again on
      // every resume/compact) against the SAME env file — append only once.
      let already = false;
      try {
        already = readFileSync(envFile, 'utf8').includes(MARKER);
      } catch {}
      if (!already) {
        appendFileSync(
          envFile,
          `\n${MARKER}\nexport PATH='${binDir}':"$PATH"\nexport MIXSHIFT_CLI='${cliPath}'\n`
        );
      }
    }
  }
} catch {
  // Never surface errors from a session-start hook; fallback invocation covers us.
}
process.exit(0);
