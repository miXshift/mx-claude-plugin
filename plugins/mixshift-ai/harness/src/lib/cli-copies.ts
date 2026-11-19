/**
 * Find every bundled `cli.js` (every installed copy of the plugin) on this
 * machine, read each copy's version, and name the newest one.
 *
 * Why this exists (feedback 3070886, 3070888; mx-ops#274 acceptance item 2):
 * a plugin host keeps every version it has ever installed under opaque
 * folders, so `find / -path '*\/harness/dist/cli.js' | head -1` can run an
 * older copy. The skills' invocation note already tells the agent to take
 * the highest version and skip `.trash`; this module is that same rule as
 * code, so `mixshift doctor` and `mixshift cli locate` can answer the
 * question once, correctly.
 *
 * Rules (the same as the skills' invocation note):
 *   - A copy is a folder holding `harness/dist/cli.js`.
 *   - Its version comes from `<plugin root>/.claude-plugin/plugin.json`,
 *     never from the path text and never by running it.
 *   - Anything under a `.trash` folder is skipped.
 *   - Versions are compared numerically (0.8.10 is newer than 0.8.9).
 *
 * The scan is bounded: a fixed set of roots, a depth cap, and a skip list
 * (`node_modules`, `.git`, `.trash`). It never walks `/`. Roots that the
 * scan does not know about (an unusual Cowork mount) are covered by the
 * skills' own `find` fallback, and a caller can pass extra roots.
 *
 * Read-only. Never throws: an unreadable folder is skipped.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compareVersions } from './version-check.js';
import { isValidVersion } from './update-notice-state.js';

export interface CliCopy {
  /** Absolute path to the copy's `harness/dist/cli.js`. */
  path: string;
  /** The plugin folder (the path minus `/harness/dist/cli.js`). */
  pluginRoot: string;
  /** From the copy's `.claude-plugin/plugin.json`; null when unreadable or
   *  not a plain version string. */
  version: string | null;
  /** True for the copy this process is running. */
  isRunning: boolean;
  /** True for the copy with the highest readable version. Ties: the running
   *  copy wins, then the most recently modified file. */
  isNewest: boolean;
}

export interface CliCopyScan {
  copies: CliCopy[];
  newest: CliCopy | null;
  running: CliCopy | null;
  scannedRoots: string[];
  /** True when the scan hit its entry budget before finishing: there may be
   *  other copies it did not see. */
  truncated: boolean;
}

export interface CliCopyScanOptions {
  /** Plugin root of the running copy (so it is always listed, even when it
   *  sits outside the default roots). */
  runningPluginRoot?: string;
  /** Extra roots to scan in addition to the defaults. */
  extraRoots?: string[];
  /** When true, scan ONLY `extraRoots` (tests, `--root`). */
  onlyExtraRoots?: boolean;
  /** Substitute for `homedir()`. */
  home?: string;
  /** Substitute for `process.platform`. */
  platform?: NodeJS.Platform;
  /** Substitute for `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Directory depth cap below each root. Default 9 (matches the skills' find). */
  maxDepth?: number;
  /** Hard cap on directory entries visited, so a huge tree cannot hang doctor. */
  maxEntries?: number;
  /** Roots walked in "plugin locations only" mode (default: `/sessions`, where
   *  Cowork mounts the person's own work folders next to the plugin). */
  restrictedRoots?: string[];
}

// `marketplaces` holds the host's clone of the marketplace repo, which carries a
// committed harness/dist/cli.js that is not an installed copy: counting it would
// make `cli locate` print it, and doctor say a newer copy is installed, whenever
// the host refreshes the clone.
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.trash',
  '.Trash',
  'marketplaces',
]);

/**
 * Below a restricted root (Cowork's `/sessions/<id>/...`), descend only into
 * folders a plugin can live in, so the walk never crawls the person's mounted
 * work folders. Best effort: a plugin mounted somewhere else is found by the
 * skills' own `find` fallback.
 */
const PLUGIN_LOCATION_NAMES: ReadonlySet<string> = new Set([
  'mnt',
  '.remote-plugins',
  '.claude',
  'plugins',
  'cache',
  'synced',
]);
export function isPluginLocationName(name: string): boolean {
  return (
    PLUGIN_LOCATION_NAMES.has(name) ||
    name.startsWith('plugin_') ||
    name.startsWith('mixshift-ai') ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(_[0-9a-f-]+)?$/i.test(name) ||
    /^\d+(\.\d+){1,3}([-+].*)?$/.test(name)
  );
}
const DEFAULT_MAX_DEPTH = 9;
const DEFAULT_MAX_ENTRIES = 200_000;

/** Roots where hosts keep plugin payloads. Existing ones only. */
export function defaultScanRoots(opts: CliCopyScanOptions = {}): string[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const roots = [join(home, '.claude', 'plugins')];
  if (platform === 'darwin') {
    roots.push(join(home, 'Library', 'Application Support', 'Claude'));
  } else if (platform === 'win32') {
    if (env.APPDATA) roots.push(join(env.APPDATA, 'Claude'));
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Claude'));
  } else {
    roots.push(join(home, '.config', 'Claude'));
    // Cowork sandboxes mount the plugin under /sessions.
    roots.push('/sessions');
  }
  return roots;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Version of the plugin folder, from plugin.json; null when not a clean version. */
export function readPluginFolderVersion(pluginRoot: string): string | null {
  try {
    const raw = readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' && isValidVersion(v) ? v : null;
  } catch {
    return null;
  }
}

function underTrash(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === '.trash' || seg === '.Trash');
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Walk `root` for folders that contain `harness/dist/cli.js`. */
function walk(
  root: string,
  maxDepth: number,
  budget: { left: number },
  found: Set<string>,
  restricted: boolean,
): boolean {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    if (budget.left <= 0) return true;
    const { dir, depth } = stack.pop()!;
    // A plugin root: has harness/dist/cli.js directly under it.
    const cli = join(dir, 'harness', 'dist', 'cli.js');
    if (isFile(cli)) {
      found.add(cli);
      continue;
    }
    if (depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      budget.left -= 1;
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      // Depth 0 children of a restricted root are the session folders themselves.
      if (restricted && depth > 0 && !isPluginLocationName(e.name)) continue;
      stack.push({ dir: join(dir, e.name), depth: depth + 1 });
    }
  }
  return false;
}

/** Pick the highest readable version; ties go to the running copy, then input order. */
function markNewest(copies: CliCopy[]): CliCopy | null {
  let best: CliCopy | null = null;
  for (const c of copies) {
    if (c.version === null) continue;
    if (best === null) {
      best = c;
      continue;
    }
    const cmp = compareVersions(c.version, best.version as string);
    if (cmp > 0 || (cmp === 0 && c.isRunning && !best.isRunning)) best = c;
  }
  if (best) best.isNewest = true;
  return best;
}

export function scanCliCopies(opts: CliCopyScanOptions = {}): CliCopyScan {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const budget = { left: opts.maxEntries ?? DEFAULT_MAX_ENTRIES };
  const roots = [
    ...(opts.onlyExtraRoots ? [] : defaultScanRoots(opts)),
    ...(opts.extraRoots ?? []),
  ];
  const scannedRoots: string[] = [];
  const found = new Set<string>();
  const restrictedRoots = (opts.restrictedRoots ?? ['/sessions']).map((r) => resolve(r));
  let truncated = false;

  if (opts.runningPluginRoot) {
    const cli = join(opts.runningPluginRoot, 'harness', 'dist', 'cli.js');
    if (isFile(cli)) found.add(cli);
  }
  for (const root of roots) {
    if (!isDir(root)) continue;
    scannedRoots.push(root);
    if (walk(root, maxDepth, budget, found, restrictedRoots.includes(resolve(root)))) truncated = true;
  }

  const copies: CliCopy[] = [];
  const seen: string[] = [];
  for (const cli of [...found].sort()) {
    if (underTrash(cli)) continue;
    // The same folder can be reached through two roots or a link; list it once.
    if (seen.some((s) => sameFile(s, cli))) continue;
    seen.push(cli);
    const pluginRoot = dirname(dirname(dirname(cli)));
    copies.push({
      path: cli,
      pluginRoot,
      version: readPluginFolderVersion(pluginRoot),
      isRunning:
        opts.runningPluginRoot !== undefined &&
        sameFile(pluginRoot, opts.runningPluginRoot),
      isNewest: false,
    });
  }
  const newest = markNewest(copies);
  return {
    copies,
    newest,
    running: copies.find((c) => c.isRunning) ?? null,
    scannedRoots,
    truncated,
  };
}

/** Newest first; unreadable versions last. */
export function sortCopiesNewestFirst(copies: CliCopy[]): CliCopy[] {
  return [...copies].sort((a, b) => {
    if (a.version === null && b.version === null) return a.path.localeCompare(b.path);
    if (a.version === null) return 1;
    if (b.version === null) return -1;
    return compareVersions(b.version, a.version) || a.path.localeCompare(b.path);
  });
}
