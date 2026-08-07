/**
 * Tests for `mixshift version`'s installed-vs-running comparison logic
 * (feedback 36645/36672/36728). `evaluateInstallSituation` itself is covered
 * exhaustively by lib/install-record.test.ts; this file covers the thin
 * mapping into the command's own `VersionReport` JSON shape, which is what
 * `mixshift version --json` consumers (the mx-update skill's Step 1) and the
 * terminal renderer actually read, PLUS the terminal renderer itself
 * (`renderVersionOutput`), where a red-team finding lived:
 *
 *   F2: the terminal renderer early-returned on `session_behind_install`
 *   BEFORE `latest`/`isStale` were ever printed, and unconditionally emitted
 *   "The update already succeeded." `session_behind_install` and `isStale`
 *   are independent (current < installed < latest is a real state, pinned
 *   by the `buildVersionReport` test below), so a real available update
 *   stayed invisible and the "already succeeded" claim was asserted even
 *   when a further release was still pending.
 *
 * `buildVersionReport` and `renderVersionOutput` are both pure (no
 * filesystem/network), so these tests never touch the real install record.
 */

import { describe, it, expect } from 'vitest';
import { buildVersionReport, renderVersionOutput } from './version.js';

describe('buildVersionReport', () => {
  it('matching versions: not behind, not stale', () => {
    const report = buildVersionReport({
      current: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report).toEqual({
      current: '0.8.7',
      installed: '0.8.7',
      latest: '0.8.7',
      isStale: false,
      staleBasis: 'installed',
      session_behind_install: false,
      releaseUrl: null,
      fetched: true,
    });
  });

  it('installed newer than current (the feedback 36645/36672/36728 scenario): session_behind_install true, judged NOT stale because the install already caught up to latest', () => {
    const report = buildVersionReport({
      current: '0.8.6',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(true);
    expect(report.staleBasis).toBe('installed');
    expect(report.isStale).toBe(false);
    expect(report.releaseUrl).toBeNull();
  });

  it('installed newer than current AND still behind latest: both flags true, staleBasis installed', () => {
    const report = buildVersionReport({
      current: '0.8.5',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(true);
    expect(report.isStale).toBe(true);
    expect(report.staleBasis).toBe('installed');
    expect(report.releaseUrl).toContain('0.8.7');
  });

  it('install record unreadable (null): falls back to current as the basis, session_behind_install false', () => {
    const report = buildVersionReport({
      current: '0.8.6',
      installed: null,
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(false);
    expect(report.staleBasis).toBe('current');
    expect(report.isStale).toBe(true);
    expect(report.releaseUrl).toContain('0.8.7');
  });

  it('install record unreadable and current matches latest: not stale', () => {
    const report = buildVersionReport({
      current: '0.8.7',
      installed: null,
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.isStale).toBe(false);
    expect(report.releaseUrl).toBeNull();
  });

  it('latest unknown (offline, no cache): isStale false, session_behind_install still computed purely locally', () => {
    const report = buildVersionReport({
      current: '0.8.5',
      installed: '0.8.7',
      latest: null,
      fetched: false,
    });
    expect(report.session_behind_install).toBe(true);
    expect(report.isStale).toBe(false);
    expect(report.releaseUrl).toBeNull();
    expect(report.latest).toBeNull();
  });

  it('running ahead of latest (pre-release / dev build), install matches current: not stale, not behind', () => {
    const report = buildVersionReport({
      current: '0.9.0',
      installed: '0.9.0',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(false);
    expect(report.isStale).toBe(false);
  });

  it('preserves fetched and current/installed/latest pass-through fields verbatim', () => {
    const report = buildVersionReport({
      current: '0.8.6',
      installed: '0.8.7',
      latest: '0.8.8',
      fetched: false,
    });
    expect(report.current).toBe('0.8.6');
    expect(report.installed).toBe('0.8.7');
    expect(report.latest).toBe('0.8.8');
    expect(report.fetched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderVersionOutput — F2 regression: session_behind_install must not
// short-circuit latest/isStale, and must not claim "already succeeded" when
// a further update is still pending.
// ---------------------------------------------------------------------------

describe('renderVersionOutput', () => {
  it('F2 regression: current < installed < latest surfaces BOTH facts (behind-install notice AND the update banner), never early-returns', () => {
    const report = buildVersionReport({
      current: '0.8.5',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(true);
    expect(report.isStale).toBe(true);
    const text = renderVersionOutput(report);
    // The behind-install notice still prints.
    expect(text).toContain('Installed: 0.8.6');
    expect(text).toContain('This session is running: 0.8.5');
    // The old bug: this fact never reached the user because of the early
    // return. It must now be visible, latest AND the update banner.
    expect(text).toContain('0.8.7');
    expect(text).toMatch(/update available/i);
  });

  it('F2 regression: does not assert "The update already succeeded" when the install itself is still behind latest', () => {
    const report = buildVersionReport({
      current: '0.8.5',
      installed: '0.8.6',
      latest: '0.8.7',
      fetched: true,
    });
    const text = renderVersionOutput(report);
    expect(text).not.toContain('The update already succeeded.');
  });

  it('asserts "The update already succeeded" only when the install record IS at latest (fully caught up)', () => {
    const report = buildVersionReport({
      current: '0.8.6',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    expect(report.session_behind_install).toBe(true);
    expect(report.isStale).toBe(false);
    const text = renderVersionOutput(report);
    expect(text).toContain('The update already succeeded.');
  });

  it('plain session_behind_install (not also stale) still shows "up to date" for latest, unaffected by the F2 fix', () => {
    const report = buildVersionReport({
      current: '0.8.6',
      installed: '0.8.7',
      latest: '0.8.7',
      fetched: true,
    });
    const text = renderVersionOutput(report);
    expect(text).toContain('up to date (latest is v0.8.7)');
  });

  it('no em dashes anywhere in the rendered output (customer-facing CLI)', () => {
    const scenarios = [
      { current: '0.8.5', installed: '0.8.6', latest: '0.8.7', fetched: true },
      { current: '0.8.6', installed: '0.8.7', latest: '0.8.7', fetched: true },
      { current: '0.8.7', installed: null, latest: '0.8.8', fetched: true },
      { current: '0.8.7', installed: '0.8.7', latest: null, fetched: false },
    ];
    for (const s of scenarios) {
      const text = renderVersionOutput(buildVersionReport(s));
      expect(text).not.toContain('—');
    }
  });
});
