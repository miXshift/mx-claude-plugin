// Validate every skill's skill.manifest.yaml against the harness Zod schema.
// Run via: npx tsx scripts/validate-manifests.mjs
//
// Throws (exit 1) on any failure so we catch schema drift in CI / pre-commit.

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, '..', '..', 'skills');
process.env.MIXSHIFT_PLUGIN_ROOT = join(__dirname, '..', '..');

// Import the source module directly. tsx handles .ts via the registered loader.
const { loadSkillManifest } = await import('../src/lib/prefetch/manifest.ts');

const entries = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let failures = 0;
for (const skillId of entries) {
  try {
    const m = await loadSkillManifest(skillId);
    console.log(
      `OK  ${skillId.padEnd(32)} v${m.version.padEnd(8)} sql_ids=${m.sql_ids.length}`,
    );
  } catch (err) {
    failures++;
    console.error(`FAIL ${skillId}`);
    console.error(err.message.split('\n').map((l) => '    ' + l).join('\n'));
  }
}

if (failures > 0) {
  console.error(`\n${failures} manifest(s) failed validation.`);
  process.exit(1);
}
console.log(`\n${entries.length} manifest(s) valid.`);
