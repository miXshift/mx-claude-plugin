#!/usr/bin/env node
// check-no-internal-exposure.mjs — per-push CI gate (also run at release).
//
// The mx-claude-plugin repo is PUBLIC. Only skills packaged under
// plugins/mixshift-ai/skills/ are meant to be public; maintainer / internal
// material (release-docs, release-sweep and the ops skills, the internal
// SKILL-AUTHOR-GUIDE + productization docs, local .claude config) must NEVER be
// tracked here. This is a backstop against a re-add re-introducing the leak that
// shipped release-docs + SKILL-AUTHOR-GUIDE publicly (cleaned up 2026-07-24).
//
// Three tree rules + one log rule:
//   1. Nothing tracked under .claude/ — the whole dir is gitignored + internal
//      (maintainer skills, agents, commands, hooks, settings.local.json).
//   2. Known internal-material paths OUTSIDE .claude/ that are only path-ignored,
//      so a plain `git add` (no -f) could silently re-track them. SKILL-AUTHOR-
//      GUIDE.md is the concrete case: it previously lived (tracked) at
//      docs/productization/ before being relocated to internal/.
//   3. CONTENT deny-scan: no tracked text file may REFERENCE an internal design
//      doc (an `internal/<DOC>.md` path, or a known internal-doc basename).
//      Rules 1-2 only look at WHICH paths are tracked, never at file content,
//      so source comments citing internal docs sailed through every prior run.
//      This is a DENY-pattern by design: an allowlist of "known clean" paths
//      would go green the moment a new path class appeared (the 2026-07-31
//      supabase/ incident), whereas a deny-pattern fails on the content itself
//      wherever it shows up. dist/ IS scanned: dist/cli.js + cli.js.map are
//      tracked and shipped, and bundled comments/sourcesContent carry source
//      comments verbatim, so a reference scrubbed from src but not rebuilt
//      would still ship.
//   4. Commit messages on the branch must not carry non-MixShift emails.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// Internal-material paths outside .claude/ that must never be tracked in the
// public repo. Kept in sync with the .gitignore `docs/productization/` block.
const INTERNAL_PATHS = [
  'docs/productization/SKILL-AUTHOR-GUIDE.md',
  'docs/productization/BRAND-MANAGEMENT.md',
  'docs/productization/HARNESS-REWRITE.md',
  'docs/productization/MIGRATION-NOTES.md',
];

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z', '--', '.claude/', ...INTERNAL_PATHS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
} catch (err) {
  // No git context (e.g. an extracted tarball). This is a git-tracking rule, so
  // there is nothing to check — pass rather than error.
  console.log(`✓ check-no-internal-exposure: no git context (${err?.code || 'skipped'}), nothing to check`);
  process.exit(0);
}

const offenders = tracked.split('\0').filter(Boolean);
if (offenders.length) {
  console.error(
    `check-no-internal-exposure: internal/maintainer material is TRACKED in the PUBLIC repo:\n` +
    offenders.map(o => `  ${o}`).join('\n') +
    `\nMaintainer skills belong in ~/.claude/skills; internal docs in internal/. Neither goes here.\n` +
    `Untrack: git rm -r --cached <path>. Only plugins/mixshift-ai/skills/ is public. See CONTRIBUTING.md.`,
  );
  process.exit(1);
}

// 3. CONTENT deny-scan over every tracked file (including dist/, see header).
//    Two pattern classes:
//      a. Any `internal/<UPPERCASE-DOC>.md` path reference. internal/ is the
//         gitignored home of MixShift design docs; naming one in a public file
//         both leaks the doc's existence and invites the next edit to quote it.
//      b. Known internal design-doc basenames, with or without the internal/
//         prefix (comments sometimes cite the bare filename).
//    The scan skips binary files (NUL sniff) and this script itself (the deny
//    list below would match its own source; the script is the enforcement
//    point, not an exposure).
const CONTENT_DENY = [
  {
    label: 'internal design-doc path reference',
    re: /\binternal\/[A-Z][A-Z0-9_-]*\.md\b/,
  },
  {
    label: 'internal design-doc basename reference',
    re: /\b(?:SUPABASE-SETUP|BACKGROUND-DISCOVERY|BRAND-BRAIN-STRATEGY|BRAND-BRAIN|SP-MIGRATION|TELEMETRY-ATTRIBUTION|SECRETS)\.md\b/,
  },
];
const SELF = 'plugins/mixshift-ai/harness/scripts/check-no-internal-exposure.mjs';

try {
  const { readFileSync } = await import('node:fs');
  const allTracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  const contentHits = [];
  for (const rel of allTracked) {
    if (rel === SELF) continue;
    let buf;
    try {
      buf = readFileSync(join(REPO_ROOT, rel));
    } catch {
      continue; // deleted-but-staged edge; tree rules already cover tracking
    }
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    const text = buf.toString('utf8');
    if (!CONTENT_DENY.some((p) => p.re.test(text))) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of CONTENT_DENY) {
        const m = p.re.exec(lines[i]);
        if (m) {
          contentHits.push(`  ${rel}:${i + 1}: ${p.label} (${m[0]})`);
          break; // one report per line is enough
        }
      }
    }
  }
  if (contentHits.length) {
    console.error(
      `check-no-internal-exposure: ${contentHits.length} internal design-doc reference(s) in tracked files of the PUBLIC repo:\n` +
      contentHits.join('\n') +
      `\nRewrite the comment to describe what the code does locally; deep rationale belongs INSIDE the\n` +
      `internal doc (gitignored), not cited from public source. If a hit is in dist/, rebuild from the\n` +
      `harness directory after scrubbing src. See CONTRIBUTING.md.`,
    );
    process.exit(1);
  }
} catch (err) {
  // No git context (extracted tarball): tree scan impossible, same stance as
  // rule 1-2 above.
  console.log(`✓ check-no-internal-exposure: content scan skipped (${err?.code || 'no git context'})`);
}

// 4. COMMIT MESSAGES on the branch must not carry email addresses. This repo
//    is public and squash-merge writes the full commit body into main's
//    permanent history; a reporter's email in an `originator:` trailer is
//    customer PII that no content gate sees (git ls-files scans the tree,
//    never the log). Originator tags belong in the INTERNAL feedback backlog
//    (FEEDBACK-OPS §7), not in commit messages. Pattern-based on purpose: a
//    list of customer names/domains would itself be exposure if kept here.
//    Scans origin/main..HEAD (empty range on main itself = no-op).
const EMAIL_ALLOWLIST = /@(mixshift\.io|example\.com|anthropic\.com|users\.noreply\.github\.com)\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
try {
  const log = execFileSync('git', ['log', 'origin/main..HEAD', '--format=%H%x00%B%x01'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const bad = [];
  for (const entry of log.split('\x01').filter(Boolean)) {
    const [sha, body = ''] = entry.split('\0');
    for (const m of body.match(EMAIL_RE) ?? []) {
      if (!EMAIL_ALLOWLIST.test(m)) bad.push(`  ${sha.slice(0, 9).trim()}: ${m}`);
    }
  }
  if (bad.length) {
    console.error(
      `check-no-internal-exposure: commit message(s) on this branch contain email addresses.\n` +
      `This repo is PUBLIC and squash-merge writes commit bodies into main permanently.\n` +
      bad.join('\n') +
      `\nMove originator/reporter identity to the internal feedback backlog and reword the commit\n` +
      `(git commit --amend / rebase -i), then force-push the branch.`,
    );
    process.exit(1);
  }
} catch {
  // origin/main unavailable (shallow clone without the ref, detached tarball).
  // The tree rules above already ran; skip the log rule rather than fail.
  console.log('✓ check-no-internal-exposure: commit-message scan skipped (origin/main not resolvable)');
}
console.log('✓ check-no-internal-exposure: no internal paths tracked, no internal design-doc references in tracked content, no emails in branch commit messages');
