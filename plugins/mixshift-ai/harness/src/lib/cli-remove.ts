/**
 * Put older installed copies of the plugin out of use, on request.
 *
 * Why this exists (mx-ops#274; owner decision: removal is OPT-IN): a plugin
 * host keeps every version it ever installed, so a scheduled task, a saved
 * prompt or a launcher link can keep running months-old code. `mixshift cli
 * remove-older` is the one safe step that fixes that. The plugin never does
 * it on its own: nothing here runs unless the person (or an agent they said
 * yes to) passes `--yes`.
 *
 * "Remove" means MOVE. One `rename` of the copy's folder into a `.trash`
 * folder, so it is reversible and the resolver (lib/cli-copies.ts skips
 * `.trash` at any depth) ignores it. Never a delete, never a recursive
 * walk of the copy, never a copy-then-delete fallback: a rename either
 * happens or it does not, so nothing is left half-moved.
 *
 * `.trash` convention (read from Claude Code's own plugin folder, not
 * guessed): Claude Code moves things it retires to
 * `<plugins folder>/.trash/<epoch-ms>-<pid>-<random>/<folder name>`, one
 * level under the scanned root, on the same volume as the cache. This module
 * uses the same shape under the scanned root a copy was found in:
 * `<root>/.trash/<epoch-ms>-<pid>-v<version>-<random>/<folder name>`. The
 * timestamp, pid and random part make the name collision-free; the version
 * makes it readable.
 *
 * A copy is removable only when ALL of these hold (see planRemoveOlder):
 *   - the scan found it, and it is under a root the scan walked;
 *   - its `.claude-plugin/plugin.json` parses and names this plugin, and
 *     `harness/dist/cli.js` exists;
 *   - its version is readable and STRICTLY LOWER than the newest copy's;
 *   - it is not the running copy and not the newest copy;
 *   - it is not under `.trash` or `marketplaces`;
 *   - the folder itself and every folder between it and its root are real
 *     folders (no symlink or junction), so its real path stays inside the root;
 *   - no other copy lives inside it;
 *   - no `installed_plugins.json` in a scanned root names it as an install path
 *     (Claude Code is still using that folder; moving it would break that install
 *     until the plugin is updated).
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { compareVersions } from './version-check.js';
import type { CliCopy, CliCopyScan } from './cli-copies.js';
import { scanShims, describeShimProblems, type ShimFinding, type ShimScanOptions } from './cli-shim.js';

/** The plugin name a removable copy's plugin.json must carry. */
export const PLUGIN_NAME = 'mixshift-ai';

export type SkipReason =
  | 'version_unknown'
  | 'running_copy'
  | 'same_version_as_newest'
  | 'not_a_plugin_copy'
  | 'outside_scanned_root'
  | 'link_in_path'
  | 'inside_trash_or_marketplace'
  | 'contains_another_copy'
  | 'registered_install';

export const SKIP_TEXT: Record<SkipReason, string> = {
  version_unknown: 'skipped: version unknown',
  running_copy: 'skipped: this is the copy running now',
  same_version_as_newest: 'skipped: same version as the newest copy',
  not_a_plugin_copy: 'skipped: not a complete MixShift plugin copy',
  outside_scanned_root: 'skipped: not inside a folder the search walked',
  link_in_path: 'skipped: the folder is, or sits behind, a link',
  inside_trash_or_marketplace: 'skipped: inside a .trash or marketplaces folder',
  contains_another_copy: 'skipped: another copy lives inside it',
  registered_install: "skipped: the plugin host's install record points at it (update the plugin first)",
};

export interface PlannedMove {
  version: string;
  /** The copy's folder (what gets moved). */
  from: string;
  /** Where it will sit afterwards. */
  to: string;
  /** The scanned root it was found under (the `.trash` sits in it). */
  root: string;
}

export interface SkippedCopy {
  version: string | null;
  path: string;
  reason: SkipReason;
}

export interface RemovePlan {
  newestVersion: string | null;
  moves: PlannedMove[];
  skipped: SkippedCopy[];
}

export interface PlanOptions {
  /** Substitute for the clock (tests). */
  now?: number;
  pid?: number;
  /** Substitute for the random suffix (tests). */
  rand?: () => string;
}

function isLinkOrMissing(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return true;
  }
}

function caseKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** True when `child` is `parent` or inside it (lexical, after resolve). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(caseKey(resolve(parent)), caseKey(resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isStrictlyInside(parent: string, child: string): boolean {
  return isInside(parent, child) && caseKey(resolve(parent)) !== caseKey(resolve(child));
}

function pluginNameOf(pluginRoot: string): string | null {
  try {
    const raw = readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8');
    const n = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof n === 'string' ? n : null;
  } catch {
    return null;
  }
}

/** Install paths a host's own record (`<root>/installed_plugins.json`) names; empty when there is none. */
function registeredInstallPaths(scan: CliCopyScan): string[] {
  const out: string[] = [];
  for (const r of scan.scannedRoots) {
    try {
      const raw = readFileSync(join(r, 'installed_plugins.json'), 'utf-8');
      const plugins = (JSON.parse(raw) as { plugins?: Record<string, unknown> }).plugins ?? {};
      for (const entries of Object.values(plugins)) {
        if (!Array.isArray(entries)) continue;
        for (const e of entries) {
          const ip = (e as { installPath?: unknown })?.installPath;
          if (typeof ip === 'string' && ip) out.push(ip);
        }
      }
    } catch {
      // no record, or unreadable: nothing registered from this root
    }
  }
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The scanned root that holds `pluginRoot`, the deepest one if several do. */
function owningRoot(scan: CliCopyScan, pluginRoot: string): string | null {
  let best: string | null = null;
  for (const r of scan.scannedRoots) {
    if (!isStrictlyInside(r, pluginRoot)) continue;
    if (best === null || resolve(r).length > resolve(best).length) best = r;
  }
  return best;
}

/** True when no folder from `root` down to `pluginRoot` is a link: the real path is the lexical path. */
function realPathStaysInRoot(root: string, pluginRoot: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const expected = join(realRoot, relative(resolve(root), resolve(pluginRoot)));
    return caseKey(realpathSync(pluginRoot)) === caseKey(expected);
  } catch {
    return false;
  }
}

/** Decide, for every copy the scan found, whether it can be moved and where to. Pure but for read-only fs checks. */
export function planRemoveOlder(scan: CliCopyScan, opts: PlanOptions = {}): RemovePlan {
  const newestVersion = scan.newest?.version ?? null;
  const plan: RemovePlan = { newestVersion, moves: [], skipped: [] };
  if (scan.newest === null || newestVersion === null) return plan;
  const now = opts.now ?? Date.now();
  const pid = opts.pid ?? process.pid;
  const rand = opts.rand ?? (() => randomBytes(3).toString('hex'));
  const registered = registeredInstallPaths(scan);

  for (const c of scan.copies) {
    if (c === scan.newest || c.isNewest) continue;
    const skip = (reason: SkipReason) => plan.skipped.push({ version: c.version, path: c.pluginRoot, reason });
    if (c.isRunning) {
      skip('running_copy');
      continue;
    }
    if (c.version === null) {
      skip('version_unknown');
      continue;
    }
    if (pluginNameOf(c.pluginRoot) !== PLUGIN_NAME || !isFile(c.path)) {
      skip('not_a_plugin_copy');
      continue;
    }
    if (compareVersions(c.version, newestVersion) >= 0) {
      skip('same_version_as_newest');
      continue;
    }
    const root = owningRoot(scan, c.pluginRoot);
    if (root === null) {
      skip('outside_scanned_root');
      continue;
    }
    const rel = relative(resolve(root), resolve(c.pluginRoot)).split(sep);
    if (rel.some((seg) => seg === '.trash' || seg === '.Trash' || seg === 'marketplaces')) {
      skip('inside_trash_or_marketplace');
      continue;
    }
    if (isLinkOrMissing(c.pluginRoot) || !realPathStaysInRoot(root, c.pluginRoot)) {
      skip('link_in_path');
      continue;
    }
    if (scan.copies.some((o) => o !== c && isStrictlyInside(c.pluginRoot, o.pluginRoot))) {
      skip('contains_another_copy');
      continue;
    }
    if (registered.some((ip) => isInside(c.pluginRoot, ip))) {
      skip('registered_install');
      continue;
    }
    const slot = `${now}-${pid}-v${c.version}-${rand()}`;
    plan.moves.push({
      version: c.version,
      from: c.pluginRoot,
      to: join(root, '.trash', slot, basename(c.pluginRoot)),
      root,
    });
  }
  return plan;
}

export interface MoveResult {
  version: string;
  from: string;
  to: string;
  moved: boolean;
  /** Short reason when not moved: the error code or a plain phrase. */
  error?: string;
}

export interface ApplyDeps {
  rename?: (from: string, to: string) => void;
}

/**
 * Carry out the plan: one rename per copy. A failure on one copy is recorded
 * and the next copy still runs. The only thing created besides the rename is
 * the `.trash/<slot>` folder; when the rename fails that folder is removed
 * again (rmdir, which refuses a non-empty folder, so it can never delete data).
 */
export function applyRemoveOlder(plan: RemovePlan, deps: ApplyDeps = {}): MoveResult[] {
  const rename = deps.rename ?? renameSync;
  const results: MoveResult[] = [];
  for (const m of plan.moves) {
    const slot = dirname(m.to);
    try {
      mkdirSync(slot, { recursive: true });
    } catch (err) {
      results.push({ version: m.version, from: m.from, to: m.to, moved: false, error: errorCode(err) });
      continue;
    }
    try {
      rename(m.from, m.to);
      results.push({ version: m.version, from: m.from, to: m.to, moved: true });
    } catch (err) {
      try {
        rmdirSync(slot);
      } catch {
        // leave an empty slot folder; it holds nothing
      }
      results.push({ version: m.version, from: m.from, to: m.to, moved: false, error: errorCode(err) });
    }
  }
  return results;
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** Plain-language cause for the codes a rename really fails with. */
export function explainError(code: string): string {
  switch (code) {
    case 'EBUSY':
    case 'EPERM':
    case 'EACCES':
      return `${code}: in use or not permitted (close anything using that copy, then run this again)`;
    case 'EXDEV':
      return 'EXDEV: the trash folder is on a different drive; nothing was moved';
    default:
      return code;
  }
}

const SAFE_PATH = /^[\w@%+=:,./\\ ~()-]+$/;

/** The exact command that puts a moved copy back. Plain words when a path has characters a shell would read. */
export function restoreCommand(m: { from: string; to: string }, platform: NodeJS.Platform = process.platform): string {
  if (!SAFE_PATH.test(m.from) || !SAFE_PATH.test(m.to)) {
    return `Move "${m.to}" back to "${m.from}".`;
  }
  return platform === 'win32'
    ? `Move-Item -LiteralPath '${m.to}' -Destination '${m.from}'`
    : `mv "${m.to}" "${m.from}"`;
}

export const SCHEDULED_TASK_WARNING =
  'A scheduled task, saved prompt or launcher link that points at a moved copy by its full path will now fail until it is updated.';

export interface LauncherInto {
  finding: ShimFinding;
  /** Where the link resolved to before the move. */
  real: string;
}

/**
 * Launcher links on this machine that resolve into a copy about to be moved.
 * Call BEFORE moving; keep only those whose copy then moved (see
 * launchersAfterMove). Reuses lib/cli-shim.ts.
 */
export function launchersInto(plan: RemovePlan, newestVersion: string | null, shimOpts: ShimScanOptions = {}): LauncherInto[] {
  let found: ShimFinding[] = [];
  try {
    found = scanShims({ ...shimOpts, newestVersion });
  } catch {
    return [];
  }
  const out: LauncherInto[] = [];
  for (const f of found) {
    if (f.state !== 'older_copy') continue;
    let real: string;
    try {
      real = realpathSync(f.path);
    } catch {
      continue;
    }
    if (plan.moves.some((m) => isStrictlyInside(m.from, real))) out.push({ finding: f, real });
  }
  return out;
}

export function launchersAfterMove(before: LauncherInto[], results: MoveResult[]): ShimFinding[] {
  const moved = results.filter((r) => r.moved);
  return before
    .filter((l) => moved.some((m) => isStrictlyInside(m.from, l.real)))
    .map((l) => l.finding);
}

/** Plain-language lines for launcher links that now point at a moved copy. */
export function describeMovedLaunchers(
  links: ShimFinding[],
  newestLauncher: string | null,
  newestVersion: string | null,
): string[] {
  return describeShimProblems(
    links.map((l) => ({ ...l, state: 'dangling' as const })),
    newestLauncher,
    newestVersion,
  );
}

/** Version strings only, for telemetry: no path ever. */
export function versionsOf(copies: Array<Pick<CliCopy, 'version'>>): string[] {
  return copies.map((c) => c.version).filter((v): v is string => v !== null);
}
