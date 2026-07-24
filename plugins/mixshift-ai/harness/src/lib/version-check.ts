/**
 * Check whether the installed plugin is behind the latest published
 * version on GitHub.
 *
 * Source of truth: `marketplace.json` on the default branch. Same file
 * that Cowork / Claude Code read when they install or update the
 * plugin, so the "latest" we report is exactly what the user would
 * land on if they reinstalled.
 *
 * Cache: 24h on disk. Fetch failures fall back to whatever is cached
 * (or render nothing if no cache yet). Never throws — the version
 * check is purely advisory and must not break commands that call it.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { getPluginVersion } from './plugin-version.js';
import { resolveDataDir } from './paths/resolve.js';
import { isValidVersion } from './update-notice-state.js';

const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/.claude-plugin/marketplace.json';
const RELEASES_TAG_BASE =
  'https://github.com/miXshift/mx-claude-plugin/releases/tag/';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;

export interface VersionCheckResult {
  current: string;
  /** Null when no fetch has succeeded yet (no network + no cached value). */
  latest: string | null;
  /** True iff we have a `latest` and `current < latest`. */
  isStale: boolean;
  /** GitHub release tag URL for the latest version (when known + stale). */
  releaseUrl: string | null;
  /** True if this call performed a fresh fetch (vs reading from cache). */
  fetched: boolean;
}

interface CacheFile {
  checked_at: string; // ISO timestamp
  latest_version: string;
}

interface MarketplaceJson {
  plugins?: Array<{ name?: string; version?: string }>;
}

function versionCheckCachePath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'version-check.json');
}

/**
 * Returns the staleness assessment. Never throws — network failures
 * and JSON parse errors collapse to `{latest: null, isStale: false}`.
 */
export async function checkForUpdate(opts: {
  dataDirOverride?: string;
  /** Bypass the 24h cache and force a fresh fetch. */
  forceFetch?: boolean;
} = {}): Promise<VersionCheckResult> {
  const current = getPluginVersion();
  const cachePath = versionCheckCachePath(opts.dataDirOverride);

  // Try cache first.
  let cached: CacheFile | null = null;
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (
      typeof parsed.checked_at === 'string' &&
      typeof parsed.latest_version === 'string'
    ) {
      cached = {
        checked_at: parsed.checked_at,
        latest_version: parsed.latest_version,
      };
    }
  } catch {
    // No cache or invalid; continue.
  }

  const now = Date.now();
  const cacheAge = cached ? now - Date.parse(cached.checked_at) : Infinity;
  const cacheFresh = !opts.forceFetch && cached !== null && cacheAge < CACHE_TTL_MS;

  let latest: string | null = cached?.latest_version ?? null;
  let fetched = false;

  if (!cacheFresh) {
    const fresh = await fetchLatestVersion();
    if (fresh !== null) {
      latest = fresh;
      fetched = true;
      // Persist; ignore write errors (the check is advisory).
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(
          cachePath,
          JSON.stringify(
            {
              checked_at: new Date(now).toISOString(),
              latest_version: fresh,
            },
            null,
            2,
          ) + '\n',
          { encoding: 'utf-8' },
        );
      } catch {
        // Cache write failures are non-fatal.
      }
    }
  }

  const isStale =
    latest !== null && compareVersions(current, latest) < 0;
  const releaseUrl =
    latest && isStale
      ? `${RELEASES_TAG_BASE}mixshift-ai--v${latest}`
      : null;

  return { current, latest, isStale, releaseUrl, fetched };
}

/**
 * Read the on-disk version-check cache WITHOUT triggering a fetch or
 * touching the 24h freshness window. Returns null if the cache is missing,
 * unreadable, the wrong shape, or holds a value that fails isValidVersion().
 *
 * Used by callers that want "latest known version" as a cheap best-effort
 * hint (e.g. `mixshift whatsnew --dismiss`, which needs *a* version to record
 * as dismissed but shouldn't pay for a network round trip just to dismiss a
 * notice) rather than the full staleness assessment `checkForUpdate` provides.
 *
 * SECURITY: version-check.json is written by this same process on a
 * successful fetch, but it is still on-disk, plain JSON, editable by
 * anything with filesystem access. `--dismiss` prints this value to stdout,
 * returns it in `--json`, and persists it to update-notice-state.json — and
 * the SessionStart hook's update notice instructs the model to run
 * `mixshift whatsnew` via Bash, so that stdout re-enters the conversation.
 * Gate the cached value through the shared isValidVersion() shape check
 * before ever returning it; an invalid cache is treated as a cache miss
 * (null), same as missing/corrupt, so callers fall back to a trusted value
 * (the currently-installed version) instead of a poisoned one.
 */
export async function readCachedLatestVersion(
  dataDirOverride?: string,
): Promise<string | null> {
  try {
    const raw = await readFile(versionCheckCachePath(dataDirOverride), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    return isValidVersion(parsed.latest_version) ? parsed.latest_version : null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(MARKETPLACE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as MarketplaceJson;
    const entry = (data.plugins ?? []).find(
      (p) => p?.name === 'mixshift-ai',
    );
    return typeof entry?.version === 'string' ? entry.version : null;
  } catch {
    return null;
  }
}

/**
 * Lexical semver-ish comparison. Returns -1/0/1.
 *
 * Handles 0.5.3, 0.5.10, 1.0.0-rc.1 (rc.1 treated as a pre-release tail
 * via string compare on the suffix). We don't expect pre-releases in
 * practice; the public marketplace.json only carries tagged releases.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA = ''] = a.split('-', 2);
  const [coreB, preB = ''] = b.split('-', 2);
  const partsA = coreA.split('.').map((x) => parseInt(x, 10) || 0);
  const partsB = coreB.split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const valA = partsA[i] ?? 0;
    const valB = partsB[i] ?? 0;
    if (valA < valB) return -1;
    if (valA > valB) return 1;
  }
  // Equal core; pre-release tail loses to no-tail (1.0.0 > 1.0.0-rc).
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA < preB) return -1;
  if (preA > preB) return 1;
  return 0;
}

/**
 * Render the user-facing update banner. Returns empty string when not
 * stale. Two formats:
 *
 *   - `terminal` — ASCII layout for shell output (used by `mixshift welcome`
 *     in terminal mode and `mixshift version`)
 *   - `chat` — markdown quote-block layout for in-chat surfacing (used by
 *     `mixshift welcome --format chat`)
 *
 * Copy intentionally covers both Cowork (UI uninstall+reinstall + optional
 * org-managed auto-sync note) and Claude Code (refresh the marketplace catalog
 * first with `claude plugin marketplace update mixshift`, then
 * `claude plugin update mixshift-ai@mixshift` — the refresh avoids a stale-catalog race
 * where the update reinstalls the same old version), and closes with the
 * critical "start a new session" step: a running session keeps the plugin
 * binary it materialized at startup, so an in-place update never takes effect
 * until the user opens a fresh session (a new chat in the same window is not
 * enough). Other surfaces fall through to the same content; CLI users updating
 * from source don't usually see this banner anyway (their `current` matches
 * what they just built).
 */
export function renderUpdateBanner(
  result: VersionCheckResult,
  format: 'terminal' | 'chat' = 'terminal',
): string {
  if (!result.isStale || !result.latest) return '';
  if (format === 'chat') {
    const lines: string[] = [];
    lines.push(
      `> ⚠ **Update available:** you're on **${result.current}**, latest is **${result.latest}**.`,
    );
    lines.push('>');
    lines.push(
      '> **In Cowork:** Settings → Plugins → click **Update** on `mixshift-ai` ' +
        '(or uninstall and reinstall if no Update option appears). ' +
        'Org-managed installs auto-sync within ~30 min.',
    );
    lines.push('>');
    lines.push(
      '> **In Claude Code:** in your terminal, run ' +
        '`claude plugin marketplace update mixshift` to refresh the catalog first, ' +
        'then `claude plugin update mixshift-ai@mixshift` ' +
        '(add `--scope local` if you installed it for this project only).',
    );
    lines.push('>');
    lines.push(
      '> **Then load it:** start a new conversation (in Cowork, fully quit and ' +
        'reopen the app). A new chat in the same window is not enough: a running ' +
        'session keeps the plugin version it started with, so the update only ' +
        'takes effect in a fresh session.',
    );
    lines.push('>');
    lines.push(
      '> **Avoid this next time:** turn on auto-sync when you first add the plugin. ' +
        "If you installed earlier, the toggle is on the plugin's marketplace entry, " +
        'and org-managed installs already sync on their own.',
    );
    lines.push('>');
    lines.push(
      '> See what changed: run `mixshift whatsnew`' +
        (result.releaseUrl ? ` (or view the release notes at ${result.releaseUrl})` : '') +
        '.',
    );
    lines.push('');
    return lines.join('\n');
  }
  // terminal
  const lines: string[] = [];
  lines.push('');
  lines.push('━━ Update available ━━');
  lines.push(`  You are on ${result.current}; latest is ${result.latest}.`);
  lines.push('');
  lines.push('  In Cowork:');
  lines.push('    Settings → Plugins → click Update on mixshift-ai');
  lines.push('    (or uninstall and reinstall if no Update option appears).');
  lines.push('    Org-managed installs auto-sync within ~30 min.');
  lines.push('');
  lines.push('  In Claude Code (run both in your terminal):');
  lines.push('    claude plugin marketplace update mixshift');
  lines.push('    claude plugin update mixshift-ai@mixshift');
  lines.push('    (installed it for this project only? add: --scope local)');
  lines.push('');
  lines.push('  Then load it:');
  lines.push('    Start a new session (in Cowork, fully quit and reopen the app).');
  lines.push('    A new chat in the same window is not enough: a running session');
  lines.push('    keeps the plugin version it started with, so the update only');
  lines.push('    takes effect in a fresh session.');
  lines.push('');
  lines.push('  Avoid this next time:');
  lines.push('    Turn on auto-sync when you first add the plugin. If you installed');
  lines.push("    earlier, the toggle is on the plugin's marketplace entry, and");
  lines.push('    org-managed installs already sync on their own.');
  lines.push('');
  lines.push('  See what changed: run  mixshift whatsnew');
  if (result.releaseUrl) {
    lines.push(`    (or view the release notes at ${result.releaseUrl})`);
  }
  lines.push('');
  return lines.join('\n');
}
