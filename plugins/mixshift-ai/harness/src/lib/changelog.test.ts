import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The shipped .mixshift-defaults.yaml now sets gateway.base_url, which would
// make fetchChangelogMarkdown() try the gateway leg first for every test
// below. Mock loadPluginDefaults so the default is "no gateway configured"
// (the "loadChangelog :: gateway routing" suite overrides this per-case).
vi.mock('./defaults/load.js', () => ({
  loadPluginDefaults: vi.fn(),
}));

import { parseChangelog, entriesSince, whatsNewFor, loadChangelog } from './changelog.js';
import { loadPluginDefaults } from './defaults/load.js';
import { defaultsSchema, type PluginDefaults } from './defaults/schema.js';

function defaultsWithGatewayBase(baseUrl: string): PluginDefaults {
  const defaults = defaultsSchema.parse({ schema_version: 1 });
  defaults.gateway.base_url = baseUrl;
  return defaults;
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-changelog-test-'));
  vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(''));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const SAMPLE = `# Changelog

All notable changes are recorded here. This log starts at 0.5.39.

## 0.5.40

A small release.

### Fixed

- Feedback is never dropped at the email gate.

## 0.5.39

### Changed

- Renamed a skill.

### Removed

- Removed an internal skill.
`;

describe('parseChangelog', () => {
  it('splits into version entries newest-first, ignoring the title/intro', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
  });

  it('keeps ### sub-headings inside the section notes (does not split on them)', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.notes).toContain('### Fixed');
    expect(first.notes).toContain('email gate');
    // the next version heading must NOT leak into this entry's notes
    expect(first.notes).not.toContain('Renamed a skill');
  });

  it('extracts a clean version token from a bracketed/dated heading', () => {
    const entries = parseChangelog('## [1.2.3] - 2026-06-24\n\n- note\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('1.2.3');
  });

  it('returns an empty array for input with no version headings', () => {
    expect(parseChangelog('# Changelog\n\njust intro, no releases\n')).toEqual([]);
  });

  it('strips HTML comments (e.g. the unreleased marker) from notes', () => {
    const md =
      '## 0.9.0\n\n<!-- unreleased: version bump happens at release cut -->\n\n### Added\n\n- A real bullet\n';
    const [entry] = parseChangelog(md);
    expect(entry.notes).not.toContain('<!--');
    expect(entry.notes).not.toContain('unreleased');
    expect(entry.notes).toContain('### Added');
    expect(entry.notes).toContain('A real bullet');
  });
});

describe('entriesSince', () => {
  it('returns only entries strictly newer than the given version', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entriesSince(entries, '0.5.39').map((e) => e.version)).toEqual(['0.5.40']);
    expect(entriesSince(entries, '0.5.40')).toEqual([]);
    expect(entriesSince(entries, '0.5.0').map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
  });
});

describe('whatsNewFor', () => {
  const entries = parseChangelog(SAMPLE);

  it('shows what you would gain when behind', () => {
    expect(whatsNewFor(entries, '0.5.39').map((e) => e.version)).toEqual(['0.5.40']);
  });

  it("shows your own version's entry when current", () => {
    expect(whatsNewFor(entries, '0.5.40').map((e) => e.version)).toEqual(['0.5.40']);
  });

  it('falls back to the latest entry when the installed version is unknown to the log', () => {
    expect(whatsNewFor(entries, '0.4.0').map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
    expect(whatsNewFor(entries, '9.9.9').map((e) => e.version)).toEqual(['0.5.40']);
  });
});

// ---------------------------------------------------------------------------
// loadChangelog :: gateway routing — fetchChangelogMarkdown() tries the
// mx-legacy-auth gateway route first (rides the one domain sandboxes already
// allow) and falls back to the existing GitHub-raw fetch when the gateway
// leg is unconfigured, errors, or throws.
// ---------------------------------------------------------------------------

describe('loadChangelog :: gateway routing', () => {
  const GATEWAY_BASE = 'https://gw.example.test';
  const GATEWAY_URL = `${GATEWAY_BASE}/plugin/changelog`;
  const RAW_URL = 'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/CHANGELOG.md';

  it('uses the gateway route and never touches GitHub-raw when the gateway returns 2xx', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(GATEWAY_BASE));
    const mockFetch = vi.fn().mockResolvedValue(new Response('## 1.2.3\n\n- note\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.source).toBe('network');
    expect(result.entries.map((e) => e.version)).toEqual(['1.2.3']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(GATEWAY_URL, expect.any(Object));
  });

  it('falls back to GitHub-raw when the gateway responds 5xx', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(GATEWAY_BASE));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('## 1.2.4\n\n- note\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.entries.map((e) => e.version)).toEqual(['1.2.4']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, GATEWAY_URL, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(2, RAW_URL, expect.any(Object));
  });

  it('falls back to GitHub-raw when the gateway fetch throws', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(GATEWAY_BASE));
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response('## 1.2.5\n\n- note\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.entries.map((e) => e.version)).toEqual(['1.2.5']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('goes straight to GitHub-raw (single call) when base_url is empty', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(''));
    const mockFetch = vi.fn().mockResolvedValue(new Response('## 1.2.6\n\n- note\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.entries.map((e) => e.version)).toEqual(['1.2.6']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(RAW_URL, expect.any(Object));
  });

  // Regression: a gateway 200 whose body doesn't actually parse as a
  // CHANGELOG (a captive-portal/WAF interstitial, or just an empty body)
  // must NOT win over the GitHub-raw fallback and must not poison the cache.
  it('falls back to GitHub-raw when the gateway returns 200 but the body is not a real changelog', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(GATEWAY_BASE));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('<html>maintenance</html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('## 1.2.7\n\n- real notes\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.source).toBe('network');
    expect(result.entries.map((e) => e.version)).toEqual(['1.2.7']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, GATEWAY_URL, expect.any(Object));
    expect(mockFetch).toHaveBeenNthCalledWith(2, RAW_URL, expect.any(Object));
  });

  it('falls back to GitHub-raw when the gateway returns 200 with an empty body', async () => {
    vi.mocked(loadPluginDefaults).mockResolvedValue(defaultsWithGatewayBase(GATEWAY_BASE));
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('## 1.2.8\n\n- real notes\n', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const result = await loadChangelog({ dataDirOverride: testDir, forceFetch: true });

    expect(result.entries.map((e) => e.version)).toEqual(['1.2.8']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, RAW_URL, expect.any(Object));
  });
});
