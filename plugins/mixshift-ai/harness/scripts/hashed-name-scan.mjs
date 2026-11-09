// hashed-name-scan.mjs — matcher behind check-no-internal-exposure rule 6.
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
  const maxLen = Math.max(...byLength.keys());

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
    for (let n = 0; n < MAX_WINDOW && start + n < tokens.length; n++) {
      joined += tokens[start + n];
      if (joined.length > maxLen) break;
      const bucket = byLength.get(joined.length);
      if (!bucket) continue;
      const entry = bucket.get(digest(joined));
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
