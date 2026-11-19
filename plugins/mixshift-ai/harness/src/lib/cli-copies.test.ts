/**
 * Tests for the installed-CLI-copy scan (feedback 3070886; mx-ops#274 item 2).
 * Every case builds a throwaway plugin tree: <root>/<folder>/harness/dist/cli.js
 * plus <folder>/.claude-plugin/plugin.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanCliCopies,
  sortCopiesNewestFirst,
  defaultScanRoots,
  isPluginLocationName,
} from './cli-copies.js';

let base: string;

function makeCopy(rel: string, version: string | null, raw?: string): string {
  const root = join(base, rel);
  mkdirSync(join(root, 'harness', 'dist'), { recursive: true });
  writeFileSync(join(root, 'harness', 'dist', 'cli.js'), '// cli\n');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  if (raw !== undefined) {
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), raw);
  } else if (version !== null) {
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  }
  return root;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mx-cli-copies-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('scanCliCopies', () => {
  it('compares versions numerically, not as text: 0.8.10 beats 0.8.9 and 0.8.22 beats 0.8.10', () => {
    makeCopy('cache/a1b2', '0.8.9');
    makeCopy('cache/c3d4', '0.8.10');
    const newest = makeCopy('cache/e5f6', '0.8.22');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(scan.copies).toHaveLength(3);
    expect(scan.newest?.version).toBe('0.8.22');
    expect(scan.newest?.pluginRoot).toBe(newest);
    expect(sortCopiesNewestFirst(scan.copies).map((c) => c.version)).toEqual([
      '0.8.22',
      '0.8.10',
      '0.8.9',
    ]);
  });

  it('skips anything under a .trash folder, even when its version is the highest', () => {
    makeCopy('cache/live', '0.8.22');
    makeCopy('.trash/old/cache/dead', '0.9.9');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(scan.copies.map((c) => c.version)).toEqual(['0.8.22']);
    expect(scan.newest?.version).toBe('0.8.22');
  });

  it('reads the version from plugin.json, not from the path text', () => {
    makeCopy('cache/0.1.0-looks-old', '0.8.22');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(scan.newest?.version).toBe('0.8.22');
  });

  it('a copy with an unreadable or non-version plugin.json is listed with a null version and never wins', () => {
    makeCopy('cache/broken', null, '{not json');
    makeCopy('cache/weird', null, JSON.stringify({ version: '$(rm -rf /)' }));
    makeCopy('cache/missing', null);
    makeCopy('cache/ok', '0.8.3');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(scan.copies).toHaveLength(4);
    expect(scan.copies.filter((c) => c.version === null)).toHaveLength(3);
    expect(scan.newest?.version).toBe('0.8.3');
    expect(sortCopiesNewestFirst(scan.copies)[0].version).toBe('0.8.3');
  });

  it('marks the running copy and lists it even when it sits outside the scanned roots', () => {
    const running = makeCopy('elsewhere/run', '0.8.22');
    makeCopy('cache/older', '0.8.10');
    const scan = scanCliCopies({
      onlyExtraRoots: true,
      extraRoots: [join(base, 'cache')],
      runningPluginRoot: running,
    });
    expect(scan.running?.pluginRoot).toBe(running);
    expect(scan.running?.isRunning).toBe(true);
    expect(scan.copies).toHaveLength(2);
    expect(scan.newest?.isRunning).toBe(true);
  });

  it('equal versions: the running copy is the newest', () => {
    makeCopy('cache/a', '0.8.22');
    const running = makeCopy('cache/b', '0.8.22');
    const scan = scanCliCopies({
      onlyExtraRoots: true,
      extraRoots: [base],
      runningPluginRoot: running,
    });
    expect(scan.newest?.pluginRoot).toBe(running);
  });

  it('does not descend into node_modules and respects the depth cap', () => {
    makeCopy('node_modules/x/cache/hidden', '9.9.9');
    makeCopy('a/b/c/d/e/deep', '9.9.8');
    makeCopy('cache/shallow', '0.8.1');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base], maxDepth: 3 });
    expect(scan.copies.map((c) => c.version)).toEqual(['0.8.1']);
  });

  it('does not count the host marketplace clone as an installed copy', () => {
    makeCopy('plugins/cache/mixshift/mixshift-ai/0.8.22', '0.8.22');
    makeCopy('plugins/marketplaces/mixshift/plugins/mixshift-ai', '0.9.0');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(scan.copies.map((c) => c.version)).toEqual(['0.8.22']);
    expect(scan.newest?.version).toBe('0.8.22');
  });

  it('reports truncated when the entry budget runs out, and not otherwise', () => {
    for (let i = 0; i < 12; i++) makeCopy('cache/c' + i, '0.8.' + i);
    const cut = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base], maxEntries: 3 });
    expect(cut.truncated).toBe(true);
    const full = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(full.truncated).toBe(false);
    expect(full.copies).toHaveLength(12);
  });

  it('a restricted root (Cowork /sessions) descends only into plugin locations, never the work folders', () => {
    makeCopy('s1/mnt/.remote-plugins/plugin_01abc', '0.8.22');
    makeCopy('s1/mnt/my-work-folder/clone/plugins/mixshift-ai', '9.9.9');
    makeCopy('s1/outputs/stuff', '9.9.8');
    const open = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(open.copies).toHaveLength(3);
    const scoped = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base], restrictedRoots: [base] });
    expect(scoped.copies.map((c) => c.version)).toEqual(['0.8.22']);
  });

  it('empty or missing roots give an empty scan, never a throw', () => {
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [join(base, 'nope')] });
    expect(scan.copies).toEqual([]);
    expect(scan.newest).toBeNull();
    expect(scan.scannedRoots).toEqual([]);
  });
});

describe('defaultScanRoots', () => {
  it('always includes the Claude Code plugin cache and adds per-platform host folders', () => {
    const mac = defaultScanRoots({ home: '/h', platform: 'darwin', env: {} });
    expect(mac).toContain(join('/h', '.claude', 'plugins'));
    expect(mac.some((r) => r.includes('Application Support'))).toBe(true);
    const win = defaultScanRoots({
      home: 'C:\\h',
      platform: 'win32',
      env: { APPDATA: 'C:\\h\\AppData\\Roaming' },
    });
    expect(win.some((r) => r.endsWith('Claude'))).toBe(true);
    const linux = defaultScanRoots({ home: '/h', platform: 'linux', env: {} });
    expect(linux).toContain('/sessions');
  });
});

describe('isPluginLocationName', () => {
  it('accepts plugin-shaped folder names and rejects work-folder names', () => {
    for (const ok of ['mnt', '.remote-plugins', 'plugin_01LC7x', 'mixshift-ai', '0.8.22', 'cache']) {
      expect(isPluginLocationName(ok)).toBe(true);
    }
    for (const no of ['Documents', 'my-work-folder', 'outputs', 'uploads', 'brand-reports']) {
      expect(isPluginLocationName(no)).toBe(false);
    }
  });
});
