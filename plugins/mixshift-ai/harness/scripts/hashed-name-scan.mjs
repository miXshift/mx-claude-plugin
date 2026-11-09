// hashed-name-scan.mjs — matcher behind check-no-internal-exposure rules 5 and 6.
//
// Rule 6 uses findHashedNames() with the in-repo digest list below. Rule 5 uses
// findListedNames() with the PRIVATE plain-name list from the EXPOSURE_DENYLIST
// secret (parseDenylist() reads it). Both share one tokenizer and one window
// matcher, so a name matches the same spellings under either rule.
//
// This repo is PUBLIC. When a customer or brand name has leaked into it once,
// the guard that keeps it out must not republish it, so the list below holds
// only a salted SHA-256 digest of each name (plus its normalized length, which
// lets the scan hash a small fraction of candidate windows instead of all of
// them). The plain name never lives here, in a test, or in a commit message.
//
// Matching. Text is split into ASCII alphanumeric tokens, also at camelCase
// boundaries, and lowercased. Every run of 1..MAX_WINDOW consecutive tokens
// whose joined length equals an entry's length is hashed and compared. Tokens
// may span lines, so a name wrapped across a markdown line break still matches.
// One entry therefore catches the spaced, hyphenated, underscored, dotted,
// camelCase, ALL-CAPS and run-together spellings of a multi-word name.
//
// Residual gaps, on purpose:
//   - A name glued inside a longer token ("<name>store") is not seen.
//   - Short codes and initials are NOT listed: a 3-letter token occurs by
//     chance in base64 (dist/ ships certificate bundles and a sourcemap), so
//     it would fail CI at random. List only names long enough to be specific.
//
// Adding a name (prints the entry; paste it, never the name, into
// HASHED_NAMES; keep the shell history in mind):
//   node -e "import('./scripts/hashed-name-scan.mjs').then(m => console.log(m.nameEntry(process.argv[1])))" "<name>"

import { createHash } from 'node:crypto';

const SALT = 'mixshift-public-repo-name-guard:v1:';
export const MAX_WINDOW = 4;

export const HASHED_NAMES = [
  // 2026-11-09: brand-context schema SellerName example (removed in the same change).
  { length: 13, sha256: '36c95c9a660dcdb340752341df9b12f9956ba0efcefc07f96a468a793062a660' },
  // 2026-11-09: harness code-comment examples (removed in the same change).
  { length: 9, sha256: '036502a46931b90b6940b98ef8a1a55c71148deda20ce2cfb773703298a1e0a8' },
  { length: 11, sha256: '2553ae730a56adedb8aceb75a2344f2a07bbd4649963d2dc8c09f154ae54bd2f' },
];

const digest = (joined) => createHash('sha256').update(SALT + joined).digest('hex');

/** Lowercased ASCII alphanumeric tokens, split at camelCase boundaries too. */
export function tokenize(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The HASHED_NAMES entry for a name. */
export function nameEntry(name) {
  const joined = tokenize(name).join('');
  return { length: joined.length, sha256: digest(joined) };
}

/**
 * Shared window matcher. `lookup(joined)` returns a 1-based entry number or
 * undefined; it is only called for windows whose length is in `lengths`.
 */
function scanWindows(text, lengths, maxWindow, lookup) {
  if (lengths.size === 0) return [];
  const maxLen = Math.max(...lengths);

  const tokens = [];
  const lineOf = [];
  text.split('\n').forEach((lineText, i) => {
    for (const t of tokenize(lineText)) {
      tokens.push(t);
      lineOf.push(i + 1);
    }
  });

  const hits = [];
  const seen = new Set();
  for (let start = 0; start < tokens.length; start++) {
    let joined = '';
    for (let n = 0; n < maxWindow && start + n < tokens.length; n++) {
      joined += tokens[start + n];
      if (joined.length > maxLen) break;
      if (!lengths.has(joined.length)) continue;
      const entry = lookup(joined);
      if (entry === undefined) continue;
      const key = `${entry}:${lineOf[start]}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ entry, line: lineOf[start] });
      }
    }
  }
  return hits;
}

/**
 * Every match of an entry in `text`, as { entry: <1-based index>, line: <1-based> }.
 * At most one result per entry per line.
 */
export function findHashedNames(text, entries = HASHED_NAMES) {
  if (entries.length === 0) return [];
  const byLength = new Map();
  entries.forEach((e, i) => {
    if (!byLength.has(e.length)) byLength.set(e.length, new Map());
    byLength.get(e.length).set(e.sha256, i + 1);
  });
  return scanWindows(text, new Set(byLength.keys()), MAX_WINDOW, (joined) =>
    byLength.get(joined.length).get(digest(joined)),
  );
}

// ---------------------------------------------------------------------------
// Rule 5: the PRIVATE plain-name denylist (EXPOSURE_DENYLIST secret).
//
// Format: names separated by newlines and/or commas; surrounding whitespace is
// trimmed; blank entries and lines starting with `#` are ignored. Write each
// name the way it is usually spelled ("Acme Outdoor Gear"): matching goes
// through tokenize(), so one entry also catches the hyphenated, underscored,
// camelCase, ALL-CAPS and run-together spellings, same as rule 6.
//
// Entries shorter than MIN_LISTED_LENGTH letters/digits after normalization
// (initials, 2-3 letter codes) are skipped with a warning: they match random
// base64 in dist/ and would fail CI at random. 4- and 5-character names can
// also collide with ordinary text now and then; a hit always names the file,
// line and entry number, so a false positive is loud and easy to trace.
// ---------------------------------------------------------------------------

export const MIN_LISTED_LENGTH = 4;

/** Split a raw denylist (env value and/or file body) into names. */
export function parseDenylist(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .flatMap((line) => line.split(','))
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Compile names for findListedNames. `entry` numbers are 1-based positions in
 * `names`, so a report can point at an entry without printing it. Returns the
 * usable entries and the 1-based numbers of the ones skipped as too short.
 */
export function compileListedNames(names) {
  const entries = [];
  const skipped = [];
  names.forEach((name, i) => {
    const tokens = tokenize(name);
    const joined = tokens.join('');
    if (joined.length < MIN_LISTED_LENGTH) skipped.push(i + 1);
    else entries.push({ entry: i + 1, joined, tokens: tokens.length });
  });
  return { entries, skipped };
}

/**
 * Every match of a compiled entry in `text`, as { entry, line } (1-based), at
 * most one result per entry per line. Same spellings as findHashedNames.
 */
export function findListedNames(text, compiled) {
  if (compiled.length === 0) return [];
  const byJoined = new Map();
  for (const e of compiled) if (!byJoined.has(e.joined)) byJoined.set(e.joined, e.entry);
  const lengths = new Set(compiled.map((e) => e.joined.length));
  // A name written with more words than MAX_WINDOW still needs a window that
  // spans all of them; +2 leaves room for split acronyms ("A.B.C. Brand").
  const maxWindow = Math.max(MAX_WINDOW, ...compiled.map((e) => e.tokens + 2));
  return scanWindows(text, lengths, maxWindow, (joined) => byJoined.get(joined));
}

const BUNDLE_DIR = 'plugins/mixshift-ai/harness/dist/';
const THIRD_PARTY = /(^|[\\/])node_modules[\\/]/;

/**
 * Rule 5 hits for one tracked file, as { where, entry }. Plain files are
 * scanned whole. The built bundle is treated differently, because random
 * base64 and minified identifiers in it collide with short names (measured on
 * 0.8.21: a 6-letter name matched inside an embedded WASM blob):
 *   - dist/*.js (the minified bundle) is skipped. Its authored content (string
 *     literals, and comments esbuild strips) comes from our own sources, which
 *     are scanned in src/ AND in the sourcemap below, so a stale bundle still
 *     shows up through its map, which is always built with it.
 *   - a *.map is parsed, and only our own sources' sourcesContent is scanned
 *     (third-party node_modules sources, `mappings` and `names` are skipped).
 *     That is where a name scrubbed from src but not rebuilt still ships.
 */
export function listedNameHitsInFile(rel, text, compiled) {
  if (compiled.length === 0) return [];
  if (rel.startsWith(BUNDLE_DIR) && rel.endsWith('.js')) return [];
  if (rel.endsWith('.map')) {
    let map;
    try {
      map = JSON.parse(text);
    } catch {
      map = null; // not a JSON sourcemap: scan it as plain text below
    }
    if (map && Array.isArray(map.sources)) {
      const hits = [];
      map.sources.forEach((src, i) => {
        const content = map.sourcesContent?.[i];
        if (typeof src !== 'string' || THIRD_PARTY.test(src) || typeof content !== 'string') return;
        for (const h of findListedNames(content, compiled)) {
          hits.push({ where: `${rel} (${src}:${h.line})`, entry: h.entry });
        }
      });
      return hits;
    }
  }
  return findListedNames(text, compiled).map((h) => ({ where: `${rel}:${h.line}`, entry: h.entry }));
}
