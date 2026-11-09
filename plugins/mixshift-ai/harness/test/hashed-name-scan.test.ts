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
  findListedNames,
  listedNameHitsInFile,
  compileListedNames,
  parseDenylist,
  nameEntry,
  tokenize,
  HASHED_NAMES,
  MAX_WINDOW,
  MIN_LISTED_LENGTH,
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

// Rule 5's private plain-name list (EXPOSURE_DENYLIST). Synthetic names only.
describe('denylist (rule 5) parsing and matching', () => {
  it('parses newline- and comma-separated names, trimming and dropping blanks and # lines', () => {
    expect(parseDenylist('Acme Outdoor Gear, Zephyr Kitchenware\n\n# a comment, with a comma\n  Nimbus Pet Co  \r\nQuill,')).toEqual([
      'Acme Outdoor Gear',
      'Zephyr Kitchenware',
      'Nimbus Pet Co',
      'Quill',
    ]);
    expect(parseDenylist('')).toEqual([]);
    expect(parseDenylist(undefined)).toEqual([]);
    expect(parseDenylist(' , \n#only a comment\n')).toEqual([]);
  });

  it('numbers entries by their position in the list and skips ones too short to match reliably', () => {
    const { entries, skipped } = compileListedNames(['Acme Outdoor Gear', 'AB', 'Quill', 'X-Y-Z']);
    expect(entries.map((e) => e.entry)).toEqual([1, 3]);
    expect(skipped).toEqual([2, 4]);
    expect(MIN_LISTED_LENGTH).toBeGreaterThanOrEqual(4);
  });

  it('catches the same spellings as the hashed scan, with no hashing', () => {
    const { entries } = compileListedNames(['Zephyr Kitchenware', 'Acme Outdoor Gear']);
    for (const text of [
      'see ZEPHYR KITCHENWARE',
      'zephyr-kitchenware',
      'zephyr_kitchenware',
      'ZephyrKitchenware',
      'zephyrkitchenware.com',
      "Zephyr Kitchenware's Q3",
    ]) {
      expect(findListedNames(text, entries), text).toEqual([{ entry: 1, line: 1 }]);
    }
    expect(findListedNames('x\nAcme Outdoor\nGear', entries)).toEqual([{ entry: 2, line: 2 }]);
    expect(findListedNames('Zephyr Kitchens, Acme Outdoor', entries)).toEqual([]);
  });

  it('matches a whole token, not a substring of a longer word', () => {
    const { entries } = compileListedNames(['Quill']);
    expect(findListedNames('the quill pen', entries)).toEqual([{ entry: 1, line: 1 }]);
    expect(findListedNames('quills and tranquillity', entries)).toEqual([]);
  });

  it('spans names with more words than the hashed window', () => {
    const { entries } = compileListedNames(['North Ridge Coastal Supply Trading Co']);
    expect(findListedNames('ordered from north-ridge-coastal-supply-trading-co today', entries)).toEqual([
      { entry: 1, line: 1 },
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(findListedNames('anything at all', [])).toEqual([]);
  });

  describe('listedNameHitsInFile', () => {
    const { entries } = compileListedNames(['Zephyr Kitchenware']);
    const DIST = 'plugins/mixshift-ai/harness/dist/';

    it('scans a plain tracked file whole, reporting file:line', () => {
      expect(listedNameHitsInFile('docs/x.md', 'a\nsee Zephyr Kitchenware', entries)).toEqual([
        { where: 'docs/x.md:2', entry: 1 },
      ]);
      // Outside dist/, a .js file is ordinary source and is scanned.
      expect(listedNameHitsInFile('scripts/x.js', '// zephyr-kitchenware', entries)).toHaveLength(1);
    });

    it('skips the minified bundle (its authored text is covered via the sourcemap)', () => {
      expect(listedNameHitsInFile(`${DIST}cli.js`, 'var a="Zephyr Kitchenware";', entries)).toEqual([]);
    });

    it('scans only our own sources inside a sourcemap, naming the source and line', () => {
      const map = JSON.stringify({
        version: 3,
        sources: ['../src/a.ts', '../node_modules/lib/b.js', '../src/c.ts'],
        sourcesContent: ['x\n// Zephyr Kitchenware case', 'Zephyr Kitchenware in a dependency', 'clean'],
        mappings: 'ZephyrKitchenware',
        names: ['ZephyrKitchenware'],
      });
      expect(listedNameHitsInFile(`${DIST}cli.js.map`, map, entries)).toEqual([
        { where: `${DIST}cli.js.map (../src/a.ts:2)`, entry: 1 },
      ]);
    });

    it('falls back to a plain-text scan for a .map that is not JSON', () => {
      expect(listedNameHitsInFile('x.map', 'Zephyr Kitchenware', entries)).toEqual([{ where: 'x.map:1', entry: 1 }]);
    });
  });
});
