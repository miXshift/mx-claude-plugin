/**
 * Parse + fetch the plugin CHANGELOG so `mixshift whatsnew` can render release
 * notes in-plugin, and the update banner can point users at them.
 *
 * Source of truth is the repo-root CHANGELOG.md on the default branch — the
 * same file release-docs maintains and humans edit. We FETCH it (24h cache,
 * graceful offline fallback), for the same reason version-check fetches
 * marketplace.json: it keeps ONE canonical CHANGELOG and lets us show the notes
 * for a version you have not installed yet (the one the update banner offers),
 * rather than shipping a stale copy inside the plugin bundle.
 *
 * Never throws: parse is pure, fetch collapses network/JSON errors to the
 * cached value (or an empty list). Advisory only.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDataDir } from './paths/resolve.js';
import { compareVersions } from './version-check.js';
import { resolveGatewayBaseSafe } from './net/gateway-url.js';

const CHANGELOG_URL =
  'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/CHANGELOG.md';
const RELEASES_URL = 'https://github.com/miXshift/mx-claude-plugin/releases';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5_000;

export const CHANGELOG_RELEASES_URL = RELEASES_URL;

export interface ChangelogEntry {
  /** Clean version string, e.g. "0.5.40". */
  version: string;
  /** Section body markdown (everything under the `## <version>` heading). */
  notes: string;
}

export interface ChangelogLoadResult {
  entries: ChangelogEntry[];
  /** Where the markdown came from. */
  source: 'network' | 'cache' | 'none';
  error?: string;
}

interface ChangelogCache {
  checked_at: string; // ISO
  markdown: string;
}

/**
 * Parse a CHANGELOG.md string into version-keyed entries, newest first
 * (document order). Pure + total: any input yields an array. Lines before the
 * first `## ` heading (the `# Changelog` title and intro) are ignored, and
 * `### ` sub-headings inside a section are kept as part of its notes.
 */
export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: { version: string; body: string[] } | null = null;
  const flush = () => {
    if (current) {
      // Strip HTML comments before storing the notes. The body renders VERBATIM
      // to users (`mixshift whatsnew` fetches this file live from `main`, where a
      // maintainer marker like `<!-- unreleased: ... -->` sits under the current
      // heading for the whole dev cycle). Without this, that marker shows as
      // literal text to anyone who runs whatsnew between releases (the 0.8.6
      // leak). Comments can span lines; collapse the blank gap a removal leaves.
      const notes = current.body
        .join('\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      entries.push({ version: current.version, notes });
    }
  };
  for (const line of md.split(/\r?\n/)) {
    // A version heading is exactly two hashes + space (### sub-headings skip this).
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = { version: cleanVersion(m[1]), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return entries;
}

/** Extract a comparable version token from a heading like "0.5.40" or "[0.5.40] - 2026-06-24". */
function cleanVersion(heading: string): string {
  return heading.trim().replace(/^\[/, '').split(/[\s\]]/)[0] ?? heading.trim();
}

/** Entries strictly newer than `version` (newest first). */
export function entriesSince(entries: ChangelogEntry[], version: string): ChangelogEntry[] {
  return entries.filter((e) => compareVersions(e.version, version) > 0);
}

/**
 * Default selection for `mixshift whatsnew`: entries newer than the installed
 * version (what you'd gain by updating). When you are already current (nothing
 * newer), fall back to your own version's entry, else the latest entry.
 */
export function whatsNewFor(entries: ChangelogEntry[], current: string): ChangelogEntry[] {
  const newer = entriesSince(entries, current);
  if (newer.length > 0) return newer;
  const own = entries.find((e) => compareVersions(e.version, current) === 0);
  if (own) return [own];
  return entries.length > 0 ? [entries[0]!] : [];
}

function cachePath(dataDirOverride?: string): string {
  return join(resolveDataDir(dataDirOverride), 'changelog-cache.json');
}

/**
 * Load + parse the CHANGELOG. 24h disk cache; on a stale/forced miss, fetch
 * fresh and re-cache; on fetch failure, fall back to whatever is cached. Never
 * throws.
 */
export async function loadChangelog(
  opts: { dataDirOverride?: string; forceFetch?: boolean } = {},
): Promise<ChangelogLoadResult> {
  const path = cachePath(opts.dataDirOverride);

  let cached: ChangelogCache | null = null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ChangelogCache>;
    if (typeof parsed.checked_at === 'string' && typeof parsed.markdown === 'string') {
      cached = { checked_at: parsed.checked_at, markdown: parsed.markdown };
    }
  } catch {
    // no/invalid cache
  }

  const cacheAge = cached ? Date.now() - Date.parse(cached.checked_at) : Infinity;
  const cacheFresh = !opts.forceFetch && cached !== null && cacheAge < CACHE_TTL_MS;

  if (cacheFresh && cached) {
    return { entries: parseChangelog(cached.markdown), source: 'cache' };
  }

  const fetched = await fetchChangelogMarkdown();
  if (fetched.markdown !== null) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ checked_at: new Date().toISOString(), markdown: fetched.markdown }, null, 2) + '\n',
        'utf-8',
      );
    } catch {
      // cache write is non-fatal
    }
    return { entries: parseChangelog(fetched.markdown), source: 'network' };
  }

  if (cached) {
    return { entries: parseChangelog(cached.markdown), source: 'cache', error: fetched.error };
  }
  return { entries: [], source: 'none', error: fetched.error };
}

/**
 * Gateway-first, GitHub-raw-fallback. The gateway route (mx-legacy-auth's
 * `GET {base}/plugin/changelog`) rides the one domain every install already
 * reaches — sandboxes that block raw.githubusercontent.com allow
 * mcp.mixshift.io. When no gateway is configured (or the gateway leg fails
 * for any reason: non-2xx, throw, timeout) this falls through to the
 * existing direct GitHub-raw fetch unchanged.
 */
async function fetchChangelogMarkdown(): Promise<{ markdown: string | null; error?: string }> {
  const base = await resolveGatewayBaseSafe();
  if (base) {
    const viaGateway = await fetchChangelogFrom(`${base}/plugin/changelog`);
    // Accept the gateway body ONLY if it actually parses as a CHANGELOG (>=1
    // entry). A bare 200 with an empty body or an HTML captive-portal/WAF
    // interstitial would otherwise win over — and poison the 24h cache
    // against — the GitHub-raw fallback. A real CHANGELOG is never empty.
    if (viaGateway.markdown !== null && parseChangelog(viaGateway.markdown).length > 0) {
      return viaGateway;
    }
  }
  return fetchChangelogFrom(CHANGELOG_URL);
}

async function fetchChangelogFrom(url: string): Promise<{ markdown: string | null; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { markdown: null, error: `HTTP ${res.status}` };
    return { markdown: await res.text() };
  } catch (err) {
    return { markdown: null, error: err instanceof Error ? err.message : String(err) };
  }
}
