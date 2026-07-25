import { describe, it, expect } from 'vitest';
import { parseChangelog, entriesSince, whatsNewFor } from './changelog.js';

const SAMPLE = `# Changelog

All notable changes are recorded here. This log starts at 0.5.39.

## 0.5.40

A small release.

### Fixed

- Feedback is never dropped at the email gate.

## 0.5.39

### Changed

- Renamed a skill.

### Removed

- Removed an internal skill.
`;

describe('parseChangelog', () => {
  it('splits into version entries newest-first, ignoring the title/intro', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
  });

  it('keeps ### sub-headings inside the section notes (does not split on them)', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.notes).toContain('### Fixed');
    expect(first.notes).toContain('email gate');
    // the next version heading must NOT leak into this entry's notes
    expect(first.notes).not.toContain('Renamed a skill');
  });

  it('extracts a clean version token from a bracketed/dated heading', () => {
    const entries = parseChangelog('## [1.2.3] - 2026-06-24\n\n- note\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('1.2.3');
  });

  it('returns an empty array for input with no version headings', () => {
    expect(parseChangelog('# Changelog\n\njust intro, no releases\n')).toEqual([]);
  });

  it('strips HTML comments (e.g. the unreleased marker) from notes', () => {
    const md =
      '## 0.9.0\n\n<!-- unreleased: version bump happens at release cut -->\n\n### Added\n\n- A real bullet\n';
    const [entry] = parseChangelog(md);
    expect(entry.notes).not.toContain('<!--');
    expect(entry.notes).not.toContain('unreleased');
    expect(entry.notes).toContain('### Added');
    expect(entry.notes).toContain('A real bullet');
  });
});

describe('entriesSince', () => {
  it('returns only entries strictly newer than the given version', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entriesSince(entries, '0.5.39').map((e) => e.version)).toEqual(['0.5.40']);
    expect(entriesSince(entries, '0.5.40')).toEqual([]);
    expect(entriesSince(entries, '0.5.0').map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
  });
});

describe('whatsNewFor', () => {
  const entries = parseChangelog(SAMPLE);

  it('shows what you would gain when behind', () => {
    expect(whatsNewFor(entries, '0.5.39').map((e) => e.version)).toEqual(['0.5.40']);
  });

  it("shows your own version's entry when current", () => {
    expect(whatsNewFor(entries, '0.5.40').map((e) => e.version)).toEqual(['0.5.40']);
  });

  it('falls back to the latest entry when the installed version is unknown to the log', () => {
    expect(whatsNewFor(entries, '0.4.0').map((e) => e.version)).toEqual(['0.5.40', '0.5.39']);
    expect(whatsNewFor(entries, '9.9.9').map((e) => e.version)).toEqual(['0.5.40']);
  });
});
