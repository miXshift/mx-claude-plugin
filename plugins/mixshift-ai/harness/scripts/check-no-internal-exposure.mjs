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
console.log('✓ check-no-internal-exposure: no maintainer skills or internal docs tracked');
