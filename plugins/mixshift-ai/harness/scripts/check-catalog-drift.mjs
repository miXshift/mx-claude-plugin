// Release gate: every Amazon operation id a SKILL names must exist in the Ads /
// SP-API operation catalog. Catches "the docs promise a capability we do not
// have" instead of letting a user's agent build a plan around it and hit a wall
// at commit time.
//
// WHY THIS EXISTS. In Aug 2026 the shipped mx-amazon-ads skill listed seven SB
// creation operations. Two of them did not exist, and one of those was never
// implementable as a single operation at all, because Amazon exposes a separate
// endpoint per ad type. Two different users built real plans against those ids
// three weeks apart and both fell back to hand-keying the last step into the
// Amazon console. Neither attempt produced a single telemetry event, because
// the CLI refuses an uncataloged id BEFORE any request is made -- so this class
// of defect is invisible to error monitoring and can only be caught by a check
// like this one.
//
// WHERE THE TRUTH LIVES. The operation catalog is owned by the service, in a
// separate repository, so this gate cannot infer it and will not guess: point
// MIXSHIFT_CATALOG_DIR at the directory holding the `*operations*.ts` catalog
// sources. With it unset or wrong, the gate exits 1 rather than reporting a
// clean run, because a check that cannot see the truth cannot certify anything.
//
// DELIBERATELY NOT IN ci.yml. Public plugin CI has no access to the catalog
// source, so wiring it there would produce a permanently-skipped green check --
// exactly the failure mode check-named-pack's own header warns about. It runs
// at RELEASE time, on a machine that has both checkouts, which is the moment
// these docs actually reach customers.
//
// Run: node scripts/check-catalog-drift.mjs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
// MIXSHIFT_SKILLS_DIR exists so the gate can be exercised against fixtures.
// Real runs never set it.
const SKILLS_DIR = process.env.MIXSHIFT_SKILLS_DIR || join(PLUGIN_ROOT, 'skills');

// Dotted tokens that LOOK like operation ids and are not. Each needs a reason:
// this list is the gate's only escape hatch, so an unexplained entry is how a
// real drift gets waved through. Namespace filtering cannot replace it --
// `catalog` and `reporting` are both real catalog namespaces AND common English.
const NOT_OPERATIONS = new Map([
  ['catalog.yaml', 'filename: the query-pack catalog file, not an operation'],
  ['catalog.top_asins', 'brand-context taxonomy field, not an API operation'],
  ['reporting.audience', 'context.yaml config key read by mx-monthly-report'],
  ['reporting.voice_lint', 'context.yaml config key read by mx-monthly-report'],
]);

function resolveCatalogDir() {
  // No guessing at sibling checkout layouts: a wrong guess that happens to hit
  // a real directory is worse than no answer, and one that misses would make
  // the gate's behaviour depend on where someone cloned things.
  const explicit = process.env.MIXSHIFT_CATALOG_DIR;
  if (!explicit) return null;
  if (!existsSync(explicit)) fail(`MIXSHIFT_CATALOG_DIR=${explicit} does not exist.`);
  return explicit;
}

function fail(msg) {
  console.error(`check-catalog-drift: ${msg}`);
  process.exit(1);
}

const catalogDir = resolveCatalogDir();
if (!catalogDir) {
  fail(
    'MIXSHIFT_CATALOG_DIR is not set, so the operation catalog cannot be read.\n' +
      '  Point it at the directory containing the service\'s *operations*.ts catalog\n' +
      '  sources. Failing closed on purpose: a gate that cannot read the catalog\n' +
      '  cannot certify that the docs match it, and a green tick that certifies\n' +
      '  nothing is worse than no gate at all.',
  );
}

// 1. Authoritative ids, straight out of the catalog source.
const catalogIds = new Set();
for (const f of readdirSync(catalogDir)) {
  if (!/operations.*\.ts$/.test(f) || f.endsWith('.test.ts')) continue;
  const src = readFileSync(join(catalogDir, f), 'utf8');
  for (const m of src.matchAll(/\bid:\s*'([a-z0-9_]+\.[a-z0-9_]+)'/g)) catalogIds.add(m[1]);
}
if (catalogIds.size === 0) {
  fail(`found no operation ids in ${catalogDir} — wrong directory, or the catalog shape changed.`);
}
const namespaces = new Set([...catalogIds].map((id) => id.split('.')[0]));

// 2. Every operation-shaped token inside BACKTICKS in shipped skill docs.
//    Backticks only: prose that mentions an operation in passing is not a
//    capability claim, and flagging it would train people to ignore this gate.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

const drift = new Map(); // id -> Set<relative file>
let referenced = 0;
for (const file of walk(SKILLS_DIR)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/`([a-z0-9_]+\.[a-z0-9_]+)`/g)) {
    const id = m[1];
    if (!namespaces.has(id.split('.')[0])) continue;
    if (NOT_OPERATIONS.has(id)) continue;
    referenced++;
    if (catalogIds.has(id)) continue;
    // Relative to the SKILLS dir, not the plugin root: they are the same tree
    // in a real run but not when the dir is overridden, and a slice off the
    // wrong base silently prints a mangled path exactly when someone is
    // debugging why the gate failed.
    const rel = join(basename(SKILLS_DIR), relative(SKILLS_DIR, file)).replace(/\\/g, '/');
    if (!drift.has(id)) drift.set(id, new Set());
    drift.get(id).add(rel);
  }
}

console.log(
  `check-catalog-drift: ${catalogIds.size} catalog operations, ` +
    `${referenced} skill reference(s) checked, ${drift.size} missing.`,
);

if (drift.size === 0) process.exit(0);

console.error('\nSkills claim operations the catalog does not have:\n');
for (const [id, files] of [...drift].sort()) {
  console.error(`  ${id}`);
  for (const f of [...files].sort()) console.error(`      ${f}`);
}
console.error(
  '\nFix by CLOSING THE GAP (add the operation) rather than deleting the mention,\n' +
    'unless the capability is genuinely not coming. If a flagged token is not an\n' +
    'operation id, add it to NOT_OPERATIONS in this script WITH a reason.\n',
);
process.exit(1);
