/**
 * Integration tests for check-no-internal-exposure rule 5, the PRIVATE name
 * denylist read from EXPOSURE_DENYLIST (a GitHub Actions secret in CI). Spawns
 * the real script, exactly as `npm run check-no-internal-exposure` runs it, so
 * the exit code and the printed text are what CI sees.
 *
 * Locks in three behaviors:
 *   - no list -> warn, raise a ::warning annotation under GitHub Actions, exit 0
 *     (the secret may not exist yet, and fork PRs never get secrets);
 *   - a list with no hits -> exit 0;
 *   - a list with a hit -> exit 1, file:line + entry number, and the listed
 *     name itself is never printed.
 *
 * The "present" name is the repo's fictional placeholder brand, already used in
 * docs and tests, so no real name is needed here. The script scans every
 * tracked file, so each run takes a few seconds.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(here, '..');
const SCRIPT_PATH = join(HARNESS_DIR, 'scripts', 'check-no-internal-exposure.mjs');

// Fictional placeholder brand that appears in tracked docs and tests.
const PRESENT_PLACEHOLDER = ['Glacier', 'Bottle'].join(' ');
// Names that must appear NOWHERE in tracked content, this file included, so
// they are built reversed at runtime (the scan only ever sees the reversed text).
const reverse = (s: string) => s.split('').reverse().join('');
const ABSENT_NAMES = [reverse('emandnarB ylekilnU vqxZ'), reverse('oC redlohecalP xzzqQ')];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      cwd: HARNESS_DIR,
      env: {
        ...process.env,
        EXPOSURE_DENYLIST: undefined,
        EXPOSURE_DENYLIST_FILE: undefined,
        GITHUB_ACTIONS: undefined,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('runScript timed out'));
    }, 90_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

describe('check-no-internal-exposure rule 5 (EXPOSURE_DENYLIST)', () => {
  it('skips with a warning and a GitHub annotation when the list is absent', async () => {
    const res = await runScript({ GITHUB_ACTIONS: 'true' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('name-class scan SKIPPED');
    expect(res.stdout).toContain('::warning title=EXPOSURE_DENYLIST not set::');
    expect(res.stdout).not.toContain('denylisted name #');
  }, 120_000);

  it('passes when no listed name appears in tracked content', async () => {
    const res = await runScript({ EXPOSURE_DENYLIST: ABSENT_NAMES.join(', ') });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('name-class scan clean (2 denylisted name(s)');
    expect(res.stdout).not.toContain('SKIPPED');
  }, 120_000);

  it('fails on a listed name in tracked content, pointing at file:line + entry, never printing the name', async () => {
    const res = await runScript({ EXPOSURE_DENYLIST: `AB\n# comment line\n${PRESENT_PLACEHOLDER}` });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('entry #1 skipped');
    expect(res.stderr).toContain('DENYLISTED customer/brand name');
    expect(res.stderr).toMatch(/\n {2}\S+:\d+: denylisted name #2\n/);
    expect(res.stderr).not.toContain('denylisted name #1');
    const printed = (res.stdout + res.stderr).toLowerCase();
    for (const token of PRESENT_PLACEHOLDER.toLowerCase().split(' ')) {
      expect(printed).not.toContain(token);
    }
  }, 120_000);
});
