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

  // The 2026-06-16 fix: Cowork embeds the CC engine, so CLAUDECODE=1 is set in
  // Cowork too. Detection must still resolve `cowork` via the payload-path
  // marker, and must run before the Claude Code detector.
  it('detects Cowork by payload-path marker even when CLAUDECODE=1', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_PLUGIN_ROOT =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/abc/def/rpm/plugin_x/.claude-plugin';
    expect(detectSurface()).toBe('cowork');
  });

  it('detects Cowork from the payload marker on argv[1]', () => {
    process.argv[1] =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/s/p/rpm/plugin_x/harness/dist/cli.js';
    expect(detectSurface()).toBe('cowork');
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

  it('reports decidedBy=cowork with the marker found on argv[1]', () => {
    process.argv[1] =
      'C:/Users/u/AppData/Roaming/Claude/local-agent-mode-sessions/s/p/rpm/plugin_x/harness/dist/cli.js';
    const p = probeSurface();
    expect(p.result).toBe('cowork');
    expect(p.decidedBy).toBe('cowork');
    expect(p.coworkMarkerPresent).toBe(true);
  });

  it('reports decidedBy=flag and echoes the flag value', () => {
    const p = probeSurface('claude_desktop');
    expect(p.result).toBe('claude_desktop');
    expect(p.decidedBy).toBe('flag');
    expect(p.flag).toBe('claude_desktop');
  });
});
