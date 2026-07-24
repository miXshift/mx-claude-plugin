#!/usr/bin/env node
/**
 * check-skill-telemetry.mjs
 *
 * Scans every `plugins/mixshift-ai/skills/<id>/SKILL.md` and enforces
 * the canonical telemetry convention documented in the maintainer
 * skill-author guide.
 *
 * Required in every SKILL.md:
 *   1. `mixshift telemetry emit skill.invoked --skill <id>` with the
 *      <id> matching the parent directory name.
 *   2. `mixshift telemetry emit skill.completed --skill <id> --outcome`
 *      (any outcome value).
 *   3. A "Telemetry (required" heading anchor so the section is
 *      discoverable on visual scan.
 *
 * Files starting with `_` (e.g. `_AUTHOR-GUIDE.md`) are skipped — they
 * are documentation, not skills.
 *
 * Exits 0 on clean pass. Exits 1 with a per-skill list of failures
 * otherwise. Designed for CI gating; safe to run locally.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(here, '..', '..', 'skills');

/** @typedef {{ skillId: string, path: string, errors: string[] }} SkillCheck */

async function listSkillDirs() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

/** @param {string} skillId */
async function checkSkill(skillId) {
  /** @type {SkillCheck} */
  const result = { skillId, path: join(skillsDir, skillId, 'SKILL.md'), errors: [] };

  let raw;
  try {
    raw = await readFile(result.path, 'utf-8');
  } catch (err) {
    result.errors.push(
      `Cannot read SKILL.md (${err instanceof Error ? err.message : String(err)})`,
    );
    return result;
  }

  // 1. Standard heading
  if (!/##\s*Telemetry\s*\(required/i.test(raw)) {
    result.errors.push(
      'Missing "## Telemetry (required ..." heading. See the skill-author guide for the canonical block.',
    );
  }

  // 2. skill.invoked emit with matching skill-id
  const invokedRegex = new RegExp(
    `mixshift\\s+telemetry\\s+emit\\s+skill\\.invoked\\s+--skill\\s+${escapeRegex(skillId)}\\b`,
  );
  if (!invokedRegex.test(raw)) {
    result.errors.push(
      `Missing or mismatched 'mixshift telemetry emit skill.invoked --skill ${skillId}'. The --skill value MUST match the directory name.`,
    );
  }

  // 3. skill.completed emit with matching skill-id + --outcome
  const completedRegex = new RegExp(
    `mixshift\\s+telemetry\\s+emit\\s+skill\\.completed\\s+--skill\\s+${escapeRegex(skillId)}\\b[\\s\\S]{0,200}?--outcome`,
  );
  if (!completedRegex.test(raw)) {
    result.errors.push(
      `Missing 'mixshift telemetry emit skill.completed --skill ${skillId} ... --outcome <value>'. Outcome must be one of ok|failed|deferred|skipped.`,
    );
  }

  // 4. CLI-resolution fallback: every skill must carry the executable resolver
  //    for the CLI, because in Cowork the session hook never runs, so `mixshift`
  //    is off PATH and `$MIXSHIFT_CLI` is unset — the only thing that locates
  //    the bundled CLI is a filesystem scan. A prose "derive from the plugin
  //    root" instruction is not enough (the model does not follow it; it
  //    concludes "not installed" instead). Require the scan one-liner's
  //    signature so no skill can ship a dead fallback ladder again.
  //    (Guidance-only skills still call the CLI, so this applies to all.)
  if (!raw.includes("-path '*/harness/dist/cli.js'")) {
    result.errors.push(
      "Missing the executable CLI resolver. Every SKILL.md must include the scan " +
        "`find / -maxdepth 9 -type f -path '*/harness/dist/cli.js' 2>/dev/null | head -1` " +
        'in its CLI-invocation guidance so the CLI is locatable in Cowork (no PATH hook, ' +
        'no $MIXSHIFT_CLI). See the skill-author guide.',
    );
  }

  // 5. (optional sanity) trigger_phrase_matched mentioned at least conditionally
  // Not required — many skills are explicit /<command> triggers only — so just warn.
  if (
    !raw.includes('skill.trigger_phrase_matched') &&
    /trigger_phrases:/i.test(raw)
  ) {
    result.errors.push(
      'SKILL.md declares trigger_phrases but never emits skill.trigger_phrase_matched. Either remove the natural-language triggers from frontmatter, or add the conditional emit (see the skill-author guide).',
    );
  }

  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const skillIds = await listSkillDirs();
const checks = await Promise.all(skillIds.map(checkSkill));

const failures = checks.filter((c) => c.errors.length > 0);
const repoRoot = join(here, '..', '..', '..', '..');

if (failures.length === 0) {
  console.log(`✓ All ${checks.length} SKILL.md files pass the telemetry convention.`);
  process.exit(0);
}

console.error(`✗ ${failures.length}/${checks.length} SKILL.md files fail the telemetry convention:\n`);
for (const f of failures) {
  console.error(`  ${f.skillId}  (${relative(repoRoot, f.path)})`);
  for (const e of f.errors) {
    console.error(`    - ${e}`);
  }
  console.error('');
}
console.error(
  'Fix by copying the canonical block from the skill-author guide and substituting the skill-id.',
);
process.exit(1);
