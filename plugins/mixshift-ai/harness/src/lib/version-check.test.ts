import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkForUpdate,
  compareVersions,
  renderUpdateBanner,
} from './version-check.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'mixshift-version-test-'));
});

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
  it('orders equal versions as 0', () => {
    expect(compareVersions('0.5.3', '0.5.3')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('orders by major version', () => {
    expect(compareVersions('0.5.3', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.5.3')).toBe(1);
  });

  it('orders by minor version', () => {
    expect(compareVersions('0.5.3', '0.6.0')).toBe(-1);
    expect(compareVersions('0.6.0', '0.5.3')).toBe(1);
  });

  it('orders by patch version', () => {
    expect(compareVersions('0.5.3', '0.5.4')).toBe(-1);
    expect(compareVersions('0.5.4', '0.5.3')).toBe(1);
  });

  it('handles two-digit patch correctly (not lexical)', () => {
    expect(compareVersions('0.5.10', '0.5.9')).toBe(1);
    expect(compareVersions('0.5.9', '0.5.10')).toBe(-1);
  });

  it('treats pre-release suffix as lower than release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate :: fetch path
// ---------------------------------------------------------------------------

describe('checkForUpdate :: fetch path', () => {
  it('fetches from GitHub and reports stale when local < remote', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [
          { name: 'mixshift-ai', version: '99.99.99' },
          { name: 'something-else', version: '1.0.0' },
        ],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });

    expect(result.latest).toBe('99.99.99');
    expect(result.isStale).toBe(true);
    expect(result.fetched).toBe(true);
    expect(result.releaseUrl).toContain('mixshift-ai--v99.99.99');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/miXshift/mx-claude-plugin/main/.claude-plugin/marketplace.json',
      expect.any(Object),
    );
  });

  it('reports up-to-date when local == remote', async () => {
    // Read the actual installed version and pretend GitHub matches it.
    const { getPluginVersion } = await import('./plugin-version.js');
    const installed = getPluginVersion();

    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [{ name: 'mixshift-ai', version: installed }],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });

    expect(result.isStale).toBe(false);
    expect(result.releaseUrl).toBeNull();
  });

  it('persists the fetched version to a cache file', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [{ name: 'mixshift-ai', version: '99.0.0' }],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    await checkForUpdate({ dataDirOverride: testDir, forceFetch: true });

    const cacheRaw = await readFile(
      join(testDir, 'version-check.json'),
      'utf-8',
    );
    const cached = JSON.parse(cacheRaw);
    expect(cached.latest_version).toBe('99.0.0');
    expect(cached.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns latest=null when the response is missing the mixshift-ai entry', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [{ name: 'something-else', version: '1.0.0' }],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });

    expect(result.latest).toBeNull();
    expect(result.isStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate :: cache path
// ---------------------------------------------------------------------------

describe('checkForUpdate :: cache path', () => {
  it('uses cached value when within 24h', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'version-check.json'),
      JSON.stringify({
        checked_at: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h ago
        latest_version: '88.0.0',
      }),
    );
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({ dataDirOverride: testDir });

    expect(result.latest).toBe('88.0.0');
    expect(result.fetched).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refetches when cache is older than 24h', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'version-check.json'),
      JSON.stringify({
        checked_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(), // 25h ago
        latest_version: '77.0.0',
      }),
    );
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [{ name: 'mixshift-ai', version: '88.0.0' }],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({ dataDirOverride: testDir });

    expect(result.latest).toBe('88.0.0');
    expect(result.fetched).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('forceFetch bypasses fresh cache', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'version-check.json'),
      JSON.stringify({
        checked_at: new Date(Date.now() - 60_000).toISOString(), // 1min ago
        latest_version: '50.0.0',
      }),
    );
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        plugins: [{ name: 'mixshift-ai', version: '99.0.0' }],
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });

    expect(result.latest).toBe('99.0.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate :: network failures
// ---------------------------------------------------------------------------

describe('checkForUpdate :: failure modes', () => {
  it('returns latest=null on fetch network error (no cache)', async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });

    expect(result.latest).toBeNull();
    expect(result.isStale).toBe(false);
    expect(result.fetched).toBe(false);
  });

  it('falls back to cached value when fetch fails', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, 'version-check.json'),
      JSON.stringify({
        checked_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        latest_version: '77.0.0',
      }),
    );
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('Network down'));
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({ dataDirOverride: testDir });

    expect(result.latest).toBe('77.0.0');
    expect(result.fetched).toBe(false);
  });

  it('handles 500-series HTTP errors gracefully', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('internal error', { status: 500 }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });
    expect(result.latest).toBeNull();
  });

  it('handles malformed JSON gracefully', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', mockFetch);

    const result = await checkForUpdate({
      dataDirOverride: testDir,
      forceFetch: true,
    });
    expect(result.latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderUpdateBanner
// ---------------------------------------------------------------------------

describe('renderUpdateBanner', () => {
  it('returns empty string when not stale', () => {
    expect(
      renderUpdateBanner(
        {
          current: '0.5.4',
          latest: '0.5.4',
          isStale: false,
          releaseUrl: null,
          fetched: true,
        },
        'terminal',
      ),
    ).toBe('');
  });

  it('returns empty string when latest is null', () => {
    expect(
      renderUpdateBanner(
        {
          current: '0.5.4',
          latest: null,
          isStale: false,
          releaseUrl: null,
          fetched: false,
        },
        'terminal',
      ),
    ).toBe('');
  });

  it('terminal format includes Cowork + Claude Code paths', () => {
    const banner = renderUpdateBanner(
      {
        current: '0.5.0',
        latest: '0.5.4',
        isStale: true,
        releaseUrl: 'https://github.com/foo/bar/releases/tag/v0.5.4',
        fetched: true,
      },
      'terminal',
    );
    expect(banner).toContain('Update available');
    expect(banner).toContain('0.5.0');
    expect(banner).toContain('0.5.4');
    expect(banner).toContain('Cowork');
    expect(banner).toContain('Claude Code');
    expect(banner).toContain('/plugin update mixshift-ai');
    expect(banner).toContain(
      'https://github.com/foo/bar/releases/tag/v0.5.4',
    );
  });

  it('chat format uses markdown quote-block', () => {
    const banner = renderUpdateBanner(
      {
        current: '0.5.0',
        latest: '0.5.4',
        isStale: true,
        releaseUrl: 'https://example.com/v0.5.4',
        fetched: true,
      },
      'chat',
    );
    expect(banner.startsWith('> ⚠')).toBe(true);
    expect(banner).toContain('**Update available:**');
    expect(banner).toContain('**0.5.0**');
    expect(banner).toContain('**0.5.4**');
    expect(banner).toContain('`mixshift-ai`');
    expect(banner).toContain('`/plugin update mixshift-ai`');
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
