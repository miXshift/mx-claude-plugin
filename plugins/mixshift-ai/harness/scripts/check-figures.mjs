// Release gate: every SERVICE-TUNED FIGURE this plugin restates in prose must
// equal the value the gateway actually serves, AT EVERY SITE THAT RESTATES IT.
// Catches "the docs tell a brief author a threshold the service is not
// applying" before the two repos can drift, instead of letting a customer read
// a number out of a skill that no run ever used.
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
// Six numbers are restated EIGHTEEN times across five files. That is eighteen
// hand-transcribed copies, and the same change week proved hand transcription
// fails: one cell of a measured calibration grid was mis-copied and a conclusion
// was drawn from the wrong cell, surviving four days and two repos.
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
// The lock carries NO site counts, deliberately. It is generated in the gateway
// repo, which cannot know how many times this plugin's prose quotes a figure,
// and hand-editing the vendored copy is the transcription failure this gate
// exists to end. Site counts live in EXPECTED_SITES below, in this repo, beside
// the prose they describe.
//
// ANCHORS, NOT NUMBER-HUNTING. Prose sites carry an anchor naming the figure id
// around the literal:
//
//   Markdown/HTML:  floor <!-- figure:buybox_floor -->92<!-- /figure -->% weighted
//   TypeScript:     ..., /* figure:buybox_floor */ '92' /* /figure */)
//                   '(default ' + /* figure:oos_rate_threshold */ '0.25' /* /figure */ + ')'
//
// WHERE THE ANCHOR TEXT ACTUALLY GOES, stated precisely because an earlier
// version of this header overclaimed it as simply "invisible":
//
//   - report.ts: invisible in the PRINTED --help, which is the surface a user
//     sees. The anchors are block comments OUTSIDE the string literals, so they
//     are not part of the text commander prints; the help output is
//     byte-identical to before. Note what is NOT claimed: esbuild does not strip
//     them from the bundle at this build's settings, and two of the four survive
//     verbatim in dist/cli.js (the other two are dropped when it folds the
//     string concatenations). Verified by building dist/ and reading the printed
//     help, not by assuming the bundler.
//   - assets/brief-template.html: invisible IN THE RENDERED PAGE. That file is
//     real HTML that gets rendered, so an HTML comment does not appear to a
//     reader of the brief. It does survive into the delivered HTML source, which
//     is acceptable for a comment that names a figure id and nothing else.
//   - SKILL.md and shared/sql-library/catalog.yaml: NOT invisible to the model.
//     Nothing renders these; they are injected into the model's context as raw
//     text, so the anchors are literally in the prompt. In catalog.yaml the
//     anchor sits inside a `notes: |` block scalar, so it is ordinary text in
//     that string rather than a YAML comment (nothing prints sql-library notes
//     at runtime -- checked -- so it reaches no terminal). This costs a few
//     bytes of prompt on files that already run to hundreds of lines, and the
//     coupling is worth it, but the cost is real and is not hidden here.
//
// There is DELIBERATELY no free-text "find every number and check it" mode.
// check-catalog-drift's header states the reason and it holds twice over here: a
// noisy gate is worse than no gate, because people learn to wave it through. The
// --min-sellable-units help text is the proof. It contains 40 (the live
// default), 0.99 and 1 (the pre-2026-09 values a caller passes to restore the
// old rule) and 2026 (a date). Only one of those four is a claim about what the
// service does now. A find-every-number gate would flag the other three on every
// run, and rules-provenance.md would drown it outright: that file prints 0.25 and
// 40 dozens of times as MEASURED GRID CELLS, which are not claims about the
// default and must never be anchored. Its one prose sentence about the pair
// ("0.25 and 40 are each the LOWEST TESTED value that reproduces the target") is
// also left unanchored on purpose: it records what a measurement found, and it
// stays true whatever the service later defaults to.
//
// FAILS CLOSED, on both sides. No lock, a bad lock, an empty figure set, a
// missing scan root, a figure anchored at fewer sites than expected, a figure
// the lock carries that nobody has decided about, or an anchor hiding in a file
// this gate cannot parse all exit 1. A gate that cannot read the truth cannot
// certify anything, and a green tick that certifies nothing is worse than no
// gate at all.
//
// Run: node scripts/check-figures.mjs

import { readFileSync, readdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HARNESS_ROOT = resolve(__dirname, '..');
const PLUGIN_ROOT = resolve(HARNESS_ROOT, '..');
const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');

function fail(msg) {
  console.error(`check-figures: ${msg}`);
  process.exit(1);
}

// Fixture mode exists so the gate's own failure paths can be tested. It is
// entered ONLY by overriding the scan root, and the two expectation maps are
// overridable ONLY inside it: the same coupling check-catalog-drift uses, for
// the same reason. A real run never sets these, so the escape hatch the tests
// need is not also an escape hatch a release can trip over.
const SCAN_OVERRIDE = process.env.MIXSHIFT_FIGURES_SCAN_DIR;
const FIXTURE_MODE = Boolean(SCAN_OVERRIDE);
const LOCK_PATH = process.env.MIXSHIFT_FIGURES_LOCK || join(HARNESS_ROOT, 'figures.lock.json');

function fixtureMap(envName) {
  const raw = process.env[envName];
  if (!FIXTURE_MODE || !raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`${envName} is not valid JSON: ${err.message}`);
  }
  return new Map(Object.entries(parsed));
}

// ---------------------------------------------------------------------------
// The per-figure expectation. THIS is the gate's spine.
// ---------------------------------------------------------------------------
//
// WHY PER FIGURE, AND WHY NOT A GLOBAL FLOOR. The first version of this gate
// had one global floor (8 anchored claims against 10) plus a per-id
// claimed-at-least-once check, and it could be driven green on the exact defect
// it exists to prevent. Four of the six figures are anchored at more than one
// site, so deleting one site's anchors leaves the id claimed elsewhere and the
// global floor absorbs the loss. Demonstrated, not theorised: reverting the
// SKILL.md threshold paragraph to the pre-P-060 values (0.99, no sellable
// floor) and dropping those two anchors took the count from 10 to 8, which is
// the floor, so it exited 0 with the skill telling brief authors a threshold
// the service does not apply. No malice was needed -- an ordinary doc rewrite
// that drops an HTML comment does it.
//
// So the expectation is per figure and EXACT. Fewer sites than expected means a
// restatement lost its anchor and is no longer checked. More means a new
// restatement was written and nobody recorded it here, which is the same blind
// spot arriving from the other direction. Both fail, and both are fixed by
// either restoring the anchor or updating this map in the same commit that
// changes the prose.
//
// Every entry is a real site, counted from the tree:
//   buybox_floor  4 - SKILL.md threshold paragraph; report.ts --help default;
//                     brief-template.html card heading and table caption
//   buybox_drop   2 - SKILL.md threshold paragraph; report.ts --help default
//   settled_exclusion_days_sc / _vc  1 each - SKILL.md threshold paragraph.
//                     The nearby "--attribution all_14 makes it 14 everywhere"
//                     sentence is override behaviour, not the default, and is
//                     deliberately NOT a site.
//   oos_rate_threshold  4 - SKILL.md threshold paragraph, the battery-knobs
//                     paragraph, the thresholds_applied paragraph; report.ts
//   min_sellable_units  6 - the same three SKILL.md paragraphs, the Vendor
//                     Central figure-naming paragraph, report.ts, and the
//                     MPRX-FIGURES-VC-01 notes in shared/sql-library/catalog.yaml
const FIXTURE_SITES = fixtureMap('MIXSHIFT_FIGURES_EXPECTED_SITES');
const EXPECTED_SITES =
  FIXTURE_SITES ??
  (FIXTURE_MODE
    ? new Map()
    : new Map([
        ['buybox_floor', 4],
        ['buybox_drop', 2],
        ['settled_exclusion_days_sc', 1],
        ['settled_exclusion_days_vc', 1],
        ['oos_rate_threshold', 4],
        ['min_sellable_units', 6],
      ]));
// A real run ALWAYS carries site expectations. A fixture run only does when the
// test supplies them; the rest of the suite exercises the value comparison and
// the fail-closed paths against ad-hoc docs where a site count would mean
// nothing, and falls back to the weaker "documented at least once" rule.
const HAS_SITE_EXPECTATIONS = !FIXTURE_MODE || FIXTURE_SITES !== null;

// Lock figures with no prose site anywhere. This is the gate's ONLY escape hatch
// and every entry needs a WRITTEN reason, validated below to the same bar
// `source` is held to, because an unexplained entry is how a real skew gets
// waved through: silencing coverage for an id is indistinguishable, at a glance,
// from the docs having simply forgotten it. An empty string is not a reason.
// EMPTY TODAY, and that is the point. Every figure the service tunes is
// currently restated somewhere a customer can read it.
const UNANCHORED =
  fixtureMap('MIXSHIFT_FIGURES_UNANCHORED') ??
  new Map([
    // ['some_id', 'reason this figure is never quoted in customer-facing prose'],
  ]);

// The same bar `source` is held to: a reason has to be written, not gestured at.
for (const [id, reason] of UNANCHORED) {
  if (typeof reason !== 'string' || reason.trim().length < 12) {
    fail(
      `UNANCHORED entry "${id}" has no written reason (got ${JSON.stringify(reason)}).\n` +
        '  This map silences coverage for a figure the service tunes and customers see.\n' +
        '  Key presence is not a reason: write why no prose site quotes it, or remove\n' +
        '  the entry and anchor the site.',
    );
  }
  if (EXPECTED_SITES.has(id)) {
    fail(
      `figure "${id}" is in BOTH EXPECTED_SITES and UNANCHORED.\n` +
        '  Those contradict: one says it is quoted, the other says it never is.',
    );
  }
}

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

// THE WHOLE REPO, not two directories. The first version scanned only
// plugins/mixshift-ai/skills and harness/src, which meant an anchor written in
// the README, in docs/, in shared/, in hooks/, or in any html or json asset
// matched nothing and raised nothing. That is false coverage in its purest
// form: the author believes a figure is gated, the gate never sees it, and the
// summary line still says "0 problem(s)". Three of the eighteen real sites
// (two html, one yaml) were outside the old roots.
if (!FIXTURE_MODE && !existsSync(join(REPO_ROOT, 'plugins', 'mixshift-ai'))) {
  fail(
    `repo root ${REPO_ROOT} does not contain plugins/mixshift-ai.\n` +
      '  The scan root is derived from this script\'s own location; a layout change\n' +
      '  broke it. Failing closed rather than scanning the wrong tree.',
  );
}
const SCAN_ROOTS = FIXTURE_MODE ? [SCAN_OVERRIDE] : [REPO_ROOT];
const REL_BASE = FIXTURE_MODE ? resolve(SCAN_OVERRIDE) : REPO_ROOT;

const SCANNABLE = /\.(md|mdx|markdown|ts|mts|cts|tsx|js|mjs|cjs|jsx|ya?ml|html?|json|txt|css|sql)$/i;
// Built output, vendored code and git internals are not prose anyone reads, and
// `test`/`fixtures` hold anchors with deliberately WRONG values, written to
// prove this gate fails. Counting those as claims would be self-defeating.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test', 'tests', '__tests__', 'fixtures', '__fixtures__']);
// Co-located unit tests, same reason as the test directories above.
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/i;
// The stray sweep below reads every OTHER file looking for a smuggled anchor.
// These it does not, because reading them as text answers nothing.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.mp4', '.webm', '.mov', '.mp3', '.wav',
]);
const STRAY_MAX_BYTES = 2 * 1024 * 1024;

// This script's own header shows the anchor syntax; so would any doc explaining
// it. Excluding it by absolute path keeps the examples from being read as
// claims, without a magic marker anyone could paste elsewhere to hide a site.
function isExcluded(abs) {
  return abs === __filename || TEST_FILE_RE.test(abs);
}

// lstatSync, not statSync: statSync follows symlinks, so a directory link
// pointing at an ancestor recurses until the stack blows, and a gate that
// crashes is a release outage.
function walk(dir, scanned, others) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(p, scanned, others);
      continue;
    }
    if (isExcluded(p)) continue;
    if (SCANNABLE.test(entry)) scanned.push(p);
    else if (!BINARY_EXT.has(extname(entry).toLowerCase())) others.push(p);
  }
}

const OPEN_RE = /(?:<!--|\/\*)\s*figure:([A-Za-z0-9_]+)\s*(?:-->|\*\/)/g;
// The enclosed span must stay on ONE line and stay short. Without that bound a
// mistyped closing anchor lets the match run to the next anchor far down the
// file and "verify" a literal that has nothing to do with the id: a false pass,
// which is the only outcome worse than a false failure.
const CLOSE_RE = /^([^\n]{0,60}?)(?:<!--|\/\*)\s*\/figure\s*(?:-->|\*\/)/;
// Used only by the stray sweep, on files the main pass does not parse.
const ANY_ANCHOR_RE = /(?:<!--|\/\*)\s*\/?figure:?[A-Za-z0-9_]*\s*(?:-->|\*\/)/;

const problems = []; // { kind, id, where, detail }
const siteCounts = new Map(); // id -> number of anchored sites found
let claims = 0;
const files = [];
const otherFiles = [];

for (const root of SCAN_ROOTS) {
  if (!existsSync(root)) fail(`scan root not found at ${root}.`);
  walk(root, files, otherFiles);
}

function rel(file) {
  return (relative(REL_BASE, file) || file).replace(/\\/g, '/');
}

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const where0 = rel(file);
  for (const open of text.matchAll(OPEN_RE)) {
    const id = open[1];
    const line = text.slice(0, open.index).split('\n').length;
    const where = `${where0}:${line}`;
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
    siteCounts.set(id, (siteCounts.get(id) ?? 0) + 1);

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

// An anchor in a file this gate does not parse looks like coverage and is not.
// The roots are now the whole repo, so the only remaining way to write one
// somewhere it cannot count is to put it in a file type the main pass skips.
for (const file of otherFiles) {
  let st;
  try {
    st = statSync(file);
  } catch {
    continue;
  }
  if (st.size > STRAY_MAX_BYTES) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!ANY_ANCHOR_RE.test(text)) continue;
  problems.push({
    kind: 'stray',
    id: '(unparsed file)',
    where: rel(file),
    detail:
      'carries a figure anchor in a file type this gate does not parse, so it reads as ' +
      'coverage and is not. Move the claim into a scanned file type, or add the extension ' +
      'to SCANNABLE in this script',
  });
}

// ---------------------------------------------------------------------------
// 3. Coverage: PER FIGURE, per site. See EXPECTED_SITES above for why.
// ---------------------------------------------------------------------------

for (const [id, entry] of expected) {
  const found = siteCounts.get(id) ?? 0;

  if (UNANCHORED.has(id)) {
    if (found > 0) {
      problems.push({
        kind: 'stale-exemption',
        id,
        where: '(UNANCHORED in this script)',
        detail:
          `exempted as never quoted, but ${found} anchored site(s) quote it. ` +
          'Remove the UNANCHORED entry and give it an EXPECTED_SITES count',
      });
    }
    continue;
  }

  if (!EXPECTED_SITES.has(id)) {
    if (!HAS_SITE_EXPECTATIONS) {
      // Fixture fallback: the weaker rule the first version of this gate used,
      // kept so the suite's value-comparison and fail-closed cases stay
      // readable. Never reached on a real run.
      if (found === 0) {
        problems.push({
          kind: 'undecided',
          id,
          where: '(nowhere)',
          detail: `served to customers as ${entry.servedAs} but no anchored prose site quotes it`,
        });
      }
      continue;
    }
    // A figure arrived in the lock and nobody decided where it is documented.
    // min_sellable_units arrived exactly this way; refusing to guess is the
    // point.
    problems.push({
      kind: 'undecided',
      id,
      where: found > 0 ? `${found} anchored site(s)` : '(nowhere)',
      detail:
        `served to customers as ${entry.servedAs} and this gate has no expectation for it. ` +
        'Anchor its prose site(s) and add the count to EXPECTED_SITES, or add it to ' +
        'UNANCHORED in this script WITH a written reason',
    });
    continue;
  }

  const want = EXPECTED_SITES.get(id);
  if (!Number.isInteger(want) || want < 1) {
    fail(`EXPECTED_SITES["${id}"] is ${JSON.stringify(want)}; it must be a positive integer.`);
  }
  if (found === want) continue;
  problems.push({
    kind: found < want ? 'under-anchored' : 'over-anchored',
    id,
    where: found > 0 ? `${found} anchored site(s)` : '(nowhere)',
    detail:
      found < want
        ? `expected ${want} anchored site(s), found ${found}. A restatement lost its anchor ` +
          `and is no longer compared against the service. Restore it, or lower EXPECTED_SITES ` +
          `deliberately in the same commit that removes the prose`
        : `expected ${want} anchored site(s), found ${found}. A new restatement was anchored ` +
          `without recording it. Raise EXPECTED_SITES["${id}"] to ${found} in this commit`,
  });
}

const lockLabel = relative(HARNESS_ROOT, LOCK_PATH).replace(/\\/g, '/') || LOCK_PATH;
const wantTotal = [...EXPECTED_SITES.values()].reduce((a, b) => a + b, 0);
console.log(
  `check-figures: ${expected.size} figure(s) from ${lockLabel}, ` +
    `${claims} anchored claim(s) (expected ${wantTotal}) across ${files.length} scanned file(s) ` +
    `+ ${otherFiles.length} swept, ${problems.length} problem(s).`,
);

if (problems.length === 0) process.exit(0);

const LABEL = {
  mismatch: 'Prose disagrees with the deployed service',
  'unknown-id': 'Anchor names a figure the lock does not carry',
  unclosed: 'Anchor opened and never closed',
  'not-a-number': 'Anchor does not enclose a bare number',
  'under-anchored': 'Figure anchored at FEWER sites than expected',
  'over-anchored': 'Figure anchored at MORE sites than recorded',
  undecided: 'Tuned figure with no anchored site or no recorded expectation',
  'stale-exemption': 'UNANCHORED exemption contradicted by a real site',
  stray: 'Anchor in a file this gate does not parse',
};
console.error('');
for (const kind of [
  'mismatch',
  'under-anchored',
  'over-anchored',
  'undecided',
  'unknown-id',
  'unclosed',
  'not-a-number',
  'stale-exemption',
  'stray',
]) {
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
    'gate was built to end.\n' +
    'A site-count failure is never fixed by lowering the count to match what is\n' +
    'left. Lower it only when the prose that carried the figure is genuinely gone.\n',
);
process.exit(1);
