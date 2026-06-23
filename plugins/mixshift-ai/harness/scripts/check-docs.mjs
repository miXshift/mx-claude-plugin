#!/usr/bin/env node
/**
 * check-docs.mjs
 *
 * Doc-currency gate. Customer-facing docs drift behind the shipped skill set and
 * the version fields every release; this catches the mechanical cases
 * deterministically so they fail CI instead of shipping stale (the 0.5.39 README
 * still said "20 skills" and omitted the whole Amazon API surface). Three checks:
 *
 *   1. README.md "ships **N** skills" == the number of skill directories.
 *   2. Every skill directory name appears somewhere in README.md, so a new skill
 *      cannot ship undocumented. A *removed* skill surfaces via check (1): the
 *      README still lists it, but N no longer matches the directory count.
 *   3. plugin.json `version` == marketplace.json `plugins[].version`. CONTRIBUTING.md
 *      requires these to move together; check-version-consistency.mjs only covers
 *      per-skill SKILL.md <-> manifest drift, not these two top-level fields.
 *
 * Companion to check-skill-telemetry.mjs / check-version-consistency.mjs; shares
 * their conventions (skip `_`-prefixed dirs, exit-1-with-report). Prose accuracy
 * (capability sections, FAQ answers) is not machine-checkable here — that is the
 * job of the release-docs maintainer skill and the CONTRIBUTING release step.
 *
 * Exit 0 on clean pass; exit 1 with a per-issue report. CI-gating; safe locally.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const skillsDir = join(here, '..', '..', 'skills');
const readmePath = join(repoRoot, 'README.md');
const pluginJsonPath = join(repoRoot, 'plugins', 'mixshift-ai', '.claude-plugin', 'plugin.json');
const marketplaceJsonPath = join(repoRoot, '.claude-plugin', 'marketplace.json');

async function listSkillDirs() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'));
}

const errors = [];

const skillIds = await listSkillDirs();

let readme = '';
try {
  readme = await readFile(readmePath, 'utf-8');
} catch (err) {
  errors.push(`Cannot read README.md (${err instanceof Error ? err.message : String(err)})`);
}

// 1. Skill count claimed in README matches the directory count.
if (readme) {
  const m = readme.match(/ships\s+\*\*(\d+)\s+skills\*\*/i);
  if (!m) {
    errors.push(
      'Could not find the "ships **N** skills" marker in README.md. If the wording ' +
        'changed, update this regex in check-docs.mjs and the README together.',
    );
  } else if (parseInt(m[1], 10) !== skillIds.length) {
    errors.push(
      `README.md says "ships **${m[1]} skills**" but there are ${skillIds.length} skill ` +
        `directories. Update the count and the skills table.`,
    );
  }
}

// 2. Every shipped skill is mentioned in README (catches undocumented additions).
if (readme) {
  const missing = skillIds.filter((id) => !readme.includes(id));
  if (missing.length) {
    errors.push(
      'These skills are not mentioned anywhere in README.md (add them to the skills ' +
        `table):\n${missing.map((id) => `      - ${id}`).join('\n')}`,
    );
  }
}

// 3. plugin.json and marketplace.json version fields agree.
try {
  const plugin = await readJson(pluginJsonPath);
  const marketplace = await readJson(marketplaceJsonPath);
  const pluginVersion = plugin.version;
  const entry =
    (marketplace.plugins ?? []).find((p) => p.name === plugin.name) ?? marketplace.plugins?.[0];
  const marketplaceVersion = entry?.version;
  if (pluginVersion == null || marketplaceVersion == null) {
    errors.push(
      `Could not read both version fields (plugin.json=${pluginVersion}, ` +
        `marketplace.json=${marketplaceVersion}).`,
    );
  } else if (pluginVersion !== marketplaceVersion) {
    errors.push(
      `Version drift: plugin.json = "${pluginVersion}" but marketplace.json = ` +
        `"${marketplaceVersion}". CONTRIBUTING.md requires these to move together.`,
    );
  }
} catch (err) {
  errors.push(
    `Cannot read/parse plugin.json or marketplace.json (${err instanceof Error ? err.message : String(err)})`,
  );
}

if (errors.length === 0) {
  console.log(
    `✓ Docs are current: README lists all ${skillIds.length} skills, version fields agree.`,
  );
  process.exit(0);
}

console.error(`✗ check-docs found ${errors.length} issue(s):\n`);
for (const e of errors) console.error(`  - ${e}`);
console.error('\nFix the docs (README skills table + count, version sync) and re-run `npm run check-docs`.');
process.exit(1);
