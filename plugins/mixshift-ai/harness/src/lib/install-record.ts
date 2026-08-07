/**
 * Read the HOST's plugin install record and compare it to the RUNNING
 * payload this process loaded.
 *
 * Why this exists (feedback 36645/36672/36728 — three reports refining one
 * bug; the third is the definitive one): `getPluginVersion()`
 * (./plugin-version.ts) reports the
 * version of the bundle THIS PROCESS extracted, memoized once at startup and
 * never re-read. A plugin host (Claude Code / the desktop app) extracts that
 * payload once per APP LAUNCH — a new chat/session inside the same running
 * app process reuses the exact same extracted payload. So when a real update
 * had already landed on disk (`claude plugin update` succeeded, or the host
 * auto-synced a new payload) but the app process itself was never fully
 * quit-and-relaunched, `mixshift version`/`doctor` had no way to see that:
 * they could only compare the running payload against the latest PUBLISHED
 * version, and told users who were already caught up on disk to go update
 * again. Worse, a single leaked/orphaned app process can survive a full
 * quit-and-relaunch (a second window opens, the old process never exits) and
 * keep serving the old payload invisibly — "I quit and reopened and it's
 * still telling me to update" is real and this module is what lets the
 * tools name that situation instead of repeating generic update copy at it.
 *
 * `installed_plugins.json` is the host's own record of what IS on disk
 * right now, written by the plugin manager on install/update — independent
 * of any running process's memoized state. Reading it (read-only,
 * best-effort) is what lets version/doctor tell "installed vs running" apart
 * from "running vs latest published on the marketplace."
 *
 * SURFACE CONDITIONING: cloud Cowork runs the plugin payload from a
 * `.remote-plugins` mount (see lib/telemetry/surface.ts header) and has NO
 * `~/.claude/plugins` tree at all — there is nothing to read there, ever.
 * Skip the filesystem call entirely on that surface and say so plainly
 * rather than reporting a misleading "not found" that looks like a bug.
 *
 * SECURITY: this file is plain JSON, editable by anything with filesystem
 * access, and its `version` field would otherwise feed a model-directed
 * report (exactly the concern update-notice-state.ts's VERSION_RE guards
 * against for the update-notice cache). Every version string extracted here
 * is gated through that SAME `isValidVersion()` shape check before it is
 * ever trusted. A record that fails validation, or a file that's missing,
 * malformed, or an unexpected shape, resolves to `null` — this module NEVER
 * throws. Every null path logs a debug-level reason (gated on
 * `MIXSHIFT_DEBUG`, mirroring the convention in
 * lib/context-sync/push-after-write.ts's `debugLog`) so a developer can see
 * WHY without that detail ever reaching a user-facing report — callers show
 * one generic "could not be verified" line regardless of the specific
 * reason.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidVersion } from './update-notice-state.js';
import { detectSurface, type Surface } from './telemetry/surface.js';
import { compareVersions } from './version-check.js';

/** The key installed_plugins.json uses for this plugin: `<name>@<marketplace>`. */
const PLUGIN_KEY = 'mixshift-ai@mixshift';

/** Surfaces with NO `~/.claude/plugins` tree to read — see module header. */
const SURFACES_WITHOUT_INSTALL_RECORD: ReadonlySet<Surface> = new Set(['cowork']);

export interface InstallRecord {
  /** The version the HOST believes is installed on disk right now. Always
   *  passes isValidVersion() — never a raw, unvalidated string. */
  installedVersion: string;
  /** Absolute path the host extracted the plugin to (its cache dir), when
   *  present and shaped like a plausible path. */
  installPath: string | null;
  /** Git commit SHA the host recorded for this install, when present and
   *  shaped like a plausible SHA (hex, 7-40 chars). */
  gitCommitSha: string | null;
  /** ISO timestamp of the host's last recorded update, when present and
   *  parseable. */
  lastUpdated: string | null;
}

/** Machine-readable reason the record could not be resolved. Never shown to
 *  the user verbatim — callers render one generic line off `record === null`;
 *  this is for the debug log and for tests to assert on. */
export type InstallRecordUnavailableReason =
  | 'unsupported_surface'
  | 'not_found'
  | 'read_error'
  | 'malformed_json'
  | 'unexpected_shape'
  | 'no_entries'
  | 'no_matching_entry'
  | 'invalid_version';

export interface InstallRecordProbe {
  record: InstallRecord | null;
  /** Set iff record is null. */
  reason?: InstallRecordUnavailableReason;
  /** Extra detail for the debug log only (e.g. the underlying error message). */
  detail?: string;
}

export interface ReadInstallRecordOptions {
  /** Test escape hatch: substitute for `homedir()`. */
  homeOverride?: string;
  /** Test escape hatch: substitute for `detectSurface()`. */
  surfaceOverride?: Surface;
  /** Test escape hatch: substitute for `process.cwd()` (used to disambiguate
   *  multiple local-scope install entries by projectPath). */
  cwdOverride?: string;
}

function installedPluginsPath(homeOverride?: string): string {
  return join(homeOverride ?? homedir(), '.claude', 'plugins', 'installed_plugins.json');
}

/** Plausible git SHA: hex, 7-40 chars (short or full). Loose on purpose — this
 *  is a display value, not used to check out anything. */
function isPlausibleSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v);
}

/** Plausible timestamp: a non-empty string node can actually parse as a date.
 *  Bounded length so a pathological string can't be smuggled through as
 *  "just a timestamp". */
function isPlausibleTimestamp(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 64 &&
    !Number.isNaN(Date.parse(v))
  );
}

/** Plausible filesystem path: non-empty string, no control characters,
 *  bounded length. Display-only; never joined into another path. */
function isPlausiblePath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(v)
  );
}

interface RawEntry {
  scope?: unknown;
  projectPath?: unknown;
  installPath?: unknown;
  version?: unknown;
  installedAt?: unknown;
  lastUpdated?: unknown;
  gitCommitSha?: unknown;
}

/**
 * Diagnostic counterpart of {@link readInstallRecord}: returns the resolved
 * record AND, when null, a machine-readable reason + free-text detail for
 * the debug log. `readInstallRecord()` delegates to this so the two can
 * never drift (mirrors the detectSurface()/probeSurface() split in
 * lib/telemetry/surface.ts).
 */
export async function probeInstallRecord(
  opts: ReadInstallRecordOptions = {},
): Promise<InstallRecordProbe> {
  const surface = opts.surfaceOverride ?? detectSurface();
  if (SURFACES_WITHOUT_INSTALL_RECORD.has(surface)) {
    return fail(
      'unsupported_surface',
      `surface ${surface} has no host-side plugin store to read`,
    );
  }

  const path = installedPluginsPath(opts.homeOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return fail('not_found', `no file at ${path}`);
    }
    return fail(
      'read_error',
      err instanceof Error ? err.message : String(err),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(
      'malformed_json',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('unexpected_shape', 'top-level value is not an object');
  }
  const pluginsField = (parsed as Record<string, unknown>).plugins;
  if (!pluginsField || typeof pluginsField !== 'object' || Array.isArray(pluginsField)) {
    return fail('unexpected_shape', '"plugins" is missing or not an object');
  }

  const entriesField = (pluginsField as Record<string, unknown>)[PLUGIN_KEY];
  if (entriesField === undefined) {
    return fail('no_entries', `no "${PLUGIN_KEY}" key under "plugins"`);
  }
  if (!Array.isArray(entriesField)) {
    return fail(
      'unexpected_shape',
      `"plugins"."${PLUGIN_KEY}" is not an array`,
    );
  }
  if (entriesField.length === 0) {
    return fail('no_entries', `"plugins"."${PLUGIN_KEY}" is an empty array`);
  }

  // Keep only entries whose version passes the strict validator — an entry
  // with an unparseable/poisoned version is worse than no entry, so drop it
  // rather than let it win a "only one left" selection by default.
  const valid = (entriesField as RawEntry[]).filter((e) => isValidVersion(e?.version));
  if (valid.length === 0) {
    return fail(
      'invalid_version',
      `every entry's version field failed isValidVersion (${entriesField.length} entries checked)`,
    );
  }

  const chosen = selectEntry(valid, opts.cwdOverride);
  if (!chosen) {
    return fail(
      'no_matching_entry',
      `${valid.length} valid entries for "${PLUGIN_KEY}"; none matched the current project and no single/user-scope entry to prefer`,
    );
  }

  return {
    record: {
      // Re-validated by selectEntry's input filter; isValidVersion narrows.
      installedVersion: chosen.version as string,
      installPath: isPlausiblePath(chosen.installPath) ? chosen.installPath : null,
      gitCommitSha: isPlausibleSha(chosen.gitCommitSha) ? chosen.gitCommitSha : null,
      lastUpdated: isPlausibleTimestamp(chosen.lastUpdated) ? chosen.lastUpdated : null,
    },
  };
}

/**
 * Choose which install entry represents "this install" when
 * `installed_plugins.json` holds more than one (e.g. a plugin added at both
 * `user` scope and `local` scope for a specific project, or added locally in
 * several different project directories). Precedence:
 *   1. Exactly one valid entry — no ambiguity, use it.
 *   2. A `local`-scope entry whose `projectPath` matches the current working
 *      directory — the one this invocation is actually running under.
 *   3. Exactly one `user`-scope entry (a global install) when no local match
 *      fired — global installs aren't tied to a project, so there's nothing
 *      more specific to prefer.
 *   4. Otherwise: genuinely ambiguous (two+ local installs for different
 *      projects, none matching cwd, with no user-scope tiebreaker) — return
 *      null rather than guess. Reporting a wrong install to the user is
 *      worse than saying "could not be verified".
 */
function selectEntry(entries: RawEntry[], cwdOverride?: string): RawEntry | null {
  if (entries.length === 1) return entries[0];

  const cwd = cwdOverride ?? process.cwd();
  const localMatch = entries.find(
    (e) => e.scope === 'local' && typeof e.projectPath === 'string' && e.projectPath === cwd,
  );
  if (localMatch) return localMatch;

  const userScoped = entries.filter((e) => e.scope === 'user');
  if (userScoped.length === 1) return userScoped[0];

  return null;
}

function fail(
  reason: InstallRecordUnavailableReason,
  detail: string,
): InstallRecordProbe {
  debugLog(`install-record unavailable (${reason}): ${detail}`);
  return { record: null, reason, detail };
}

function debugLog(message: string): void {
  if (process.env.MIXSHIFT_DEBUG) process.stderr.write(`[debug] ${message}\n`);
}

/**
 * Resolve the host's install record for mixshift-ai, or `null` if it can't
 * be determined (missing/malformed file, unsupported surface, invalid
 * version, or an unresolvable multi-entry ambiguity). Never throws.
 */
export async function readInstallRecord(
  opts: ReadInstallRecordOptions = {},
): Promise<InstallRecord | null> {
  return (await probeInstallRecord(opts)).record;
}

// ---------------------------------------------------------------------------
// Comparison — the actual fix for feedback 36645/36672/36728: what the
// running session should say once it knows the host's install record.
// Shared by commands/version.ts and commands/doctor.ts so the two surfaces
// (and their tests) can't drift on the definition of "behind" or "stale".
// ---------------------------------------------------------------------------

/** Mirrors the tag-URL template in lib/version-check.ts's private
 *  RELEASES_TAG_BASE. Not imported from there — that module's scope for this
 *  fix is renderUpdateBanner's copy only, and this is a one-line literal, not
 *  logic worth sharing a dependency over. */
const RELEASE_TAG_URL_PREFIX =
  'https://github.com/miXshift/mx-claude-plugin/releases/tag/mixshift-ai--v';

/**
 * Shared copy for the "you already updated, this session just hasn't
 * reloaded it" situation — the exact bug in feedback 36645/36672/36728.
 * Lives here (not duplicated in commands/version.ts and commands/doctor.ts)
 * so the two surfaces can never drift on what this message says. Takes only
 * the fields it needs rather than a command-specific report shape, so both
 * callers can pass their own field names straight through.
 *
 * `sessionBehindInstall` and `isStale` are INDEPENDENT facts:
 * `sessionBehindInstall` compares this session's running payload against the
 * host's install record, while `isStale` compares that SAME install record
 * against the latest published release. Both can be true at once (current <
 * installed < latest), and callers must not treat them as mutually
 * exclusive: hiding the fact that a further update exists just because this
 * session already has some catching up to do left a real available update
 * invisible. `installIsStale` tells this function which of the two mutually
 * exclusive COPY VARIANTS to use — "the update already succeeded" is only
 * true when the install record is itself caught up to `latest`.
 */
export function renderSessionBehindInstall(opts: {
  installed: string | null;
  current: string;
  /** True iff the install record itself is behind `latest` — a further
   *  release exists beyond what's already installed. When true, "the update
   *  already succeeded" would be false, so the copy must say so instead of
   *  asserting it. Defaults to false (the pre-existing, fully-caught-up
   *  copy) so callers that don't pass it keep today's behavior. */
  installIsStale?: boolean;
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  Installed: ${opts.installed}`);
  lines.push(`  This session is running: ${opts.current}`);
  lines.push('');
  if (opts.installIsStale) {
    lines.push('  Part of the update already succeeded: a build newer than this session');
    lines.push('  is already on disk. Fully quit the application (not just start a new');
    lines.push('  session or chat), then relaunch to pick it up. If this message persists');
    lines.push('  after a full quit and relaunch, an earlier application process is still');
    lines.push('  running and still serving the old payload: find and quit it too.');
    lines.push('');
    lines.push('  That installed build is not the newest one either: a further update is');
    lines.push('  available (see below). Relaunch first, then run the update again to');
    lines.push('  reach it.');
  } else {
    lines.push('  The update already succeeded. Fully quit the application (not just');
    lines.push('  start a new session or chat), then relaunch. If this message persists');
    lines.push('  after a full quit and relaunch, an earlier application process is still');
    lines.push('  running and still serving the old payload: find and quit it too.');
  }
  lines.push('');
  return lines.join('\n');
}

export interface InstallSituation {
  /** True iff the install record is readable AND newer than the version this
   *  session loaded at launch — the exact "the update already succeeded,
   *  this session just hasn't picked it up" situation from feedback
   *  36645/36672/36728. Purely local: never depends on `latest`. */
  sessionBehindInstall: boolean;
  /** Which version staleness-vs-latest was judged against: the host's
   *  recorded install when it was readable, else this session's running
   *  payload (the old, misleading basis — kept only as a fallback). */
  staleBasis: 'installed' | 'current';
  /** True iff `staleBasis`'s version is behind `latest`. False when `latest`
   *  is unknown (offline / no cache yet). */
  isStale: boolean;
  /** Release-tag URL for `latest`, present iff `isStale`. */
  releaseUrl: string | null;
}

/**
 * Work out the three-way situation described in feedback 36645/36672/36728:
 * is this session in sync with what's actually installed, is it BEHIND what's
 * installed (the "you already updated, this just hasn't reloaded" case), or
 * is the install record simply unreadable on this surface (fall back to the
 * old current-vs-latest basis, honestly labeled as such via `staleBasis`).
 *
 * `sessionBehindInstall` is computed independently of `latest` — it is a
 * purely local fact (running payload vs on-disk record) and must be knowable
 * with no network at all, per the fix's own design constraint.
 */
export function evaluateInstallSituation(opts: {
  current: string;
  installed: string | null;
  latest: string | null;
}): InstallSituation {
  const { current, installed, latest } = opts;

  if (installed === null) {
    const isStale = latest !== null && compareVersions(current, latest) < 0;
    return {
      sessionBehindInstall: false,
      staleBasis: 'current',
      isStale,
      releaseUrl: isStale && latest ? `${RELEASE_TAG_URL_PREFIX}${latest}` : null,
    };
  }

  const sessionBehindInstall = compareVersions(current, installed) < 0;
  const isStale = latest !== null && compareVersions(installed, latest) < 0;
  return {
    sessionBehindInstall,
    staleBasis: 'installed',
    isStale,
    releaseUrl: isStale && latest ? `${RELEASE_TAG_URL_PREFIX}${latest}` : null,
  };
}
