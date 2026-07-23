#!/usr/bin/env node
/**
 * check-skill-contracts.mjs
 *
 * Static CONTRACT linter for skill manifests. `validate-manifests` proves each
 * skill.manifest.yaml matches the Zod schema; this proves the manifest's
 * cross-references actually resolve against the rest of the repo.
 *
 *   ERRORS (exit 1):
 *     - every `sql_ids` entry resolves to an id in shared/sql-library/catalog.yaml
 *     - every `pre_execution.batch_plan[].parallel` id is also in `sql_ids`
 *     - every `upstream_skills` entry is a real skills/<id> directory
 *     - every `required_context_fields` / `optional_context_fields` path has a
 *       top-level segment declared in the BrandContext schema
 *     - every `calibration.fields[].seed_from` (after the `context.` prefix) has
 *       a top-level segment declared in the BrandContext schema
 *     - SKILL.md references a known-unimplemented command (e.g. `sidecar compare`)
 *
 * Deep context-path resolution (does `management.acos_target_pct` resolve to a
 * real value?) is intentionally deferred to the Phase 1 golden-fixture vitest
 * suite, which checks paths against actual data. Here we validate only the
 * top-level segment, because several context fields (delivery, reporting,
 * objective_calibration, brand_terms, ...) are typed `z.unknown()` and have no
 * inspectable deep shape.
 *
 * Exit 0 clean; exit 1 on any ERROR.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const mixshiftRoot = join(here, '..', '..'); // plugins/mixshift-ai
const skillsDir = join(mixshiftRoot, 'skills');
const catalogPath = join(mixshiftRoot, 'shared', 'sql-library', 'catalog.yaml');
const repoRoot = join(here, '..', '..', '..', '..');

/**
 * Top-level keys declared in the BrandContext schema. MIRROR of
 * `harness/src/lib/context/schema.ts` (contextSchema) — keep in sync when the
 * schema gains or drops a top-level field. (Hardcoded rather than imported
 * because contextSchema is wrapped in `.refine()`, so its `.shape` is not
 * cleanly reachable from a plain-node script.)
 */
const CONTEXT_TOP_LEVEL = new Set([
  // required
  'schema_version', 'brand_slug', 'brand_name', 'last_updated', 'accounts',
  'sources', 'management',
  // optional
  'capture_rate_calibration', 'sub_brands', 'brand_terms', 'bid_health', 'goals',
  'active_watch', 'structural_events', 'objective_calibration', 'delivery',
  'open_gaps', 'posture', 'paused_campaigns', 'campaign_structure',
  'attribution_rule', 'negation', 'reporting', 'thresholds',
  'detected_anomalies', 'skill_config',
]);

/**
 * Brand-context dependencies that are NOT context.yaml top-level keys but are
 * legitimate cold-start artifacts a skill may require. `corpora` is the
 * cold-start `~/.mixshift/clients/<slug>/corpora/` directory (CSV lists such as
 * conq_asins.csv) consumed by the negation / harvest / relevance skills.
 * (Design note: manifests currently list these in the same
 * `required_context_fields` array as real context.yaml paths — tracked in the
 * QA backlog as a contract-clarity item, not a code bug.)
 */
const CONTEXT_ARTIFACT_DEPS = new Set(['corpora']);

/** SKILL.md references to commands that are documented but not implemented. */
const KNOWN_UNIMPLEMENTED_REFS = ['sidecar compare'];

/** Top-level segment of a dotted context path: `accounts[*].seller_id` -> `accounts`. */
function topSegment(path) {
  return String(path).split('.')[0].replace(/\[.*?\]/g, '').trim();
}

async function loadCatalogIds() {
  const cat = parseYaml(await readFile(catalogPath, 'utf-8'));
  return new Set((cat?.queries ?? []).map((q) => q.id));
}

async function listSkillDirs() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
}

const catalogIds = await loadCatalogIds();
const skillIds = await listSkillDirs();
const skillIdSet = new Set(skillIds);

const results = [];
for (const skillId of skillIds) {
  const errors = [];
  const manifestPath = join(skillsDir, skillId, 'skill.manifest.yaml');

  let m;
  try {
    m = parseYaml(await readFile(manifestPath, 'utf-8')) ?? {};
  } catch (err) {
    errors.push(`cannot read/parse skill.manifest.yaml (${err instanceof Error ? err.message : String(err)})`);
    results.push({ skillId, errors });
    continue;
  }

  const sqlIds = Array.isArray(m.sql_ids) ? m.sql_ids : [];
  const sqlIdSet = new Set(sqlIds);

  // 1. sql_ids resolve against the catalog
  for (const id of sqlIds) {
    if (!catalogIds.has(id)) errors.push(`sql_ids: "${id}" is not in catalog.yaml`);
  }

  // 2. batch_plan ids are a subset of sql_ids
  for (const r of m.pre_execution?.batch_plan ?? []) {
    for (const id of r.parallel ?? []) {
      if (!sqlIdSet.has(id))
        errors.push(`pre_execution.batch_plan round ${r.round}: "${id}" is not declared in sql_ids`);
    }
  }

  // 3. upstream_skills exist
  for (const up of m.upstream_skills ?? []) {
    if (!skillIdSet.has(up)) errors.push(`upstream_skills: "${up}" is not a skills/ directory`);
  }

  // 4. context field top-level segments are declared in the schema
  for (const f of [...(m.required_context_fields ?? []), ...(m.optional_context_fields ?? [])]) {
    const seg = topSegment(f);
    if (!CONTEXT_TOP_LEVEL.has(seg) && !CONTEXT_ARTIFACT_DEPS.has(seg))
      errors.push(`context field "${f}" -> top-level "${seg}" is not in the BrandContext schema`);
  }

  // 5. calibration seed_from paths point at a declared top-level context field
  for (const field of m.calibration?.fields ?? []) {
    if (typeof field.seed_from === 'string') {
      const seg = topSegment(field.seed_from.replace(/^context\./, ''));
      if (!CONTEXT_TOP_LEVEL.has(seg))
        errors.push(`calibration "${field.id}" seed_from "${field.seed_from}" -> top-level "${seg}" is not in the BrandContext schema`);
    }
  }

  // 6. SKILL.md cannot promise a command that the harness does not implement.
  try {
    const md = await readFile(join(skillsDir, skillId, 'SKILL.md'), 'utf-8');
    for (const ref of KNOWN_UNIMPLEMENTED_REFS) {
      if (md.includes(ref)) errors.push(`SKILL.md references unimplemented \`${ref}\``);
    }
  } catch {
    /* a missing SKILL.md is the telemetry/version linters' concern, not ours */
  }

  results.push({ skillId, errors });
}

const withErrors = results.filter((r) => r.errors.length);

if (withErrors.length === 0) {
  console.log(`✓ All ${results.length} skills pass contract checks (sql_ids, batch_plan, upstream, context fields).`);
  process.exit(0);
}

console.error(`✗ ${withErrors.length}/${results.length} skills have contract errors:\n`);
for (const r of withErrors) {
  console.error(`  ${r.skillId}  (${relative(repoRoot, join(skillsDir, r.skillId, 'skill.manifest.yaml'))})`);
  for (const e of r.errors) console.error(`    - ${e}`);
  console.error('');
}
console.error('Fix: align sql_ids/batch_plan to catalog.yaml, upstream_skills to real skill dirs, and context-field references to the BrandContext schema (harness/src/lib/context/schema.ts).');
process.exit(1);
