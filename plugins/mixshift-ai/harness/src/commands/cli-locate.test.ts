/**
 * Tests for `mixshift cli locate` (feedback 3070886): one answer to "which
 * cli.js is the current one".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCliLocateCommand, renderCopiesList, buildLocateJson, TRUNCATED_LINE } from './cli-locate.js';
import { scanCliCopies } from '../lib/cli-copies.js';

let base: string;
let out: string[];
let err: string[];

function makeCopy(rel: string, version: string): string {
  const root = join(base, rel);
  mkdirSync(join(root, 'harness', 'dist'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'harness', 'dist', 'cli.js'), '// cli\n');
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return join(root, 'harness', 'dist', 'cli.js');
}

async function run(...args: string[]): Promise<void> {
  const program = new Command().option('--json', 'json', false);
  program.exitOverride();
  registerCliLocateCommand(program);
  await program.parseAsync(['node', 'mixshift', ...args]);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mx-locate-'));
  out = [];
  err = [];
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe('mixshift cli locate', () => {
  it('prints the newest copy path as one line', async () => {
    makeCopy('c/a', '0.8.9');
    const newest = makeCopy('c/b', '99.1.0');
    makeCopy('c/c', '0.8.10');
    await run('cli', 'locate', '--root', base);
    // The running copy (this repo, 0.8.x) is always included; 99.x must still win.
    expect(out.join('')).toBe(newest + '\n');
  });

  it('--list shows every copy newest first with the version and a newest tag', async () => {
    makeCopy('c/a', '0.8.9');
    makeCopy('c/b', '99.0.0');
    await run('cli', 'locate', '--list', '--root', base);
    const lines = out.join('').trim().split('\n').filter((l) => l.includes(base));
    expect(lines[0]).toMatch(/^99\.0\.0\s.*\[newest/);
    expect(lines[lines.length - 1]).toMatch(/^0\.8\.9\s/);
  });

  it('--json returns newest, copies and scanned_roots', async () => {
    const newest = makeCopy('c/b', '99.0.0');
    makeCopy('c/a', '0.8.9');
    await run('--json', 'cli', 'locate', '--root', base);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.newest).toMatchObject({ path: newest, version: '99.0.0', newest: true });
    const mine = parsed.copies
      .filter((c: { path: string }) => c.path.startsWith(base))
      .map((c: { version: string }) => c.version);
    expect(mine).toEqual(['99.0.0', '0.8.9']);
    expect(parsed.scanned_roots).toContain(base);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('renderCopiesList', () => {
  it('marks the only copy as newest', () => {
    makeCopy('c/a', '0.8.9');
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] });
    expect(renderCopiesList(scan)).toMatch(/^0\.8\.9\s.*\[newest\]\n$/);
  });

  it('prints nothing for an empty scan', () => {
    const scan = scanCliCopies({ onlyExtraRoots: true, extraRoots: [join(base, 'none')] });
    expect(renderCopiesList(scan)).toBe('');
  });
});

describe('truncated scans', () => {
  it('buildLocateJson carries truncated, and the list ends with the plain line when true', () => {
    makeCopy('c/a', '0.8.9');
    const scan = { ...scanCliCopies({ onlyExtraRoots: true, extraRoots: [base] }), truncated: true };
    expect(buildLocateJson(scan).truncated).toBe(true);
    const text = renderCopiesList(scan);
    expect(text.trimEnd().split('\n').at(-1)).toBe('Search stopped early; there may be other copies.');
    expect(renderCopiesList({ ...scan, truncated: false })).not.toContain(TRUNCATED_LINE);
    expect(buildLocateJson({ ...scan, truncated: false }).truncated).toBe(false);
  });
});
