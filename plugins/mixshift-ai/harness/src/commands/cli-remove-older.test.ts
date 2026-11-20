/**
 * Tests for `mixshift cli remove-older` (mx-ops#274). Every case builds a throwaway
 * plugin tree in a temp folder and scans only that; nothing here touches a real
 * plugin cache.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCliCopies } from '../lib/cli-copies.js';
import { planRemoveOlder, restoreCommand } from '../lib/cli-remove.js';
import { runRemoveOlder as runRaw, APPLY_COMMAND, type RunOptions } from './cli-remove-older.js';

let base: string;
let root: string;

// Launcher links are looked up in the temp tree only, never in the real PATH or home.
function runRemoveOlder(s: ReturnType<typeof scan>, o: RunOptions = {}) {
  return runRaw(s, { shims: { home: base, pathEnv: '' }, ...o });
}

const PLAN = { now: 1_700_000_000_000, pid: 42, rand: () => 'abc123' };

function writeCopy(dir: string, version: string | null, opts: { name?: string; raw?: string } = {}): string {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'harness', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'harness', 'dist', 'cli.js'), '// cli\n');
  if (opts.raw !== undefined) writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), opts.raw);
  else if (version !== null) {
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: opts.name ?? 'mixshift-ai', version }));
  }
  return dir;
}

function makeCopy(rel: string, version: string | null, opts: { name?: string; raw?: string } = {}): string {
  return writeCopy(join(root, rel), version, opts);
}

function scan(running?: string) {
  return scanCliCopies({ onlyExtraRoots: true, extraRoots: [root], runningPluginRoot: running });
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mx-remove-older-'));
  root = join(base, 'plugins');
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('preview (the default)', () => {
  it('changes nothing, lists each older copy with its version and destination, and says how to apply', () => {
    makeCopy('cache/a/0.8.9', '0.8.9');
    makeCopy('cache/a/0.8.18', '0.8.18');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const before = tree(base);
    const run = runRemoveOlder(scan(newest), { plan: PLAN });
    expect(tree(base)).toEqual(before);
    expect(run.exitCode).toBe(0);
    expect(run.summary.status).toBe('preview');
    expect(run.stdout).toMatch(/0\.8\.9\s/);
    expect(run.stdout).toMatch(/0\.8\.18\s/);
    expect(run.stdout).toContain(join(root, '.trash', '1700000000000-42-v0.8.9-abc123', '0.8.9'));
    expect(run.stdout).toContain('Nothing has been changed.');
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe(`To move them, run: ${APPLY_COMMAND}`);
  });

  it('--json preview is one compact line and moves nothing', () => {
    makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const before = tree(base);
    const run = runRemoveOlder(scan(newest), { json: true, plan: PLAN });
    expect(tree(base)).toEqual(before);
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(1);
    const j = JSON.parse(run.stdout);
    expect(j).toMatchObject({
      status: 'preview',
      mode: 'preview',
      changed: false,
      newest_version: '0.8.22',
      truncated: false,
      apply_command: APPLY_COMMAND,
      apply_requires: null,
    });
    expect(j.would_move).toHaveLength(1);
    expect(j.would_move[0]).toMatchObject({ version: '0.8.9', from: join(root, 'cache/a/0.8.9') });
  });

  it('nothing older: says so and offers no apply command', () => {
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { plan: PLAN });
    expect(run.summary.status).toBe('nothing_to_do');
    expect(run.stdout).not.toContain('--yes');
    expect(JSON.parse(runRemoveOlder(scan(newest), { json: true, plan: PLAN }).stdout).apply_command).toBeNull();
  });
});

describe('--yes', () => {
  it('moves only strictly older copies into .trash, by rename, keeping the content', () => {
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    const mid = makeCopy('cache/a/0.8.18', '0.8.18');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toMatchObject({ status: 'applied', moved: 2, failed: 0 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(mid)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    const trashed = join(root, '.trash', '1700000000000-42-v0.8.9-abc123', '0.8.9');
    expect(existsSync(join(trashed, 'harness', 'dist', 'cli.js'))).toBe(true);
    // The resolver now ignores them.
    expect(scan(newest).copies.map((c) => c.version)).toEqual(['0.8.22']);
  });

  it('never moves the running copy or the newest copy, even when the running one is older', () => {
    const running = makeCopy('cache/a/0.8.10', '0.8.10');
    makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const j = JSON.parse(runRemoveOlder(scan(running), { json: true, plan: PLAN }).stdout);
    expect(j.skipped.map((s: { reason: string }) => s.reason)).toContain('running_copy');
    expect(j.would_move.map((m: { version: string }) => m.version)).toEqual(['0.8.9']);
    const run = runRemoveOlder(scan(running), { yes: true, plan: PLAN });
    expect(existsSync(running)).toBe(true);
    expect(existsSync(newest)).toBe(true);
    expect(run.summary.moved).toBe(1);
  });

  it('a copy the host install record names as an install path is left alone', () => {
    const registered = makeCopy('cache/a/0.8.19', '0.8.19');
    const other = makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    writeFileSync(
      join(root, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'mixshift-ai@mixshift': [{ installPath: registered, version: '0.8.19' }] } }),
    );
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(existsSync(registered)).toBe(true);
    expect(existsSync(other)).toBe(false);
    expect(run.summary.moved).toBe(1);
    expect(run.stdout).toContain('install record points at it');
  });

  it('a copy at the same version as the newest is left alone', () => {
    const a = makeCopy('cache/a/0.8.22', '0.8.22');
    const b = makeCopy('cache/b/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(a), { yes: true, plan: PLAN });
    expect(run.summary.moved).toBe(0);
    expect(existsSync(a) && existsSync(b)).toBe(true);
  });

  it('skips a copy with an unreadable or malformed version and lists it as skipped', () => {
    const noVersion = makeCopy('cache/a/unk1', null, { raw: '{"name":"mixshift-ai"}' });
    const bad = makeCopy('cache/a/unk2', '0.8.x');
    const broken = makeCopy('cache/a/unk3', null, { raw: '{not json' });
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(run.summary.moved).toBe(0);
    for (const d of [noVersion, bad, broken]) expect(existsSync(d)).toBe(true);
    expect(run.stdout.match(/skipped: version unknown/g)).toHaveLength(3);
  });

  it('skips anything that is not a complete MixShift plugin copy (another plugin name)', () => {
    const other = makeCopy('cache/a/0.1.0', '0.1.0', { name: 'some-other-plugin' });
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(existsSync(other)).toBe(true);
    expect(run.summary.moved).toBe(0);
    expect(run.stdout).toContain('not a complete MixShift plugin copy');
  });

  it('leaves a marketplace clone and everything already in .trash untouched', () => {
    const market = makeCopy('marketplaces/mixshift/plugins/mixshift-ai', '0.1.0');
    const trash = makeCopy('.trash/old/mixshift-ai', '0.1.0');
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(run.summary.moved).toBe(1);
    expect(existsSync(market)).toBe(true);
    expect(existsSync(trash)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('a copy folder that is a symlink or junction is skipped and its target is untouched', () => {
    const outside = writeCopy(join(base, 'elsewhere', '0.8.1'), '0.8.1');
    mkdirSync(join(root, 'cache', 'a'), { recursive: true });
    const link = join(root, 'cache', 'a', '0.8.1');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // this machine cannot create links
    }
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const s = scan(newest);
    const run = runRemoveOlder(s, { yes: true, plan: PLAN });
    expect(run.summary.moved).toBe(0);
    expect(existsSync(join(outside, 'harness', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it('a copy behind a linked parent folder (real path outside the root) is skipped', () => {
    const outside = join(base, 'elsewhere');
    writeCopy(join(outside, '0.8.1'), '0.8.1');
    try {
      symlinkSync(outside, join(root, 'linked'), 'junction');
    } catch {
      return;
    }
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect(run.summary.moved).toBe(0);
    expect(existsSync(join(outside, '0.8.1', 'harness', 'dist', 'cli.js'))).toBe(true);
  });

  it('a copy outside every scanned root is never planned', () => {
    const elsewhere = writeCopy(join(base, 'elsewhere', '0.8.1'), '0.8.1');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    // Listed only because it is handed in as the running copy, outside the root.
    const s = scanCliCopies({ onlyExtraRoots: true, extraRoots: [root], runningPluginRoot: elsewhere });
    expect(planRemoveOlder(s, PLAN).moves).toHaveLength(0);
    expect(existsSync(newest) && existsSync(elsewhere)).toBe(true);
  });
});

describe('truncated scan', () => {
  it('previews what was found but refuses --yes without --allow-partial, and moves nothing', () => {
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const s = { ...scan(newest), truncated: true };
    const preview = runRemoveOlder(s, { plan: PLAN });
    expect(preview.stdout).toContain('Search stopped early');
    expect(preview.stdout).toContain('--allow-partial');
    expect(preview.stdout).toContain('0.8.9');
    const refused = runRemoveOlder(s, { yes: true, plan: PLAN });
    expect(refused.exitCode).toBe(1);
    expect(refused.summary.status).toBe('refused');
    expect(refused.stderr).toContain('stopped early');
    expect(existsSync(old)).toBe(true);
    const j = JSON.parse(runRemoveOlder(s, { yes: true, json: true, plan: PLAN }).stdout);
    expect(j).toMatchObject({ status: 'refused', reason: 'search_truncated', changed: false });
    const allowed = runRemoveOlder(s, { yes: true, allowPartial: true, plan: PLAN });
    expect(allowed.exitCode).toBe(0);
    expect(existsSync(old)).toBe(false);
  });
});

describe('a failing rename', () => {
  it('is reported for that copy, the others still move, exit is 17, and nothing is deleted', () => {
    const a = makeCopy('cache/a/0.8.1', '0.8.1');
    const b = makeCopy('cache/a/0.8.2', '0.8.2');
    const c = makeCopy('cache/a/0.8.3', '0.8.3');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), {
      yes: true,
      plan: PLAN,
      deps: {
        rename: (from, to) => {
          if (from === b) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          renameSync(from, to);
        },
      },
    });
    expect(run.exitCode).toBe(17);
    expect(run.summary).toMatchObject({ status: 'partial', moved: 2, failed: 1 });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(join(b, 'harness', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(c)).toBe(false);
    expect(run.stdout).toContain('Could not move 0.8.2');
    expect(run.stdout).toContain('in use or not permitted');
    // The failed copy left no empty slot folder behind; the moved ones are in .trash whole.
    expect(readdirSync(join(root, '.trash')).filter((n) => n.includes('v0.8.2-'))).toEqual([]);
    expect(readdirSync(join(root, '.trash')).filter((n) => n.includes('v0.8.1-') || n.includes('v0.8.3-'))).toHaveLength(2);
  });

  it('every copy failing is "failed", still exit 17, and nothing moved', () => {
    const a = makeCopy('cache/a/0.8.1', '0.8.1');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), {
      yes: true,
      json: true,
      plan: PLAN,
      deps: {
        rename: () => {
          throw Object.assign(new Error('x'), { code: 'EXDEV' });
        },
      },
    });
    const j = JSON.parse(run.stdout);
    expect(run.exitCode).toBe(17);
    expect(j.status).toBe('failed');
    expect(j.changed).toBe(false);
    expect(j.results[0]).toMatchObject({ moved: false, error: 'EXDEV' });
    expect(existsSync(a)).toBe(true);
  });
});

describe('after moving', () => {
  it('prints the exact restore command for each moved copy and one warning about full-path references', () => {
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, plan: PLAN, platform: 'linux' });
    const to = join(root, '.trash', '1700000000000-42-v0.8.9-abc123', '0.8.9');
    expect(run.stdout).toContain(`mv "${to}" "${old}"`);
    expect(run.stdout).toContain(
      'Warning: A scheduled task, saved prompt or launcher link that points at a moved copy by its full path will now fail until it is updated.',
    );
    expect(run.stdout.match(/Warning:/g)).toHaveLength(1);
  });

  it('restoreCommand: PowerShell on Windows, mv elsewhere, plain words for an unsafe path', () => {
    expect(restoreCommand({ from: 'C:\\p\\0.8.9', to: 'C:\\p\\.trash\\s\\0.8.9' }, 'win32')).toBe(
      "Move-Item -LiteralPath 'C:\\p\\.trash\\s\\0.8.9' -Destination 'C:\\p\\0.8.9'",
    );
    expect(restoreCommand({ from: '/p/0.8.9', to: '/p/.trash/s/0.8.9' }, 'linux')).toBe('mv "/p/.trash/s/0.8.9" "/p/0.8.9"');
    expect(restoreCommand({ from: '/p/$(x)/0.8.9', to: '/p/.trash/s/0.8.9' }, 'linux')).toMatch(/^Move "/);
  });

  it('restoring by the printed paths puts the copy back where it was', () => {
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, json: true, plan: PLAN });
    const r = JSON.parse(run.stdout).restore[0];
    renameSync(r.to, r.from);
    expect(existsSync(join(old, 'harness', 'dist', 'cli.js'))).toBe(true);
  });

  it('lists a launcher link that pointed into a moved copy, with the command to re-point it', () => {
    const old = makeCopy('cache/a/0.8.9', '0.8.9');
    // A folder named like the launcher: a link to it resolves the same way, and a junction needs no privileges on Windows.
    mkdirSync(join(old, 'harness', 'bin', 'mixshift'), { recursive: true });
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    mkdirSync(join(base, '.local', 'bin'), { recursive: true });
    const link = join(base, '.local', 'bin', 'mixshift');
    try {
      symlinkSync(join(old, 'harness', 'bin', 'mixshift'), link, 'junction');
    } catch {
      return; // this machine cannot create links
    }
    const run = runRemoveOlder(scan(newest), { yes: true, json: true, plan: PLAN, platform: 'linux' });
    const j = JSON.parse(run.stdout);
    expect(j.launcher_links).toHaveLength(1);
    expect(j.launcher_links[0].path).toBe(link);
    expect(j.launcher_help.join('\n')).toContain(`ln -sf "${join(newest, 'harness', 'bin', 'mixshift')}" "${link}"`);
  });

  it('--yes JSON shape', () => {
    makeCopy('cache/a/0.8.9', '0.8.9');
    makeCopy('cache/a/unk', null, { raw: '{}' });
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const run = runRemoveOlder(scan(newest), { yes: true, json: true, plan: PLAN, platform: 'linux' });
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(1);
    const j = JSON.parse(run.stdout);
    expect(Object.keys(j).sort()).toEqual(
      ['changed', 'launcher_help', 'launcher_links', 'mode', 'newest_version', 'restore', 'results', 'skipped', 'status', 'truncated', 'warning'].sort(),
    );
    expect(j).toMatchObject({ status: 'applied', mode: 'apply', changed: true, newest_version: '0.8.22' });
    expect(j.restore[0].command).toMatch(/^mv /);
    expect(j.skipped[0]).toMatchObject({ reason: 'version_unknown', text: 'skipped: version unknown' });
  });
});

describe('telemetry summary', () => {
  it('carries counts and versions only, never a path', () => {
    makeCopy('cache/a/0.8.9', '0.8.9');
    makeCopy('cache/a/0.8.18', '0.8.18');
    makeCopy('cache/a/unk', null, { raw: '{}' });
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    for (const yes of [false, true]) {
      const run = runRemoveOlder(scan(newest), { yes, plan: PLAN });
      const text = JSON.stringify(run.summary);
      expect(text).not.toContain(base);
      expect(text).not.toMatch(/[\\/]/);
      expect(text).not.toContain('.trash');
      expect(run.summary.newest_version).toBe('0.8.22');
    }
  });

  it('after --yes the moved versions are listed', () => {
    makeCopy('cache/a/0.8.9', '0.8.9');
    makeCopy('cache/a/0.8.18', '0.8.18');
    const newest = makeCopy('cache/a/0.8.22', '0.8.22');
    const applied = runRemoveOlder(scan(newest), { yes: true, plan: PLAN });
    expect([...applied.summary.versions_moved].sort()).toEqual(['0.8.18', '0.8.9']);
  });
});
