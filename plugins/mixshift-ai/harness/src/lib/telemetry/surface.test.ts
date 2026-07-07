import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSurface, probeSurface } from './surface.js';

// Env keys + argv[1] that detection reads. Cleared before each test so every
// case starts from a known baseline regardless of the real runner environment.
const SIGNAL_KEYS = [
  'MIXSHIFT_SURFACE',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_VERSION',
  'COWORK',
  'COWORK_VERSION',
  'COWORK_PLUGIN_HOST',
  'CLAUDE_PLUGIN_ROOT',
  // CI/automation markers — cleared so the runner's own CI env doesn't force
  // the bare-CLI fallback to cli_headless when a test wants interactive cli.
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
  'TF_BUILD',
];

describe('detectSurface', () => {
  const savedEnv = { ...process.env };
  const savedArgv1 = process.argv[1];
  const savedOutTty = process.stdout.isTTY;
  const savedErrTty = process.stderr.isTTY;

  beforeEach(() => {
    for (const k of SIGNAL_KEYS) delete process.env[k];
    // Neutral argv[1] so the real vitest runner path can't leak a marker.
    process.argv[1] = '/tmp/test-runner.js';
    // Headless baseline so the bare-CLI fallback is deterministic; tests that
    // want interactive `cli` set process.stdout.isTTY = true explicitly.
    process.stdout.isTTY = false;
    process.stderr.isTTY = false;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.argv[1] = savedArgv1;
    process.stdout.isTTY = savedOutTty;
    process.stderr.isTTY = savedErrTty;
  });

  it('honors the MIXSHIFT_SURFACE override above everything', () => {
    process.env.MIXSHIFT_SURFACE = 'cowork';
    process.env.CLAUDECODE = '1';
    expect(detectSurface()).toBe('cowork');
  });

  it('honors the --surface flag', () => {
    expect(detectSurface('claude_desktop')).toBe('claude_desktop');
  });

  it('falls back to cli_headless with no signals in a headless env', () => {
    // baseline (beforeEach): no TTY, no CI
    expect(detectSurface()).toBe('cli_headless');
  });

  it('falls back to interactive cli when a TTY is attached', () => {
    process.stdout.isTTY = true;
    expect(detectSurface()).toBe('cli');
  });

  it('classifies CI as cli_headless even with a TTY attached', () => {
    process.stdout.isTTY = true;
    process.env.CI = 'true';
    expect(detectSurface()).toBe('cli_headless');
  });

  it('detects Claude Code from CLAUDECODE=1 (plugin root under ~/.claude/plugins)', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_PLUGIN_ROOT =
      '/home/u/.claude/plugins/marketplaces/mixshift/plugins/mixshift-ai';
    expect(detectSurface()).toBe('claude_code');
  });

  // 2026-07-07 correction (supersedes the 2026-06-16 note): the
  // `local-agent-mode-sessions` marker is the Claude DESKTOP app's payload
  // substrate, NOT Cowork. A desktop session (marker in the plugin root +
  // CLAUDECODE=1 + claude-desktop entrypoint) resolves `claude_desktop`.
  it('detects the Claude desktop app (local-agent-mode-sessions marker) as claude_desktop', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
    process.env.CLAUDE_PLUGIN_ROOT =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/abc/def/rpm/plugin_x/.claude-plugin';
    expect(detectSurface()).toBe('claude_desktop');
  });

  it('detects the desktop app from the payload marker on argv[1] even if the entrypoint env is stripped', () => {
    // No CLAUDE_CODE_ENTRYPOINT (a subprocess dropped it); the marker still identifies the desktop app.
    process.argv[1] =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/s/p/rpm/plugin_x/harness/dist/cli.js';
    expect(detectSurface()).toBe('claude_desktop');
  });

  // Real cloud Cowork (verified `mixshift telemetry surface` dump 2026-07-07):
  // linux, NO env signals at all, payload under /sessions/<id>/mnt/.remote-plugins/.
  // Must resolve `cowork` — previously fell through to cli_headless and was dropped.
  it('detects cloud Cowork from the /sessions/.remote-plugins payload path with no env', () => {
    process.argv[1] =
      '/sessions/stoic-exciting-gates/mnt/.remote-plugins/plugin_x/harness/dist/cli.js';
    expect(detectSurface()).toBe('cowork');
  });

  // Regression guard (red-team blocker 2026-07-07): remote/cloud Claude Code (web +
  // scheduled cloud agents) shares the SAME /sessions/.remote-plugins substrate as cloud
  // Cowork, but it sets CLAUDECODE=1. The engine signal must win — it stays 'claude_code'
  // and is NOT swept into 'cowork' by the shared path marker.
  it('classifies remote/cloud Claude Code (CLAUDECODE=1 under /sessions/.remote-plugins) as claude_code, not cowork', () => {
    process.env.CLAUDECODE = '1';
    process.argv[1] = '/sessions/abc/mnt/.remote-plugins/plugin_x/harness/dist/cli.js';
    expect(detectSurface()).toBe('claude_code');
  });

  // The cloud-Cowork match is anchored (needs a '/sessions/' segment AND a
  // '.remote-plugins' path segment), so a local path that merely contains the
  // substring is NOT mislabeled 'cowork'.
  it('does not mislabel a local path that merely contains ".remote-plugins" as cowork', () => {
    process.argv[1] = '/home/dev/projects/foo.remote-plugins-old/tool/cli.js';
    expect(detectSurface()).toBe('cli_headless'); // headless baseline, no host signal
  });

  it('detects Cowork from an explicit COWORK env var', () => {
    process.env.COWORK = '1';
    expect(detectSurface()).toBe('cowork');
  });

  it('marks plugin_host_unknown when a plugin root is set with no other signal', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/some/unknown/host/plugin';
    expect(detectSurface()).toBe('plugin_host_unknown');
  });
});

describe('probeSurface', () => {
  const savedEnv = { ...process.env };
  const savedArgv1 = process.argv[1];
  const savedOutTty = process.stdout.isTTY;
  const savedErrTty = process.stderr.isTTY;

  beforeEach(() => {
    for (const k of SIGNAL_KEYS) delete process.env[k];
    process.argv[1] = '/tmp/test-runner.js';
    // Headless baseline; interactive tests opt into a TTY explicitly.
    process.stdout.isTTY = false;
    process.stderr.isTTY = false;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.argv[1] = savedArgv1;
    process.stdout.isTTY = savedOutTty;
    process.stderr.isTTY = savedErrTty;
  });

  it('result always equals detectSurface (probe IS the decision)', () => {
    process.env.CLAUDECODE = '1';
    expect(probeSurface().result).toBe(detectSurface());
  });

  it('reports a headless fallback (cli_headless) and raw signals when nothing is set', () => {
    const p = probeSurface();
    expect(p.result).toBe('cli_headless');
    expect(p.decidedBy).toBe('fallback');
    expect(p.tty).toBe(false);
    expect(p.ci).toBe(false);
    expect(p.coworkMarkerPresent).toBe(false);
    expect(p.env.CLAUDECODE).toBeUndefined();
    expect(p.env.CLAUDE_PLUGIN_ROOT).toBeUndefined();
  });

  it('reports interactive cli (tty true) at the fallback when a TTY is attached', () => {
    process.stdout.isTTY = true;
    const p = probeSurface();
    expect(p.result).toBe('cli');
    expect(p.decidedBy).toBe('fallback');
    expect(p.tty).toBe(true);
    expect(p.ci).toBe(false);
  });

  it('reports decidedBy=claude_code and surfaces the CLAUDECODE signal', () => {
    process.env.CLAUDECODE = '1';
    const p = probeSurface();
    expect(p.result).toBe('claude_code');
    expect(p.decidedBy).toBe('claude_code');
    expect(p.env.CLAUDECODE).toBe('1');
  });

  it('reports decidedBy=cowork with the cloud-Cowork marker found on argv[1]', () => {
    process.argv[1] =
      '/sessions/stoic-exciting-gates/mnt/.remote-plugins/plugin_x/harness/dist/cli.js';
    const p = probeSurface();
    expect(p.result).toBe('cowork');
    expect(p.decidedBy).toBe('cowork');
    expect(p.coworkMarkerPresent).toBe(true);
    expect(p.desktopMarkerPresent).toBe(false);
  });

  it('reports the desktop-app marker and resolves claude_desktop', () => {
    process.argv[1] =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/s/p/rpm/plugin_x/harness/dist/cli.js';
    const p = probeSurface();
    expect(p.result).toBe('claude_desktop');
    expect(p.decidedBy).toBe('claude_desktop'); // decidedBy reports the resolved surface, not the detector name
    expect(p.desktopMarkerPresent).toBe(true);
    expect(p.coworkMarkerPresent).toBe(false);
  });

  it('reports decidedBy=flag and echoes the flag value', () => {
    const p = probeSurface('claude_desktop');
    expect(p.result).toBe('claude_desktop');
    expect(p.decidedBy).toBe('flag');
    expect(p.flag).toBe('claude_desktop');
  });
});
