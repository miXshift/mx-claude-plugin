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

import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from 'node:fs';
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
  ['reporting.brief_documents', 'context.yaml config key read by mx-monthly-report-max'],
  ['reporting.call_cadence', 'context.yaml config key read by mx-monthly-report-max'],
  ['reporting.group_merges', 'context.yaml config key read by mx-monthly-report-max'],
  ['reporting.max_live_probes', 'context.yaml config key read by mx-monthly-report-max'],
  ['reporting.review', 'context.yaml config key read by mx-monthly-report-max'],
  ['reporting.sections', 'context.yaml config key read by mx-monthly-report-max'],
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
//
// Comments are STRIPPED before scanning. Commenting an entry out is the most
// likely way an operation gets retired, and a raw regex over the source would
// keep counting it as live -- certifying a capability the service refuses at
// runtime, which is precisely the case this gate exists to catch.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let catalogFiles = 0;
const catalogIds = new Set();
let dirEntries;
try {
  dirEntries = readdirSync(catalogDir);
} catch (err) {
  fail(`could not read ${catalogDir} as a directory: ${err.message}`);
}
for (const f of dirEntries) {
  if (!/operations.*\.(ts|mts)$/.test(f) || /\.(test|spec)\.(ts|mts)$/.test(f)) continue;
  catalogFiles++;
  const src = stripComments(readFileSync(join(catalogDir, f), 'utf8'));
  for (const m of src.matchAll(/\bid:\s*'([a-z0-9_]+\.[a-z0-9_]+)'/g)) catalogIds.add(m[1]);
}
if (catalogIds.size === 0) {
  fail(`found no operation ids in ${catalogDir} — wrong directory, or the catalog shape changed.`);
}
const namespaces = new Set([...catalogIds].map((id) => id.split('.')[0]));

// 2. Every operation-shaped token inside BACKTICKS in shipped skill docs.
//    Backticks only: prose that mentions an operation in passing is not a
//    capability claim, and flagging it would train people to ignore this gate.
// lstatSync, not statSync: statSync follows symlinks, so a directory link
// pointing at an ancestor recurses until the stack blows. A release gate that
// crashes is a release outage.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    // Skill docs AND manifests: skill.manifest.yaml names operation ids in its
    // harness_commands, and those are capability claims too.
    else if (/\.(md|ya?ml)$/.test(entry)) out.push(p);
  }
  return out;
}

if (!existsSync(SKILLS_DIR)) fail(`skills directory not found at ${SKILLS_DIR}.`);

// Operation ids are claimed two ways, and BOTH are promises:
//   `sb.create_ads`                       inline, prose-adjacent
//   mixshift ads call sb.create_ads       inside a fenced example, copy-pasteable
// Only matching the first would miss the strongest claims in the docs -- a
// runnable command is a harder promise than a mention. What is NOT a claim is
// bare prose ("there is no sb.create_ads yet"), so a token still has to be
// either backticked or introduced by one of the call verbs.
const CLAIM_PATTERNS = [
  /`([a-z0-9_]+\.[a-z0-9_]+)`/g,
  /(?:ads|spapi|amazon)\s+call\s+(?:--operation\s+)?([a-z0-9_]+\.[a-z0-9_]+)/g,
  /--operation[=\s]+([a-z0-9_]+\.[a-z0-9_]+)/g,
  /^\s*-\s*mixshift[^\n]*?\b([a-z0-9_]+\.[a-z0-9_]+)\b/gm,
];

const drift = new Map(); // id -> Set<relative file>
const seen = new Set();
let referenced = 0;
const files = walk(SKILLS_DIR);
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const re of CLAIM_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const id = m[1];
      if (!namespaces.has(id.split('.')[0])) continue;
      if (NOT_OPERATIONS.has(id)) continue;
      const key = `${file}::${id}`;
      if (seen.has(key)) continue; // one file claiming an id twice is one claim
      seen.add(key);
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
}

console.log(
  `check-catalog-drift: ${catalogIds.size} catalog operations from ${catalogFiles} file(s), ` +
    `${referenced} claim(s) across ${files.length} doc(s), ${drift.size} missing.`,
);

// FAIL CLOSED ON THE DOCS SIDE TOO. The catalog side has always failed closed
// (no ids found => exit 1); the docs side did not, so an empty or mis-pointed
// skills directory reported "0 missing" and exited 0 -- the green tick that
// certifies nothing, which this script's own header condemns. A partial catalog
// produces the same shape: the namespace filter silently drops every reference
// belonging to a catalog file that was not loaded.
// The floor is only adjustable in FIXTURE MODE, and fixture mode is entered by
// overriding the skills dir. That coupling is deliberate: it means a real run
// -- which never sets MIXSHIFT_SKILLS_DIR -- cannot have its floor lowered by a
// stray environment variable, so the escape hatch the tests need is not also an
// escape hatch a release can trip over.
const FIXTURE_MODE = Boolean(process.env.MIXSHIFT_SKILLS_DIR);
const MIN_EXPECTED_CLAIMS = FIXTURE_MODE
  ? Number(process.env.MIXSHIFT_DRIFT_MIN_CLAIMS ?? 0)
  : 40;
if (referenced < MIN_EXPECTED_CLAIMS) {
  fail(
    `only ${referenced} operation claim(s) found across ${files.length} doc(s), ` +
      `which is below the floor of ${MIN_EXPECTED_CLAIMS}.\n` +
      '  That means the docs or the catalog were not fully read, not that they agree:\n' +
      '  an empty/mis-pointed skills dir, or a catalog dir holding only some of the\n' +
      `  *operations*.ts files, both land here. Loaded ${catalogFiles} catalog file(s)\n` +
      `  and ${namespaces.size} namespace(s) from ${catalogDir}.`,
  );
}

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
