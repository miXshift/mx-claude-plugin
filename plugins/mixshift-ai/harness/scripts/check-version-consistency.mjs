#!/usr/bin/env node
/**
 * check-version-consistency.mjs
 *
 * Skill version-drift linter.
 *
 * The `version` in each skill's skill.manifest.yaml is the CANONICAL version
 * (per the mx-asin-target-negation changelog: "Frontmatter version realigned
 * with the manifest"). validate-manifests.mjs already proves the manifest
 * parses; this check proves every OTHER place a skill states its version
 * agrees with the manifest:
 *   - SKILL.md frontmatter top-level `version:`        (Style B/C skills)
 *   - SKILL.md frontmatter `metadata.version:`         (Style A skills)
 *   - SKILL.md body sidecar emit `"skill_version": "X"`
 *   - SKILL.md footer `*Skill version: X ...*`
 *
 * Versions compare on a numeric tuple normalized to 3 parts, so a footer
 * shorthand like `1.1` matches a manifest `1.1.0`, but a stale `1.1` against
 * a manifest `1.2.0` is correctly flagged.
 *
 * A skill whose SKILL.md matches NONE of those four patterns is itself an
 * error. Otherwise the per-source comparison loop never executes and the skill
 * silently opts out of the gate: it passes no matter what its manifest says.
 * That is not hypothetical — `mx-brand-context` sat in exactly that hole until
 * 2026-07-28, because its footer read "Current version:" rather than the
 * "Skill version:" the four skills with footers use. Rather than teach the
 * regex a second phrasing (which would leave two footer dialects in the tree
 * forever), the footer was normalized and this zero-source check added so the
 * next format outlier fails loudly instead of passing vacuously.
 *
 * Exit 0 on clean pass; exit 1 with a per-skill drift report otherwise.
 * Wired into CI as a BLOCKING step (`npm run check-versions` in ci.yml).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', '..', 'skills');
const repoRoot = join(here, '..', '..', '..', '..');

async function listSkillDirs() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

/** Normalize a version-ish string to a comparable 3-part numeric key, or null. */
function normVersion(raw) {
  if (raw == null) return null;
  const m = String(raw).trim().match(/^v?(\d+(?:\.\d+)*)/);
  if (!m) return null;
  const parts = m[1].split('.').map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.');
}

function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    return parseYaml(m[1]) ?? {};
  } catch {
    return {};
  }
}

/** @param {string} skillId */
async function checkSkill(skillId) {
  const result = { skillId, canonical: null, errors: [] };
  const manifestPath = join(skillsDir, skillId, 'skill.manifest.yaml');
  const skillMdPath = join(skillsDir, skillId, 'SKILL.md');

  try {
    const manifest = parseYaml(await readFile(manifestPath, 'utf-8')) ?? {};
    result.canonical = manifest.version != null ? String(manifest.version) : null;
  } catch (err) {
    result.errors.push(
      `Cannot read/parse skill.manifest.yaml (${err instanceof Error ? err.message : String(err)})`,
    );
    return result;
  }
  if (result.canonical == null) {
    result.errors.push('skill.manifest.yaml has no `version` field (cannot anchor the consistency check)');
    return result;
  }
  const canonKey = normVersion(result.canonical);

  let raw;
  try {
    raw = await readFile(skillMdPath, 'utf-8');
  } catch (err) {
    result.errors.push(`Cannot read SKILL.md (${err instanceof Error ? err.message : String(err)})`);
    return result;
  }

  const fm = frontmatter(raw);
  const sources = [];
  if (fm.version != null) sources.push(['frontmatter version', String(fm.version)]);
  if (fm.metadata && fm.metadata.version != null)
    sources.push(['frontmatter metadata.version', String(fm.metadata.version)]);
  for (const m of raw.matchAll(/"skill_version"\s*:\s*"([^"]+)"/g))
    sources.push(['body "skill_version"', m[1]]);
  for (const m of raw.matchAll(/[Ss]kill version:?\s*(v?\d[0-9A-Za-z.-]*)/g))
    sources.push(['footer "Skill version"', m[1]]);

  // No recognized source => nothing below this line can ever fail, so the skill
  // would pass the gate vacuously. Fail instead: declaring a version somewhere
  // the linter reads is the price of being covered by it.
  if (sources.length === 0) {
    result.errors.push(
      'SKILL.md declares no version in any recognized place, so this skill is NOT actually ' +
        'covered by the gate. Add one of: frontmatter `version:`, frontmatter `metadata.version:`, ' +
        'a body `"skill_version": "X"`, or a footer `*Skill version: X ...*`.',
    );
    return result;
  }

  for (const [label, value] of sources) {
    if (normVersion(value) !== canonKey) {
      result.errors.push(`${label} = "${value}" but manifest = "${result.canonical}"`);
    }
  }
  return result;
}

const skillIds = await listSkillDirs();
const checks = await Promise.all(skillIds.map(checkSkill));
const failures = checks.filter((c) => c.errors.length > 0);

if (failures.length === 0) {
  console.log(`✓ All ${checks.length} skills are version-consistent (SKILL.md ↔ manifest).`);
  process.exit(0);
}

console.error(
  `✗ ${failures.length}/${checks.length} skills have version drift or no declared version ` +
    `(skill.manifest.yaml is canonical):\n`,
);
for (const f of failures) {
  console.error(`  ${f.skillId}  (manifest v${f.canonical ?? '?'})`);
  for (const e of f.errors) console.error(`    - ${e}`);
  console.error('');
}
console.error(
  'Fix: align every SKILL.md version string (frontmatter version / metadata.version,\n' +
    'body "skill_version", footer "Skill version") to the manifest version. A skill\n' +
    'reported as declaring no version needs one ADDED in one of those places — the\n' +
    'linter cannot check a version it cannot find.',
);
process.exit(1);
