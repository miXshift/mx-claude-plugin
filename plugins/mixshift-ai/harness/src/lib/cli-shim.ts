/**
 * Detect a `mixshift` link on PATH (or in the usual user bin folders)
 * that no longer works, or that points at an older plugin copy.
 *
 * Why this exists (feedback 3070888): after a plugin folder moved, a
 * `~/.local/bin/mixshift` symlink was left pointing at the old folder, so a
 * bare `mixshift` failed. The plugin never creates that file. Its only
 * PATH registration is the SessionStart hook writing an export into the
 * session's env file; the one documented symlink is the manual
 * `ln -sf <clone>/.../harness/bin/mixshift /usr/local/bin/mixshift` in
 * docs/install/cli-direct.md. So whoever (or whatever agent) made the link
 * owns it, and the plugin cannot repair it. `doctor` can say what it found
 * and how to fix it.
 *
 * Read-only. Never throws.
 */

import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { compareVersions } from './version-check.js';
import { readPluginFolderVersion } from './cli-copies.js';

export type ShimState =
  /** A symlink whose target does not exist. */
  | 'dangling'
  /** Works, and points into a plugin copy older than the newest one found. */
  | 'older_copy'
  /** Works (target exists); nothing to say. */
  | 'ok';

export interface ShimFinding {
  /** The launcher path (the symlink or file named `mixshift`). */
  path: string;
  state: ShimState;
  /** Symlink target as written, when the launcher is a symlink. */
  target: string | null;
  /** Version of the plugin copy the launcher resolves to, when readable. */
  version: string | null;
}

export interface ShimScanOptions {
  home?: string;
  /** Substitute for `process.env.PATH`. */
  pathEnv?: string;
  /** Newest installed copy's version, so an older-copy shim can be named. */
  newestVersion?: string | null;
  /** Extra directories to look in besides PATH and the user bin folders. */
  extraDirs?: string[];
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * 'present', 'missing' (the target is really gone: ENOENT, or ENOTDIR when a
 * parent is no longer a folder), or 'unknown' for any other failure (EACCES on
 * a folder we cannot enter, ELOOP on a link loop, ...). Only 'missing' may be
 * called dangling: for 'unknown' we cannot say the target is gone.
 */
function targetState(p: string): 'present' | 'missing' | 'unknown' {
  try {
    statSync(p);
    return 'present';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
}

/** Candidate launcher names. Windows hosts use `.cmd`/`.ps1` wrappers. */
function launcherNames(): string[] {
  return process.platform === 'win32'
    ? ['mixshift', 'mixshift.cmd', 'mixshift.ps1']
    : ['mixshift'];
}

/**
 * `<plugin>/harness/bin/mixshift` -> `<plugin>`. Null when the resolved path
 * is not shaped like one of our launchers.
 */
function pluginRootOfLauncher(realPath: string): string | null {
  const norm = realPath.replace(/\\/g, '/');
  if (!/\/harness\/(bin\/mixshift|dist\/cli\.js)$/.test(norm)) return null;
  return resolve(dirname(realPath), '..', '..');
}

export function scanShims(opts: ShimScanOptions = {}): ShimFinding[] {
  const home = opts.home ?? homedir();
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const dirs = [
    ...pathEnv.split(delimiter).filter((d) => d && isAbsolute(d)),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    '/usr/local/bin',
    ...(opts.extraDirs ?? []),
  ];
  const out: ShimFinding[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of launcherNames()) {
      const p = join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      const st = lstatSafe(p);
      if (!st) continue;
      // Only links are candidates. A regular file named `mixshift` on PATH is the
      // plugin's own launcher (the session hook puts harness/bin on PATH); it is
      // never a stale shim and must never be offered for removal.
      if (!st.isSymbolicLink()) continue;
      let target: string | null = null;
      try {
        target = readlinkSync(p);
      } catch {
        target = null;
      }
      const state = targetState(p);
      if (state === 'unknown') continue;
      if (state === 'missing') {
        out.push({ path: p, state: 'dangling', target, version: null });
        continue;
      }
      let version: string | null = null;
      try {
        const root = pluginRootOfLauncher(realpathSync(p));
        if (root) version = readPluginFolderVersion(root);
      } catch {
        version = null;
      }
      const older =
        version !== null &&
        opts.newestVersion != null &&
        compareVersions(version, opts.newestVersion) < 0;
      out.push({ path: p, state: older ? 'older_copy' : 'ok', target, version });
    }
  }
  return out;
}

/** Display-only paths go into copy-paste commands; refuse any with shell metacharacters. */
const SAFE_PATH = /^[\w@%+=:,./\\ ~()-]+$/;
function safe(p: string): boolean {
  return SAFE_PATH.test(p);
}

/**
 * Plain-language lines for the findings that need attention (dangling or
 * older-copy). Empty when everything found is fine or nothing was found.
 * `newestLauncher` is the newest copy's `harness/bin/mixshift`, offered as a
 * re-point target when known.
 */
export function describeShimProblems(
  findings: ShimFinding[],
  newestLauncher: string | null,
  newestVersion: string | null = null,
): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    if (f.state === 'dangling') {
      lines.push(
        `${f.path} is a link to ${f.target ?? '(unreadable)'}, which no longer exists (the plugin folder it pointed at was moved or removed).`,
      );
      if (safe(f.path)) lines.push(`  Remove it: rm "${f.path}"`);
      lines.push(
        '  The plugin does not create this file, so nothing will recreate it; inside Claude Code the plugin puts `mixshift` on PATH for you.',
      );
      if (newestLauncher && safe(newestLauncher) && safe(f.path)) {
        lines.push(
          `  Or point it at the newest copy (this breaks again the next time the plugin folder changes): ln -sf "${newestLauncher}" "${f.path}"`,
        );
      }
    } else if (f.state === 'older_copy') {
      // A working link may be someone's only terminal launcher (the CLI-direct
      // install doc has people create one): never advise removing it.
      lines.push(
        `${f.path} works, but it runs plugin copy ${f.version}` +
          (newestVersion ? `, and a newer copy (${newestVersion}) is installed.` : ', not the newest installed copy.'),
      );
      if (newestLauncher && safe(newestLauncher) && safe(f.path)) {
        lines.push(`  To use the newest copy: ln -sf "${newestLauncher}" "${f.path}"`);
        lines.push('  (a link under /usr/local/bin usually needs sudo in front of ln.)');
      }
    }
  }
  return lines;
}
