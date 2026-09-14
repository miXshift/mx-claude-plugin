// Release gate: every SERVICE-TUNED FIGURE this plugin restates in prose must
// equal the value the gateway actually serves. Catches "the docs tell a brief
// author a threshold the service is not applying" before the two repos can
// drift, instead of letting a customer read a number out of a skill that no run
// ever used.
//
// WHY THIS EXISTS. In Sep 2026 (P-060 / D-056) the Vendor Central
// availability-interruption rule changed: oos_rate_threshold moved from 0.99 to
// 0.25 and a new min_sellable_units floor of 40 appeared. The plugin half and
// the gateway half were two PRs in two repos with two merge queues and NOTHING
// coupling them. The plugin PR had to be held back BY HAND, with a literal
// [HOLD] in its title, to stop it publishing 0.25 and 40 to brief authors while
// the deployed service was still applying 0.99 and any-stock.
//
// No existing gate could have caught that skew, and this was VERIFIED rather
// than assumed: the deployed named-query pack manifest check-named-pack reads is
// {schema_version, ids} with 75 ids and NO param schema, so it passes
// identically whether or not the service agrees with the docs. The battery
// revision hash folds the contract version and the statement text but never the
// params schema, so a default moving from 0.99 to 0.25 leaves the hash
// byte-identical. The wire said nothing had changed. A human holding a PR title
// was the entire control.
//
// mx-monthly-report-max/SKILL.md restates six of these constants in one
// customer-facing paragraph and src/commands/report.ts restates four more in its
// --help strings. That is ten hand-transcribed copies of six numbers across two
// repos, and the same change week proved hand transcription fails: one cell of a
// measured calibration grid was mis-copied and a conclusion was drawn from the
// wrong cell, surviving four days and two repos.
//
// WHERE THE TRUTH LIVES. figures.lock.json, beside package.json, VENDORED from
// the gateway. It is generated there (`npm run figures:lock` in mx-legacy-auth,
// emitting docs/figures.lock.json) and copied here verbatim. The copy in this
// repo is a build input, never the source of truth, and it is deliberately
// outside the packaged file set in package-zip.mjs so it does not ship.
//
//   TO REFRESH: re-run the generator in a mx-legacy-auth checkout at the commit
//   that is DEPLOYED, copy docs/figures.lock.json over harness/figures.lock.json,
//   and update `service.ref` and `service.vendored_at` to that commit and date.
//   Refresh it in the SAME PR as any plugin prose change that follows a gateway
//   default, and never ahead of the gateway deploy: a lock that runs ahead of
//   the service re-creates exactly the skew this gate exists to prevent.
//
// THE SHAPE (the consumer contract; the generator must match it):
//   {
//     "schema_version": 1,
//     "generator": string,                  // free text, provenance only
//     "service": { "repo", "ref", ... },    // free text, provenance only
//     "figures": [
//       { "id":       "oos_rate_threshold",           // [a-z0-9_]+, unique
//         "value":    0.25,                           // finite NUMBER, never a string
//         "unit":     "rate",                         // rate|percent|points|units|days
//         "servedAs": "thresholds_applied.oos_rate_threshold",
//         "source":   "how this value was established, or NO RECORDED BASIS" }
//     ]
//   }
// Only `schema_version` and `figures[]` are load-bearing. `unit` and `servedAs`
// are never compared against anything here; they exist so a reader of a failure
// knows what the number means and where a customer sees it, because buybox_floor
// is served under the DIFFERENT key `buybox_floor_pct` and that is exactly the
// kind of detail a human re-deriving the answer gets wrong. `source` is REQUIRED
// and non-empty on every entry, enforcing the standing rule that a stated number
// says how it was established. "NO RECORDED BASIS" is a legitimate and expected
// value: buybox_floor 92 and buybox_drop 5 have been on main and served in
// thresholds_applied since the battery shipped with no recorded basis at all,
// and the contract makes that gap visible rather than letting silence imply
// measurement.
//
// ANCHORS, NOT NUMBER-HUNTING. Prose sites carry an INVISIBLE anchor naming the
// figure id around the literal:
//
//   Markdown:   floor <!-- figure:buybox_floor -->92<!-- /figure -->% weighted
//   TypeScript: ..., /* figure:buybox_floor */ '92' /* /figure */)
//               '(default ' + /* figure:oos_rate_threshold */ '0.25' /* /figure */ + ' on the service)'
//
// An HTML comment stays out of the rendered Markdown page; a block comment stays
// out of the printed --help string. There is DELIBERATELY no free-text "find
// every number and check it" mode. check-catalog-drift's header states the
// reason and it holds twice over here: a noisy gate is worse than no gate,
// because people learn to wave it through. The --min-sellable-units help text is
// the proof. It contains 40 (the live default), 0.99 and 1 (the pre-2026-09
// values a caller passes to restore the old rule) and 2026 (a date). Only one of
// those four is a claim about what the service does now. A find-every-number
// gate would flag the other three on every run, and rules-provenance.md would
// drown it outright: that file prints 0.25 and 40 dozens of times as MEASURED
// GRID CELLS, which are not claims about the default and must never be anchored.
//
// FAILS CLOSED, on both sides. No lock, a bad lock, an empty figure set, a
// missing scan root, or fewer claims than the floor all exit 1. A gate that
// cannot read the truth cannot certify anything, and a green tick that certifies
// nothing is worse than no gate at all.
//
// Run: node scripts/check-figures.mjs

import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(__dirname, '..');
const PLUGIN_ROOT = resolve(HARNESS_ROOT, '..');

function fail(msg) {
  console.error(`check-figures: ${msg}`);
  process.exit(1);
}

// Fixture mode exists so the gate's own failure paths can be tested. It is
// entered ONLY by overriding the scan root, and the claim floor is adjustable
// ONLY inside it: the same coupling check-catalog-drift uses, for the same
// reason. A real run never sets these, so the escape hatch the tests need is not
// also an escape hatch a release can trip over.
const SCAN_OVERRIDE = process.env.MIXSHIFT_FIGURES_SCAN_DIR;
const FIXTURE_MODE = Boolean(SCAN_OVERRIDE);
const LOCK_PATH = process.env.MIXSHIFT_FIGURES_LOCK || join(HARNESS_ROOT, 'figures.lock.json');

// Lock figures with no prose site anywhere. This is the gate's ONLY escape hatch
// and every entry needs a written reason, because an unexplained entry is how a
// real skew gets waved through: silencing coverage for an id is
// indistinguishable, at a glance, from the docs having simply forgotten it.
// EMPTY TODAY, and that is the point. Every figure the service tunes is
// currently restated somewhere a customer can read it.
const UNANCHORED = new Map([
  // ['some_id', 'reason this figure is never quoted in customer-facing prose'],
]);

// ---------------------------------------------------------------------------
// 1. The truth: the vendored lock.
// ---------------------------------------------------------------------------

if (!existsSync(LOCK_PATH)) {
  fail(
    `no figures lock at ${LOCK_PATH}.\n` +
      '  It is vendored from mx-legacy-auth (`npm run figures:lock`, docs/figures.lock.json).\n' +
      '  Failing closed on purpose: without it this gate cannot tell what the service\n' +
      '  serves, so it cannot certify that the docs match it, and a green tick that\n' +
      '  certifies nothing is worse than no gate at all.',
  );
}

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
} catch (err) {
  fail(`${LOCK_PATH} is not valid JSON: ${err.message}`);
}

if (lock?.schema_version !== 1) {
  fail(
    `${LOCK_PATH} has schema_version ${JSON.stringify(lock?.schema_version)}, expected 1.\n` +
      '  The generator changed shape. Update this gate deliberately rather than\n' +
      '  loosening the check: an unread lock is an unchecked doc.',
  );
}
if (!Array.isArray(lock.figures) || lock.figures.length === 0) {
  fail(`${LOCK_PATH} carries no figures[] entries. Wrong file, or the generator emitted an empty lock.`);
}

const ID_RE = /^[a-z0-9_]+$/;
const expected = new Map(); // id -> entry
for (const [i, f] of lock.figures.entries()) {
  const at = `figures[${i}]`;
  if (!f || typeof f !== 'object') fail(`${at} is not an object.`);
  if (typeof f.id !== 'string' || !ID_RE.test(f.id)) {
    fail(`${at}.id ${JSON.stringify(f?.id)} is not a [a-z0-9_]+ id.`);
  }
  if (expected.has(f.id)) fail(`${at}.id "${f.id}" is a duplicate; a figure must appear once.`);
  // A stringified value ("0.25") would compare fine today and then silently stop
  // comparing the day someone emits "0.250", so reject it at the door.
  if (typeof f.value !== 'number' || !Number.isFinite(f.value)) {
    fail(`${at} (${f.id}).value must be a finite NUMBER, got ${JSON.stringify(f.value)}.`);
  }
  for (const k of ['unit', 'servedAs']) {
    if (typeof f[k] !== 'string' || !f[k].trim()) {
      fail(`${at} (${f.id}).${k} must be a non-empty string.`);
    }
  }
  // The standing rule, enforced at the contract boundary: a stated number says
  // how it was established. "NO RECORDED BASIS" is a valid answer; silence is
  // not, because silence reads as "measured" to the next person.
  if (typeof f.source !== 'string' || f.source.trim().length < 12) {
    fail(
      `${at} (${f.id}).source must say how the value was established.\n` +
        '  Write "NO RECORDED BASIS" when that is the truth. An absent basis must be\n' +
        '  stated, never implied by an empty field.',
    );
  }
  expected.set(f.id, f);
}

// ---------------------------------------------------------------------------
// 2. The claims: anchored literals in prose.
// ---------------------------------------------------------------------------

const SCAN_ROOTS = FIXTURE_MODE
  ? [SCAN_OVERRIDE]
  : [join(PLUGIN_ROOT, 'skills'), join(HARNESS_ROOT, 'src')];

const SCANNABLE = /\.(md|mdx|ts|mts|tsx|ya?ml)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// lstatSync, not statSync: statSync follows symlinks, so a directory link
// pointing at an ancestor recurses until the stack blows, and a gate that
// crashes is a release outage.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else if (SCANNABLE.test(entry)) out.push(p);
  }
  return out;
}

const OPEN_RE = /(?:<!--|\/\*)\s*figure:([A-Za-z0-9_]+)\s*(?:-->|\*\/)/g;
// The enclosed span must stay on ONE line and stay short. Without that bound a
// mistyped closing anchor lets the match run to the next anchor far down the
// file and "verify" a literal that has nothing to do with the id: a false pass,
// which is the only outcome worse than a false failure.
const CLOSE_RE = /^([^\n]{0,60}?)(?:<!--|\/\*)\s*\/figure\s*(?:-->|\*\/)/;

const problems = []; // { kind, id, where, detail }
const claimedIds = new Set();
let claims = 0;
const files = [];

for (const root of SCAN_ROOTS) {
  if (!existsSync(root)) fail(`scan root not found at ${root}.`);
  files.push(...walk(root));
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
  for (const open of text.matchAll(OPEN_RE)) {
    const id = open[1];
    const line = text.slice(0, open.index).split('\n').length;
    const where = `${rel}:${line}`;
    const from = open.index + open[0].length;
    const closed = CLOSE_RE.exec(text.slice(from, from + 200));
    if (!closed) {
      // An anchor that opened and never closed would otherwise vanish silently,
      // dropping a real claim while the run still reported a clean pass.
      problems.push({
        kind: 'unclosed',
        id,
        where,
        detail: 'no closing anchor on the same line within 60 characters',
      });
      continue;
    }
    claims++;
    claimedIds.add(id);

    // Strip one layer of matching quotes: the TypeScript sites enclose a string
    // literal ('0.25'), the Markdown sites enclose the bare number.
    let raw = closed[1].trim();
    const q = raw[0];
    if ((q === "'" || q === '"' || q === '`') && raw.endsWith(q) && raw.length >= 2) {
      raw = raw.slice(1, -1).trim();
    }

    if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
      problems.push({
        kind: 'not-a-number',
        id,
        where,
        detail: `enclosed ${JSON.stringify(closed[1])}, which is not a bare numeric literal`,
      });
      continue;
    }
    const entry = expected.get(id);
    if (!entry) {
      problems.push({
        kind: 'unknown-id',
        id,
        where,
        detail: `the lock has no figure "${id}" (stale lock, or a typo in the anchor)`,
      });
      continue;
    }
    if (Number(raw) !== entry.value) {
      problems.push({
        kind: 'mismatch',
        id,
        where,
        detail: `prose says ${raw}, the service serves ${entry.value} ${entry.unit} as ${entry.servedAs}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Coverage: a figure the service tunes and nobody documents.
// ---------------------------------------------------------------------------

for (const [id, entry] of expected) {
  if (claimedIds.has(id)) continue;
  if (UNANCHORED.has(id)) continue;
  problems.push({
    kind: 'unanchored',
    id,
    where: '(nowhere)',
    detail:
      `served to customers as ${entry.servedAs} but no anchored prose site quotes it. ` +
      'Anchor it where it is documented, or add it to UNANCHORED in this script WITH a reason',
  });
}

const lockLabel = relative(HARNESS_ROOT, LOCK_PATH).replace(/\\/g, '/') || LOCK_PATH;
console.log(
  `check-figures: ${expected.size} figure(s) from ${lockLabel}, ` +
    `${claims} anchored claim(s) across ${files.length} file(s), ${problems.length} problem(s).`,
);

// ---------------------------------------------------------------------------
// 4. Fail closed on the docs side too.
// ---------------------------------------------------------------------------

// Extracting nothing is not agreement. A wrong scan root, a rename of the skills
// tree, or an anchor syntax that quietly stopped matching all land on "0
// problems" and would otherwise report a clean run. The floor is 8 against 10
// real claims today: low enough that removing one mention is not a false
// failure, high enough that EITHER scan root dropping out is caught (the skills
// tree alone carries 6 claims, the harness tree alone carries 4).
const MIN_EXPECTED_CLAIMS = FIXTURE_MODE ? Number(process.env.MIXSHIFT_FIGURES_MIN_CLAIMS ?? 0) : 8;
if (claims < MIN_EXPECTED_CLAIMS) {
  fail(
    `only ${claims} anchored claim(s) found across ${files.length} file(s), ` +
      `below the floor of ${MIN_EXPECTED_CLAIMS}.\n` +
      '  That means the docs were not fully read, not that they agree with the lock.\n' +
      `  Scanned: ${SCAN_ROOTS.map((r) => relative(PLUGIN_ROOT, r).replace(/\\/g, '/') || r).join(', ')}`,
  );
}

if (problems.length === 0) process.exit(0);

const LABEL = {
  mismatch: 'Prose disagrees with the deployed service',
  'unknown-id': 'Anchor names a figure the lock does not carry',
  unclosed: 'Anchor opened and never closed',
  'not-a-number': 'Anchor does not enclose a bare number',
  unanchored: 'Tuned figure with no documented site',
};
console.error('');
for (const kind of ['mismatch', 'unknown-id', 'unclosed', 'not-a-number', 'unanchored']) {
  const group = problems.filter((p) => p.kind === kind);
  if (group.length === 0) continue;
  console.error(`${LABEL[kind]}:\n`);
  for (const p of group.sort((a, b) => (a.id + a.where).localeCompare(b.id + b.where))) {
    console.error(`  ${p.id}`);
    console.error(`      ${p.where}`);
    console.error(`      ${p.detail}`);
  }
  console.error('');
}
console.error(
  'A mismatch means one of two things, and they have OPPOSITE fixes:\n' +
    '  1. The gateway changed and this plugin has not caught up. Refresh\n' +
    '     figures.lock.json from the DEPLOYED gateway commit and update the prose.\n' +
    '     Do not ship the prose ahead of the deploy.\n' +
    '  2. The prose was always wrong. Fix the prose; the lock is the service.\n' +
    'Never resolve it by editing the lock to agree with the docs. The lock is\n' +
    'vendored output, and hand-editing it is the hand-transcription failure this\n' +
    'gate was built to end.\n',
);
process.exit(1);
