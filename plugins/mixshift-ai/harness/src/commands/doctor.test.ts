/**
 * Tests for `mixshift doctor`'s installed-vs-running comparison logic
 * (feedback 36645/36672/36728). `evaluateInstallSituation` itself is covered
 * exhaustively by lib/install-record.test.ts; this file covers the thin
 * mapping into the report's `build` section, which is what the terminal
 * renderer and the --json consumer both read, PLUS the terminal renderer
 * itself (`renderBuildSection` / `renderBuildStaleBanner`), which is where
 * two red-team findings lived:
 *
 *   F1: the `installed` line branched on `installed === null` then
 *   `sessionBehindInstall` then an unconditional `else` labeled "(matches
 *   this session)" — but `sessionBehindInstall` is only true when installed
 *   is NEWER, so that `else` also caught installed being OLDER and
 *   mislabeled it a match.
 *
 *   F2: the trailing update banner required `!sessionBehindInstall`, hiding
 *   a real available update whenever the install record was ALSO stale
 *   (current < installed < latest) — a state that is real, independent of
 *   sessionBehindInstall, and left the "(see below)" text on the `latest`
 *   line pointing at nothing.
 *
 * `buildDoctorBuildSection` is pure (no filesystem/network/auth), so these
 * tests never touch the real install record or the rest of
 * `assembleFullReport`'s side effects. `renderBuildSection`/
 * `renderBuildStaleBanner` are likewise pure functions of the `build` value
 * `buildDoctorBuildSection` produces, so the full data-to-text pipeline is
 * exercised without constructing a full `DoctorFullReport` (auth/network/
 * telemetry) fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDoctorBuildSection,
  renderBuildSection,
  renderBuildStaleBanner,
} from './doctor.js';

describe('buildDoctorBuildSection', () => {
  it('matching versions: not behind, not stale, basis installed', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(build).toEqual({
      version: '0.8.7',
      installed: '0.8.7',
      sessionBehindInstall: false,
      latest: '0.8.7',
      stale: false,
      staleBasis: 'installed',
      releaseUrl: null,
      checkedRemote: true,
    });
  });

  it('installed newer than the running version (the feedback 36645/36672/36728 scenario): sessionBehindInstall true, NOT stale because the install already caught up to latest', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.6',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.sessionBehindInstall).toBe(true);
    expect(build.staleBasis).toBe('installed');
    expect(build.stale).toBe(false);
    expect(build.releaseUrl).toBeNull();
  });

  it('installed newer than running AND still behind latest: both flags true', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.5',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.sessionBehindInstall).toBe(true);
    expect(build.stale).toBe(true);
    expect(build.staleBasis).toBe('installed');
    expect(build.releaseUrl).toContain('0.8.7');
  });

  it('install record unreadable on this surface (e.g. Cowork): falls back to the running version as the basis', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.6',
      installed: null,
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.installed).toBeNull();
    expect(build.sessionBehindInstall).toBe(false);
    expect(build.staleBasis).toBe('current');
    expect(build.stale).toBe(true);
    expect(build.releaseUrl).toContain('0.8.7');
  });

  it('install record unreadable and running version matches latest: not stale', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: null,
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.stale).toBe(false);
    expect(build.releaseUrl).toBeNull();
  });

  it('latest unknown (offline, no cache): stale false, sessionBehindInstall still computed purely locally', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.5',
      installed: '0.8.7',
      latest: null,
      fetched: false,
    });
    expect(build.sessionBehindInstall).toBe(true);
    expect(build.stale).toBe(false);
    expect(build.releaseUrl).toBeNull();
    expect(build.latest).toBeNull();
  });

  it('passes checkedRemote through verbatim from the fetch outcome', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: false,
    });
    expect(build.checkedRemote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderBuildSection — F1 regression: installed OLDER than running must NOT
// render as "(matches this session)".
// ---------------------------------------------------------------------------

describe('renderBuildSection', () => {
  it('F1 regression: installed OLDER than running renders a distinct OLDER line, never "matches"', () => {
    // current 0.8.7 running, but the on-disk record still says 0.8.6 (stale
    // record; running session is ahead of it) — reproduces the exact bug
    // report's repro (running payload ahead of the host record).
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    const lines = renderBuildSection(build);
    const installedLine = lines.find((l) => l.startsWith('  installed:'));
    expect(installedLine).toBeDefined();
    expect(installedLine).toContain('0.8.6');
    expect(installedLine).not.toContain('matches this session');
    expect(installedLine).toMatch(/older than this session/i);
    // The two version numbers must never appear on the same line under a
    // "matches" claim — the exact defect (two different versions, one line
    // apart, labeled as agreeing).
    expect(installedLine).not.toContain('0.8.7');
  });

  it('F1: the coherence note explains the `latest` line is judged against the OLDER installed record, not the running session', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.8',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    const lines = renderBuildSection(build);
    // latest matches the (older) installed record, so this used to render
    // "up to date" right under a false "(matches this session)" claim,
    // describing a coherent-looking but wrong state (0.8.7 everywhere) that
    // the user (running 0.8.8) is not actually in.
    const latestLine = lines.find((l) => l.startsWith('  latest:'));
    expect(latestLine).toContain('up to date');
    const noteLine = lines.find((l) => l.startsWith('  note:'));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain('0.8.7');
    expect(noteLine).toContain('0.8.8');
  });

  it('installed NEWER than running (sessionBehindInstall) still renders the NEWER line, unaffected by the F1 fix', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.5',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    const lines = renderBuildSection(build);
    const installedLine = lines.find((l) => l.startsWith('  installed:'));
    expect(installedLine).toContain('NEWER than this session');
  });

  it('installed exactly matching running still renders "(matches this session)"', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    const lines = renderBuildSection(build);
    const installedLine = lines.find((l) => l.startsWith('  installed:'));
    expect(installedLine).toContain('matches this session');
  });

  it('no em dashes in any rendered line (customer-facing CLI output)', () => {
    for (const build of [
      buildDoctorBuildSection({ version: '0.8.7', installed: '0.8.6', latest: '0.8.8', fetched: true }),
      buildDoctorBuildSection({ version: '0.8.5', installed: '0.8.6', latest: '0.8.7', fetched: true }),
      buildDoctorBuildSection({ version: '0.8.7', installed: null, latest: null, fetched: false }),
    ]) {
      for (const line of renderBuildSection(build)) {
        expect(line).not.toContain('—');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// renderBuildStaleBanner — F2 regression: the update banner must render
// whenever the install itself is stale, independent of sessionBehindInstall.
// ---------------------------------------------------------------------------

describe('renderBuildStaleBanner', () => {
  it('F2 regression: current < installed < latest still surfaces the update banner (not suppressed by sessionBehindInstall)', () => {
    // The PR's own pinned co-occurring scenario: 0.8.5 running / 0.8.6
    // installed / 0.8.7 latest. sessionBehindInstall is true AND stale is
    // true; both must reach the user.
    const build = buildDoctorBuildSection({
      version: '0.8.5',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.sessionBehindInstall).toBe(true);
    expect(build.stale).toBe(true);
    const banner = renderBuildStaleBanner(build);
    expect(banner).not.toBe('');
    expect(banner).toContain('0.8.7');
  });

  it('renders nothing when not stale, regardless of sessionBehindInstall', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.5',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(build.sessionBehindInstall).toBe(true);
    expect(build.stale).toBe(false);
    expect(renderBuildStaleBanner(build)).toBe('');
  });

  it('renders the banner for the plain (not session-behind) stale case, unaffected by the F2 fix', () => {
    const build = buildDoctorBuildSection({
      version: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.8',
      fetched: true,
    });
    expect(build.sessionBehindInstall).toBe(false);
    expect(build.stale).toBe(true);
    expect(renderBuildStaleBanner(build)).toContain('0.8.8');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: renderBuildSection's "(see below)" text must always have a
// non-empty renderBuildStaleBanner to point at (the dangling-contradiction
// half of F2).
// ---------------------------------------------------------------------------

describe('renderBuildSection + renderBuildStaleBanner coherence', () => {
  it('whenever the Build section says "(see below)", the banner is non-empty', () => {
    const scenarios = [
      { version: '0.8.7', installed: '0.8.7', latest: '0.8.8', fetched: true },
      { version: '0.8.5', installed: '0.8.6', latest: '0.8.7', fetched: true }, // F2 scenario
      { version: '0.8.5', installed: '0.8.7', latest: '0.8.7', fetched: true }, // sessionBehindInstall, not stale
    ];
    for (const s of scenarios) {
      const build = buildDoctorBuildSection(s);
      const lines = renderBuildSection(build);
      const saysSeeBelow = lines.some((l) => l.includes('see below'));
      const banner = renderBuildStaleBanner(build);
      if (saysSeeBelow) {
        expect(banner).not.toBe('');
      }
    }
  });
});
