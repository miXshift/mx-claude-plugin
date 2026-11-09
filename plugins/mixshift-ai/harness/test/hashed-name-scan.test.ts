/**
 * Unit tests for scripts/hashed-name-scan.mjs, the matcher behind
 * check-no-internal-exposure rule 6. The real list holds digests of names that
 * must never appear in this PUBLIC repo, so every case here uses a synthetic
 * name and builds its entry with nameEntry(); the real names are not written
 * anywhere, including here.
 */
import { describe, it, expect } from 'vitest';
import {
  findHashedNames,
  nameEntry,
  tokenize,
  HASHED_NAMES,
  MAX_WINDOW,
} from '../scripts/hashed-name-scan.mjs';

const ENTRY = nameEntry('Acme Outdoor Gear');
const scan = (text: string) => findHashedNames(text, [ENTRY]);

describe('hashed-name-scan', () => {
  it('catches the common spellings of a multi-word name', () => {
    for (const text of [
      'e.g. "ACME OUTDOOR GEAR"',
      'Acme Outdoor Gear',
      'acme-outdoor-gear',
      'acme_outdoor_gear',
      'acme.outdoor.gear',
      'AcmeOutdoorGear',
      'acmeoutdoorgear',
      'AcmeOutdoor Gear',
      "Acme Outdoor Gear's lines",
      'AcmeOutdoorGearStore', // camelCase suffix splits into its own token
    ]) {
      expect(scan(text), text).toEqual([{ entry: 1, line: 1 }]);
    }
  });

  it('matches across a line break and reports the line the name starts on', () => {
    expect(scan('intro\nseen at Acme Outdoor\nGear last year')).toEqual([{ entry: 1, line: 2 }]);
  });

  it('reports each line once, and every line that has it', () => {
    expect(scan('Acme Outdoor Gear and acme-outdoor-gear\nnothing\nACME OUTDOOR GEAR')).toEqual([
      { entry: 1, line: 1 },
      { entry: 1, line: 3 },
    ]);
  });

  it('does not match partial names or a different word at a token boundary', () => {
    for (const text of ['Acme Outdoor', 'Outdoor Gear', 'Acme Outdoor Gears', 'Acme Indoor Gear', '']) {
      expect(scan(text), text).toEqual([]);
    }
  });

  it('documents the residual gap: a name glued inside one lowercase token is not seen', () => {
    expect(scan('acmeoutdoorgearstore')).toEqual([]);
  });

  it('nameEntry normalizes spelling, so every variant yields the same entry', () => {
    expect(nameEntry('ACME-OUTDOOR-GEAR')).toEqual(ENTRY);
    expect(nameEntry('AcmeOutdoorGear')).toEqual(ENTRY);
    expect(ENTRY.length).toBe('acmeoutdoorgear'.length);
  });

  it('tokenizes at camelCase and acronym boundaries', () => {
    expect(tokenize('ACMEOutdoorGear v2_beta')).toEqual(['acme', 'outdoor', 'gear', 'v2', 'beta']);
  });

  it('ships a well-formed list: real digests, names long enough not to collide with base64', () => {
    expect(HASHED_NAMES.length).toBeGreaterThan(0);
    for (const e of HASHED_NAMES) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      // Short codes and initials would match random base64 in dist/ and fail
      // CI at random (see the module header).
      expect(e.length).toBeGreaterThanOrEqual(8);
    }
    expect(MAX_WINDOW).toBeGreaterThanOrEqual(3);
  });
});
