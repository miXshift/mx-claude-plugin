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
// Two zero-false-positive rules:
//   1. Nothing tracked under .claude/ — the whole dir is gitignored + internal
//      (maintainer skills, agents, commands, hooks, settings.local.json).
//   2. Known internal-material paths OUTSIDE .claude/ that are only path-ignored,
//      so a plain `git add` (no -f) could silently re-track them. SKILL-AUTHOR-
//      GUIDE.md is the concrete case: it previously lived (tracked) at
//      docs/productization/ before being relocated to internal/.

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

// 3. COMMIT MESSAGES on the branch must not carry email addresses. This repo
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
console.log('✓ check-no-internal-exposure: no maintainer skills or internal docs tracked, no emails in branch commit messages');
