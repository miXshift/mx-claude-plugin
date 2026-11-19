/**
 * Tests for launcher (shim) detection (feedback 3070888): a `mixshift`
 * symlink left pointing at a plugin folder that moved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { scanShims, describeShimProblems } from './cli-shim.js';

/** Symlinks need a privilege on some Windows setups; probe instead of assuming. */
const canSymlink = ((): boolean => {
  const d = mkdtempSync(join(tmpdir(), 'mx-symprobe-'));
  try {
    writeFileSync(join(d, 't'), 'x');
    symlinkSync(join(d, 't'), join(d, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
let home: string;

function makePlugin(rel: string, version: string): string {
  const root = join(home, rel);
  mkdirSync(join(root, 'harness', 'bin'), { recursive: true });
  mkdirSync(join(root, 'harness', 'dist'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'harness', 'bin', 'mixshift'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'harness', 'dist', 'cli.js'), '// cli\n');
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return join(root, 'harness', 'bin', 'mixshift');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mx-shim-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!canSymlink)('scanShims', () => {
  it('flags a symlink whose target was moved away as dangling and names the target', () => {
    const launcher = makePlugin('old-folder', '0.8.10');
    const link = join(home, '.local', 'bin', 'mixshift');
    symlinkSync(launcher, link);
    rmSync(join(home, 'old-folder'), { recursive: true, force: true });
    const found = scanShims({ home, pathEnv: '' }).filter((f) => f.path === link);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: link, state: 'dangling', target: launcher });
  });

  it('a link whose target sits behind a folder we cannot enter (EACCES) is NOT called dangling', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const locked = join(home, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'target'), 'x');
    const link = join(home, '.local', 'bin', 'mixshift');
    symlinkSync(join(locked, 'target'), link);
    chmodSync(locked, 0o000);
    try {
      expect(scanShims({ home, pathEnv: '' }).filter((f) => f.path === link)).toEqual([]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('a link loop is not called dangling either', () => {
    const a = join(home, 'loop-a');
    const b = join(home, 'loop-b');
    symlinkSync(b, a);
    symlinkSync(a, b);
    symlinkSync(a, join(home, '.local', 'bin', 'mixshift'));
    const found = scanShims({ home, pathEnv: '' }).filter((f) => f.path.startsWith(join(home, '.local')));
    expect(found).toEqual([]);
  });

  it('a working symlink to the newest copy is ok', () => {
    const launcher = makePlugin('p/new', '0.8.22');
    const link = join(home, '.local', 'bin', 'mixshift');
    symlinkSync(launcher, link);
    const found = scanShims({ home, pathEnv: '', newestVersion: '0.8.22' }).filter(
      (f) => f.path === link,
    );
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe('ok');
    expect(found[0].version).toBe('0.8.22');
  });

  it('a working symlink to an older copy is reported as older_copy', () => {
    const launcher = makePlugin('p/old', '0.8.10');
    const link = join(home, '.local', 'bin', 'mixshift');
    symlinkSync(launcher, link);
    const found = scanShims({ home, pathEnv: '', newestVersion: '0.8.22' }).filter(
      (f) => f.path === link,
    );
    expect(found[0]).toMatchObject({ state: 'older_copy', version: '0.8.10' });
  });

  it('finds a launcher on PATH too, and lists a directory once', () => {
    const dir = join(home, 'pathbin');
    mkdirSync(dir);
    const link = join(dir, 'mixshift');
    symlinkSync(join(home, 'gone', 'harness', 'bin', 'mixshift'), link);
    const found = scanShims({ home, pathEnv: [dir, dir].join(delimiter) }).filter(
      (f) => f.path === link,
    );
    expect(found).toHaveLength(1);
    expect(found[0].state).toBe('dangling');
  });

  it("the plugin's own harness/bin/mixshift on PATH (a regular file) is never reported", () => {
    const launcher = makePlugin('p/own', '0.8.10');
    const binDir = join(launcher, '..');
    const found = scanShims({ home, pathEnv: binDir, newestVersion: '0.8.22' });
    expect(found.filter((f) => f.path === launcher)).toEqual([]);
  });

  it('no launcher named mixshift in the user bin folder: nothing reported for it', () => {
    const found = scanShims({ home, pathEnv: '' }).filter((f) => f.path.startsWith(home));
    expect(found).toEqual([]);
  });
});

describe('describeShimProblems', () => {
  it('dangling: says the target is gone, how to remove it, that the plugin does not create it, and an optional re-point', () => {
    const lines = describeShimProblems(
      [
        {
          path: '/h/.local/bin/mixshift',
          state: 'dangling',
          target: '/old/harness/bin/mixshift',
          version: null,
        },
      ],
      '/new/harness/bin/mixshift',
    ).join('\n');
    expect(lines).toContain('/old/harness/bin/mixshift, which no longer exists');
    expect(lines).toContain('rm "/h/.local/bin/mixshift"');
    expect(lines).toContain('does not create this file');
    expect(lines).toContain('ln -sf "/new/harness/bin/mixshift" "/h/.local/bin/mixshift"');
  });

  it('older_copy: never advises rm; names both versions and shows the ln -sf re-point with a sudo note', () => {
    const lines = describeShimProblems(
      [{ path: '/usr/local/bin/mixshift', state: 'older_copy', target: '/old/harness/bin/mixshift', version: '0.8.10' }],
      '/new/harness/bin/mixshift',
      '0.8.22',
    ).join('\n');
    expect(lines).not.toContain('rm ');
    expect(lines).not.toMatch(/Remove/i);
    expect(lines).toContain('works, but it runs plugin copy 0.8.10, and a newer copy (0.8.22) is installed.');
    expect(lines).toContain('ln -sf "/new/harness/bin/mixshift" "/usr/local/bin/mixshift"');
    expect(lines).toContain('sudo');
  });

  it('never prints a copy-paste command for a path with shell metacharacters', () => {
    const lines = describeShimProblems(
      [{ path: '/h/$(evil)/mixshift', state: 'dangling', target: '/x', version: null }],
      '/n/harness/bin/mixshift',
    ).join('\n');
    expect(lines).not.toContain('rm "');
    expect(lines).not.toContain('ln -sf');
  });

  it('ok findings produce no lines', () => {
    expect(
      describeShimProblems(
        [{ path: '/a/mixshift', state: 'ok', target: null, version: '0.8.22' }],
        null,
      ),
    ).toEqual([]);
  });
});
