#!/usr/bin/env node
// check-changelog-marker.mjs — RELEASE-TIME gate (belt-and-suspenders).
//
// feat/update-banner adds an HTML-comment marker under the working version
// heading in CHANGELOG.md, e.g.:
//   ## 0.8.7
//   <!-- unreleased: version bump happens at release cut, not in feature PRs. ... -->
//
// The ROOT-CAUSE fix lives in the shared parser (lib/changelog.ts strips HTML
// comments), so `mixshift whatsnew` no longer renders the marker even while it
// sits in the live `main` CHANGELOG during a dev cycle. This gate is the second
// layer: it keeps the RAW committed CHANGELOG clean at release time, protecting
// the tagged /releases page and the release.published Discord announce (both
// read the file text). A stale marker shipped into 0.8.6 before either existed.
//
// Runs from the release workflow (on the version tag), NOT per-push CI: the
// marker is legitimately present under the top heading all through development.
//
// The pattern matches only the REAL marker shape — line-anchored, `<!--
// unreleased:` with the documented colon — so a backtick-quoted reference to the
// marker in changelog or doc prose (e.g. a bullet documenting this very gate)
// does NOT trip it.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');

let md;
try {
  md = await readFile(CHANGELOG, 'utf8');
} catch (err) {
  console.error(
    `check-changelog-marker: cannot read CHANGELOG.md at ${CHANGELOG} (${err?.code || err?.message || err}).`,
  );
  process.exit(1);
}

// Real marker only: line start (optionally indented) + `<!-- unreleased:`.
const marker = /^[ \t]*<!--\s*unreleased\s*:/im;
const m = marker.exec(md);
if (m) {
  const line = md.slice(0, m.index).split('\n').length;
  console.error(
    `check-changelog-marker: CHANGELOG.md:${line} still contains the "unreleased" maintainer marker.\n` +
    `Strip it at the release cut. It renders on the /releases page and in the Discord announce (the shipped\n` +
    `whatsnew parser strips comments, but the raw released file must be clean too).`,
  );
  process.exit(1);
}
console.log('✓ check-changelog-marker: no unreleased marker in CHANGELOG.md');
