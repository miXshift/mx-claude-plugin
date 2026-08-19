/**
 * scrubDetail: the last-resort net between a raw `detail` string (which can
 * carry a Node.js fs error's absolute local path) and a telemetry payload
 * (events.ts's context_sync.* contract: slugs/counts/outcomes, never paths).
 * See telemetry-detail.ts's module doc for the full rationale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Configurable fake homedir(), following Vitest's documented pattern for a
// mock factory that needs to read a value set later by individual tests
// (vi.hoisted avoids the TDZ trap of a plain top-level `let`).
const { getHome, setHome } = vi.hoisted(() => {
  let home = '';
  return {
    getHome: (): string => home,
    setHome: (h: string): void => {
      home = h;
    },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => getHome() };
});

import { scrubDetail } from './telemetry-detail.js';

beforeEach(() => {
  setHome('');
});

describe('scrubDetail', () => {
  it('a plain message with no path-shaped substring passes through unchanged', () => {
    expect(scrubDetail('timed out after 2000ms')).toBe('timed out after 2000ms');
  });

  it('does not mangle ordinary prose containing a single slash', () => {
    const detail = 'resolve with --force (take the server version) — either/or';
    expect(scrubDetail(detail)).toBe(detail);
  });

  it('an EBUSY message with a quoted Windows path under the home dir: no drive letter, no backslash segments, no username', () => {
    setHome('C:\\Users\\sam');
    const raw =
      "EBUSY: resource busy or locked, open 'C:\\Users\\sam\\.mixshift\\clients\\acme\\corpora\\notes.md'";
    const scrubbed = scrubDetail(raw);
    expect(scrubbed).toContain('EBUSY');
    expect(scrubbed).not.toMatch(/[A-Za-z]:\\/); // no drive letter
    expect(scrubbed).not.toContain('\\'); // no backslash-separated segments at all
    expect(scrubbed).not.toContain('sam'); // the username is gone
    expect(scrubbed).toBe("EBUSY: resource busy or locked, open '<path>'");
  });

  it('a POSIX home-dir path (forward slashes) is scrubbed the same way', () => {
    setHome('/home/sam');
    const raw =
      "EPERM: operation not permitted, open '/home/sam/.mixshift/clients/acme/context.yaml'";
    const scrubbed = scrubDetail(raw);
    expect(scrubbed).toContain('EPERM');
    expect(scrubbed).not.toContain('/home/sam');
    expect(scrubbed).not.toContain('sam');
  });

  it('a path OUTSIDE the home dir (different drive) is still collapsed via the path-token pass', () => {
    setHome('C:\\Users\\sam');
    const raw = "EBUSY: resource busy or locked, open 'D:\\Backups\\acme\\context.yaml'";
    const scrubbed = scrubDetail(raw);
    expect(scrubbed).toContain('EBUSY');
    expect(scrubbed).not.toMatch(/[A-Za-z]:\\/);
    expect(scrubbed).not.toContain('Backups');
  });

  it('an unresolvable homedir (empty string) still runs the path-token pass', () => {
    setHome('');
    const raw = "EBUSY: open 'C:\\Users\\other\\.mixshift\\clients\\acme\\notes.md'";
    const scrubbed = scrubDetail(raw);
    expect(scrubbed).not.toMatch(/[A-Za-z]:\\/);
    expect(scrubbed).not.toContain('other');
  });

  it('caps very long details at ~300 chars', () => {
    const long = 'x'.repeat(500);
    const scrubbed = scrubDetail(long);
    expect(scrubbed.length).toBeLessThanOrEqual(301); // 300 chars + one ellipsis marker
    expect(scrubbed.startsWith('x'.repeat(300))).toBe(true);
  });
});
