#!/usr/bin/env node
// collect-changelog.mjs — fold changelog.d/ fragments into CHANGELOG.md.
//
// WHY THIS EXISTS
// Every PR in a release used to edit the same `## X.Y.Z` section of
// CHANGELOG.md, so every merge conflicted every other open PR in the cut.
// Measured 2026-09-10: four PRs in one cut produced six pairwise conflicts, and
// it is quadratic (n(n-1)/2). One fragment file per change means two PRs never
// touch the same file.
//
// TWO MODES
//   --check              validate fragment names + contents, write nothing.
//                        Wired into per-PR CI. Does NOT require a fragment to
//                        exist: a docs-only or internal PR legitimately has none.
//   --version X.Y.Z      fold fragments into that heading and DELETE them.
//                        Run once, at the release cut, by release-sweep.
//
// Add --dry-run to --version to print the result without touching anything.
//
// The category is carried in the FILENAME (`fixed-sqp-poll.md`) rather than in
// frontmatter, because a filename cannot drift from its content and needs no
// parser. README.md is not a fragment and is skipped everywhere.

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FRAGMENT_DIR = join(REPO_ROOT, 'changelog.d');
const CHANGELOG = join(REPO_ROOT, 'CHANGELOG.md');

// Order is the order they render in a release section.
const CATEGORIES = ['added', 'changed', 'fixed'];
const HEADING = { added: 'Added', changed: 'Changed', fixed: 'Fixed' };

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const dryRun = args.includes('--dry-run');
const versionIdx = args.indexOf('--version');
const version = versionIdx >= 0 ? args[versionIdx + 1] : undefined;

if (!checkOnly && !version) {
  console.error('collect-changelog: pass --check, or --version X.Y.Z to fold fragments.');
  process.exit(2);
}
if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`collect-changelog: --version must look like 1.2.3, got "${version}".`);
  process.exit(2);
}

/** Read every fragment, newest-irrelevant (sorted by name for determinism). */
async function loadFragments() {
  let names;
  try {
    names = await readdir(FRAGMENT_DIR);
  } catch {
    return []; // no directory yet is not an error
  }

  const problems = [];
  const fragments = [];

  for (const name of names.sort()) {
    if (name === 'README.md' || !name.endsWith('.md')) continue;

    const category = name.split('-')[0]?.toLowerCase();
    if (!CATEGORIES.includes(category)) {
      problems.push(
        `${name}: filename must start with a category (${CATEGORIES.join(', ')}), ` +
          `e.g. "fixed-${name.replace(/\.md$/, '')}.md".`,
      );
      continue;
    }

    const body = (await readFile(join(FRAGMENT_DIR, name), 'utf8')).trim();
    if (!body) {
      problems.push(`${name}: is empty. Delete it, or write the bullet.`);
      continue;
    }
    if (!body.startsWith('- ')) {
      problems.push(`${name}: must start with "- " so it renders as a bullet.`);
      continue;
    }

    fragments.push({ name, category, body });
  }

  if (problems.length > 0) {
    console.error('collect-changelog: fragment problems:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  return fragments;
}

const fragments = await loadFragments();

if (checkOnly) {
  console.log(
    fragments.length === 0
      ? 'collect-changelog: no fragments, nothing to validate (fine — not every PR ships one).'
      : `collect-changelog: ${fragments.length} fragment(s) valid.`,
  );
  process.exit(0);
}

if (fragments.length === 0) {
  console.error(
    `collect-changelog: no fragments to fold into ${version}. ` +
      'If that is intentional (a re-cut, say), nothing to do; otherwise the PRs in this cut did not add any.',
  );
  process.exit(1);
}

const md = await readFile(CHANGELOG, 'utf8');

// Find the target version's section and the start of the next `## ` heading.
const headingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm');
const headingMatch = headingRe.exec(md);
if (!headingMatch) {
  console.error(
    `collect-changelog: no "## ${version}" heading in CHANGELOG.md. ` +
      'The release cut writes the heading before collecting fragments.',
  );
  process.exit(1);
}

const sectionStart = headingMatch.index + headingMatch[0].length;
const nextHeading = /^## /m.exec(md.slice(sectionStart));
const sectionEnd = nextHeading ? sectionStart + nextHeading.index : md.length;
const section = md.slice(sectionStart, sectionEnd);

// Merge into whatever subsections the section already has, so a fragment run
// is idempotent against hand-written bullets that were already there.
let rebuilt = section;
for (const category of CATEGORIES) {
  const mine = fragments.filter((f) => f.category === category);
  if (mine.length === 0) continue;

  const bullets = mine.map((f) => f.body).join('\n\n');
  const subRe = new RegExp(`^### ${HEADING[category]}\\s*$`, 'm');
  const sub = subRe.exec(rebuilt);

  if (sub) {
    // Append to the existing subsection, after its heading.
    const at = sub.index + sub[0].length;
    rebuilt = rebuilt.slice(0, at) + '\n\n' + bullets + '\n' + rebuilt.slice(at);
  } else {
    // New subsection, appended at the end of the version section.
    rebuilt = rebuilt.replace(/\s*$/, '\n\n') + `### ${HEADING[category]}\n\n${bullets}\n`;
  }
}

// Exactly one blank line before whatever heading follows, so appending a new
// subsection at the end of a section does not butt against the next `## `.
rebuilt = rebuilt.replace(/\s*$/, '\n\n');

const out = md.slice(0, sectionStart) + rebuilt + md.slice(sectionEnd);

if (dryRun) {
  console.log(out.slice(0, sectionStart + rebuilt.length));
  console.log(`\n--- dry run: ${fragments.length} fragment(s) would fold into ${version}, none deleted ---`);
  process.exit(0);
}

await writeFile(CHANGELOG, out, 'utf8');
for (const f of fragments) await unlink(join(FRAGMENT_DIR, f.name));

const byCat = CATEGORIES.map((c) => {
  const n = fragments.filter((f) => f.category === c).length;
  return n ? `${n} ${HEADING[c].toLowerCase()}` : null;
})
  .filter(Boolean)
  .join(', ');

console.log(`collect-changelog: folded ${fragments.length} fragment(s) into ${version} (${byCat}) and removed them.`);
