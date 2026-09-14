// Release gate: every SERVICE-TUNED FIGURE this plugin restates in prose must
// equal the value the gateway actually serves, AT EVERY SITE THAT RESTATES IT,
// and the SHIPPED BUNDLE must not still be printing an older one.
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
// Six numbers are restated NINETEEN times across five files. That is nineteen
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
// The lock carries NO site list, deliberately. It is generated in the gateway
// repo, which cannot know where this plugin's prose quotes a figure, and
// hand-editing the vendored copy is the transcription failure this gate exists
// to end. Sites live in EXPECTED_SITES below, in this repo, beside the prose
// they describe.
//
// ANCHORS, NOT NUMBER-HUNTING. Prose sites carry an anchor naming the figure id
// AND THE SITE, around the literal:
//
//   Markdown/HTML:  floor <!-- figure:buybox_floor@skill-thresholds -->92<!-- /figure -->% weighted
//   TypeScript:     ..., /* figure:buybox_floor@harness-help-buybox-floor */ '92' /* /figure */)
//                   '(default ' + /* figure:oos_rate_threshold@harness-help-oos-rate */ '0.25' /* /figure */ + ')'
//
// WHY THE SITE LABEL, AND WHY A COUNT WAS NOT ENOUGH. The previous version held
// each figure to a per-figure COUNT of anchored claims. A count is a bag: it
// says how many anchors exist, never WHICH prose carries them. A real site could
// lose its anchor and the count be made whole, in the same commit, by an anchor
// written anywhere else -- a second anchor on an already-covered line, or a
// throwaway file nobody reads -- and the gate would go green while a
// customer-facing restatement quietly stopped being compared to anything. That
// is the same defect the global floor had, one level up, so the expectation is
// now a DECLARED LIST OF SITES and each declared site must be matched EXACTLY
// ONCE, by `<repo-relative path>#<label>`. Losing one names the site that went
// missing. An anchor whose site is not declared fails too: a new restatement
// nobody recorded is the same blind spot arriving from the other direction.
//
// The label travels WITH the prose, so it survives the edits a line number does
// not: reflowing a paragraph, inserting a section above it, or moving the
// sentence within its file all keep the site intact, while moving the anchor to
// a DIFFERENT file changes its path and fails, which is the case that matters.
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
//     is acceptable for a comment that names a figure id and a site label and
//     nothing else.
//   - SKILL.md and shared/sql-library/catalog.yaml: NOT invisible to the model.
//     Nothing renders these; they are injected into the model's context as raw
//     text, so the anchors are literally in the prompt. In catalog.yaml the
//     anchor sits inside a `notes: |` block scalar, so it is ordinary text in
//     that string rather than a YAML comment (nothing prints sql-library notes
//     at runtime -- checked -- so it reaches no terminal). This costs a few
//     bytes of prompt on files that already run to hundreds of lines, and the
//     site label added to each anchor costs a few bytes more; the coupling is
//     worth it, but the cost is real and is not hidden here.
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
// THE SHIPPED BUNDLE IS CHECKED TOO, and the reason is a live defect this gate
// found on its own first run. dist/ was in SKIP_DIRS, so the prose walk never
// read the one artifact a customer actually executes. The committed
// dist/cli.js -- the 0.8.13 bundle -- prints `--oos-rate-threshold ... (default
// 0.99 on the service)` while the service has served 0.25 since 2026-09-14, and
// carries no --min-sellable-units option at all. Every gate in the repo was
// green over that. The bundle is now scanned by BUNDLE_PROBES below.
//
// FAILS CLOSED, on both sides. No lock, a bad lock, an empty figure set, a
// missing scan root, a missing bundle, a declared site whose anchor is gone, an
// anchor at a site nobody declared, a figure the lock carries that nobody has
// decided about, or an anchor hiding in a file this gate cannot parse all exit
// 1. A gate that cannot read the truth cannot certify anything, and a green tick
// that certifies nothing is worse than no gate at all.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITS. Written down rather than implied, because a gate whose edges are
// undocumented gets trusted past them.
//
//   1. THE LOCK IS HAND-WRITTEN TODAY, so this gate currently proves INTERNAL
//      AGREEMENT, not agreement with the running service. `npm run figures:lock`
//      and docs/figures.lock.json do not exist on mx-legacy-auth's main yet;
//      they arrive on the sibling branch feat/revision-params-hash. Until that
//      merges and its output replaces this file verbatim, figures.lock.json is a
//      PROVISIONAL snapshot that a human read out of the gateway source by hand
//      (its `generator` field says so). A human transcribing the truth file is
//      the same failure mode as a human transcribing the docs -- smaller, since
//      it is one file reviewed once instead of nineteen sites edited forever,
//      but not zero. Replace it with the generated artifact when that branch
//      lands; do not let the provisional copy become the permanent one.
//   2. MIXSHIFT_FIGURES_LOCK IS HONORED ON A REAL RUN. Unlike the fixture
//      overrides below, which do nothing unless MIXSHIFT_FIGURES_SCAN_DIR puts
//      the gate in fixture mode, the lock path is overridable in any run. That
//      is what lets a release lane point at a lock it fetched, and it is also an
//      environment variable that redirects the gate's only source of truth.
//      Anyone who can set the environment of the CI step can decide what this
//      gate compares against.
//   3. THE WALK READS THE FILESYSTEM, NOT THE GIT INDEX. It scans what is on
//      disk: an untracked working-tree file is read and can fail a run over
//      prose that will never ship, and a tracked file missing from the tree is
//      simply not seen. It skips SYMLINKS outright (lstat, never stat), so a
//      real doc reachable only through a link is invisible to the gate rather
//      than checked. It skips test and fixture directories and *.test.* files,
//      which is what keeps this suite's deliberately-wrong anchors from counting
//      as claims, and which equally means an anchor that genuinely belongs in
//      one of those places is uncounted.
//   4. BUNDLE_BEHIND IS THE ONE PLACE THIS GATE IS GREEN OVER A REAL SKEW. The
//      committed bundle lags the source by repo policy between releases, so a
//      figure change cannot be merged and a rebuilt bundle cannot be committed
//      in the same PR. The entries record that lag instead of hiding it: pinned
//      to the exact stale literal, printed on every run, failing on any other
//      value and on the value being fixed. What they do NOT do is make the
//      shipped CLI correct. While an entry stands, a customer running the
//      packaged binary reads the number it names. It is a stated debt with a
//      named payer (the release cut), not a clean bill.
// ---------------------------------------------------------------------------
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
// entered ONLY by overriding the scan root, and the expectation maps and the
// bundle stage are overridable ONLY inside it: the same coupling
// check-catalog-drift uses, for the same reason. A real run never sets these, so
// the escape hatch the tests need is not also an escape hatch a release can trip
// over. MIXSHIFT_FIGURES_LOCK is the documented exception (KNOWN LIMITS 2).
const SCAN_OVERRIDE = process.env.MIXSHIFT_FIGURES_SCAN_DIR;
const FIXTURE_MODE = Boolean(SCAN_OVERRIDE);
const LOCK_PATH = process.env.MIXSHIFT_FIGURES_LOCK || join(HARNESS_ROOT, 'figures.lock.json');

function fixtureJson(envName) {
  const raw = process.env[envName];
  if (!FIXTURE_MODE || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${envName} is not valid JSON: ${err.message}`);
  }
}

function fixtureMap(envName) {
  const parsed = fixtureJson(envName);
  return parsed === null || parsed === undefined ? null : new Map(Object.entries(parsed));
}

// ---------------------------------------------------------------------------
// The per-figure expectation. THIS is the gate's spine.
// ---------------------------------------------------------------------------
//
// WHY A DECLARED SITE LIST, AND WHY NEITHER A GLOBAL FLOOR NOR A COUNT.
//
// Version one had one global floor (8 anchored claims against 10) plus a
// claimed-at-least-once check per id, and it could be driven green on the exact
// defect it exists to prevent. Four of the six figures are anchored at more than
// one site, so deleting one site's anchors left the id claimed elsewhere and the
// floor absorbed the loss. Demonstrated, not theorised: reverting the SKILL.md
// threshold paragraph to the pre-P-060 values (0.99, no sellable floor) and
// dropping those two anchors took the count from 10 to 8, which is the floor, so
// it exited 0 with the skill telling brief authors a threshold the service does
// not apply.
//
// Version two replaced the floor with a per-figure COUNT, which narrowed the
// hole without closing it. A count still says only how many anchors exist, never
// which prose carries them, so the SAME move worked: drop the anchor on a real
// restatement and add one anywhere else in the same commit -- a second anchor on
// a line already covered, or a file nobody reads -- and the count is whole while
// the restatement that a customer reads is no longer compared to anything.
//
// So the expectation is an explicit list of SITES, `<path>#<label>`, and each
// one must be matched EXACTLY ONCE. A missing site is named in the failure. A
// duplicate label is a failure, so two anchors cannot cover for one. An anchor
// at an undeclared site is a failure, so a throwaway file cannot make up the
// difference. All three are fixed the same way: restore the anchor, or edit this
// list in the same commit that changes the prose.
const FIXTURE_SITES = fixtureJson('MIXSHIFT_FIGURES_EXPECTED_SITES');
const SKILL = 'plugins/mixshift-ai/skills/mx-monthly-report-max/SKILL.md';
const BRIEF = 'plugins/mixshift-ai/skills/mx-monthly-report-max/assets/brief-template.html';
const REPORT_TS = 'plugins/mixshift-ai/harness/src/commands/report.ts';
const CATALOG = 'plugins/mixshift-ai/shared/sql-library/catalog.yaml';

// Every entry is a real site, read off the tree, not counted from memory.
const REAL_SITES = new Map([
  [
    'buybox_floor',
    [
      `${SKILL}#skill-thresholds`, // the Threshold defaults paragraph
      `${REPORT_TS}#harness-help-buybox-floor`, // --buybox-floor default in --help
      `${BRIEF}#brief-card-heading`, // "items still below 92%" card
      `${BRIEF}#brief-table-caption`, // the same table's caption
    ],
  ],
  [
    'buybox_drop',
    [`${SKILL}#skill-thresholds`, `${REPORT_TS}#harness-help-buybox-drop`],
  ],
  // TWO sites, and the second one was missed by the first sweep of this file:
  // the settled-window step in the analysis sequence tells the author to exclude
  // the last 7 days from both periods, which is the same claim about the same
  // service default in different words, and it sat unanchored while the
  // expectation assumed it was covered.
  //
  // Two nearby sevens in that prose are deliberately NOT sites, and the
  // distinction is the one this gate rests on. "`--attribution all_14` makes it
  // 14 everywhere" is OVERRIDE behaviour, not the default. "Sponsored Products
  // attributes on a 7-day window" is a fact about AMAZON's attribution rule,
  // which is where the default is derived from but is not a claim about what the
  // service applies: it would stay true, and stay 7, if the service moved its
  // exclusion tomorrow.
  [
    'settled_exclusion_days_sc',
    [`${SKILL}#skill-thresholds`, `${SKILL}#skill-settled-window-step`],
  ],
  ['settled_exclusion_days_vc', [`${SKILL}#skill-thresholds`]],
  [
    'oos_rate_threshold',
    [
      `${SKILL}#skill-thresholds`,
      `${SKILL}#skill-battery-knobs`,
      `${SKILL}#skill-thresholds-applied`,
      `${REPORT_TS}#harness-help-oos-rate`,
    ],
  ],
  [
    'min_sellable_units',
    [
      `${SKILL}#skill-thresholds`,
      `${SKILL}#skill-battery-knobs`,
      `${SKILL}#skill-thresholds-applied`,
      `${SKILL}#skill-vc-figure-naming`,
      `${REPORT_TS}#harness-help-min-sellable`,
      `${CATALOG}#catalog-mprx-vc-notes`, // MPRX-FIGURES-VC-01 notes
    ],
  ],
]);

const EXPECTED_SITES =
  FIXTURE_SITES !== null && FIXTURE_SITES !== undefined
    ? new Map(Object.entries(FIXTURE_SITES))
    : FIXTURE_MODE
      ? new Map()
      : REAL_SITES;

// A real run ALWAYS carries site expectations. A fixture run only does when the
// test supplies them; the rest of the suite exercises the value comparison and
// the fail-closed paths against ad-hoc docs where a site list would mean
// nothing, and falls back to the weaker "documented at least once" rule.
const HAS_SITE_EXPECTATIONS = !FIXTURE_MODE || (FIXTURE_SITES !== null && FIXTURE_SITES !== undefined);

for (const [id, sites] of EXPECTED_SITES) {
  if (!Array.isArray(sites) || sites.length === 0) {
    fail(
      `EXPECTED_SITES["${id}"] is ${JSON.stringify(sites)}; it must be a non-empty ARRAY of\n` +
        '  "<repo-relative path>#<site label>" entries. A bare count is what let a real site\n' +
        '  lose its anchor while an anchor written anywhere else kept the number whole.',
    );
  }
  const seen = new Set();
  for (const site of sites) {
    if (typeof site !== 'string' || !site.includes('#')) {
      fail(`EXPECTED_SITES["${id}"] entry ${JSON.stringify(site)} is not "<path>#<label>".`);
    }
    if (seen.has(site)) fail(`EXPECTED_SITES["${id}"] lists ${JSON.stringify(site)} twice.`);
    seen.add(site);
  }
}

// Lock figures with no prose site anywhere. This is the gate's ONLY escape hatch
// on the prose side and every entry needs a WRITTEN reason, validated below to
// the same bar `source` is held to, because an unexplained entry is how a real
// skew gets waved through: silencing coverage for an id is indistinguishable, at
// a glance, from the docs having simply forgotten it. An empty string is not a
// reason. EMPTY TODAY, and that is the point. Every figure the service tunes is
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
// summary line still says "0 problem(s)". Three of the real sites (two html,
// one yaml) were outside the old roots.
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
// Vendored code and git internals are not prose anyone reads, and
// `test`/`fixtures` hold anchors with deliberately WRONG values, written to
// prove this gate fails. Counting those as claims would be self-defeating.
// `dist` is skipped by the PROSE walk for a different reason: it is generated,
// its 4MB of folded output is not prose, and the anchors do not reliably survive
// the bundler. It is NOT unchecked -- section 4 reads it directly, because the
// bundle is the artifact a customer actually runs.
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
// crashes is a release outage. The cost is KNOWN LIMITS 3: a doc reachable only
// through a link is skipped rather than checked.
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

// The site label is part of the opening anchor. It is optional in the GRAMMAR so
// that an unlabelled anchor is reported as an unlabelled anchor rather than
// silently not matching anything, which is how a claim would go quiet.
const OPEN_RE = /(?:<!--|\/\*)\s*figure:([A-Za-z0-9_]+)(?:@([A-Za-z0-9._-]+))?\s*(?:-->|\*\/)/g;
// The enclosed span must stay on ONE line and stay short. Without that bound a
// mistyped closing anchor lets the match run to the next anchor far down the
// file and "verify" a literal that has nothing to do with the id: a false pass,
// which is the only outcome worse than a false failure.
const CLOSE_RE = /^([^\n]{0,60}?)(?:<!--|\/\*)\s*\/figure\s*(?:-->|\*\/)/;
// Used only by the stray sweep, on files the main pass does not parse. The
// character class carries @ . - so a LABELLED anchor in an unparsed file is
// still caught; without that it would read as coverage and be invisible.
const ANY_ANCHOR_RE = /(?:<!--|\/\*)\s*\/?figure:?[A-Za-z0-9_@.-]*\s*(?:-->|\*\/)/;

const problems = []; // { kind, id, where, detail }
const anchors = []; // { id, label, where, file, line }
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
    const label = open[2] ?? null;
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
    anchors.push({ id, label, where, file: where0, line });

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
// 3. Coverage: PER FIGURE, PER DECLARED SITE. See EXPECTED_SITES above for why.
// ---------------------------------------------------------------------------

// Index the anchors by figure, then by site key. Two anchors that resolve to the
// same site key are a DUPLICATE, not a count of two: that is precisely the move
// that used to keep a bag count whole while a real restatement went dark.
const byFigure = new Map(); // id -> Map<siteKey, anchor[]>
const unlabelled = new Map(); // id -> anchor[]
for (const a of anchors) {
  if (!byFigure.has(a.id)) byFigure.set(a.id, new Map());
  if (a.label === null) {
    if (!unlabelled.has(a.id)) unlabelled.set(a.id, []);
    unlabelled.get(a.id).push(a);
    continue;
  }
  const key = `${a.file}#${a.label}`;
  const sites = byFigure.get(a.id);
  if (!sites.has(key)) sites.set(key, []);
  sites.get(key).push(a);
}

for (const [id, entry] of expected) {
  const sites = byFigure.get(id) ?? new Map();
  const found = claimsFor(id);

  if (UNANCHORED.has(id)) {
    if (found > 0) {
      problems.push({
        kind: 'stale-exemption',
        id,
        where: '(UNANCHORED in this script)',
        detail:
          `exempted as never quoted, but ${found} anchored site(s) quote it. ` +
          'Remove the UNANCHORED entry and give it an EXPECTED_SITES list',
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
        'Anchor its prose site(s) and list them in EXPECTED_SITES, or add it to ' +
        'UNANCHORED in this script WITH a written reason',
    });
    continue;
  }

  // An unlabelled anchor cannot be attributed to a declared site, so it is a
  // claim the gate cannot account for. Reported in its own right rather than
  // left to surface as a confusing "site missing" for prose that is right there.
  for (const a of unlabelled.get(id) ?? []) {
    problems.push({
      kind: 'unlabelled',
      id,
      where: a.where,
      detail:
        'anchor carries no site label, so it cannot be matched to a declared site. ' +
        `Write it as figure:${id}@<site label> and list "${a.file}#<site label>" in EXPECTED_SITES`,
    });
  }

  const declared = EXPECTED_SITES.get(id);
  for (const site of declared) {
    const hits = sites.get(site) ?? [];
    if (hits.length === 1) continue;
    if (hits.length === 0) {
      problems.push({
        kind: 'site-missing',
        id,
        where: site,
        detail:
          'this exact site is declared and its anchor is gone, so the restatement there ' +
          'is no longer compared against the service. Restore the anchor, or remove the ' +
          'site from EXPECTED_SITES in the same commit that removes the prose',
      });
      continue;
    }
    problems.push({
      kind: 'site-duplicate',
      id,
      where: `${site} (${hits.map((h) => h.where).join(', ')})`,
      detail:
        `${hits.length} anchors resolve to one declared site. A site is one restatement; ` +
        'two anchors sharing a label let a real site lose its anchor without the numbers ' +
        'moving. Give each restatement its own label and list it',
    });
  }

  const declaredSet = new Set(declared);
  for (const [key, hits] of sites) {
    if (declaredSet.has(key)) continue;
    problems.push({
      kind: 'site-undeclared',
      id,
      where: `${key} (${hits.map((h) => h.where).join(', ')})`,
      detail:
        'a restatement was anchored at a site nobody recorded. That is the same blind ' +
        `spot from the other direction: add "${key}" to EXPECTED_SITES["${id}"] in this ` +
        'commit, or move the claim back to a declared site',
    });
  }
}

function claimsFor(id) {
  let n = (unlabelled.get(id) ?? []).length;
  for (const hits of byFigure.get(id)?.values() ?? []) n += hits.length;
  return n;
}

// ---------------------------------------------------------------------------
// 4. The shipped bundle: dist/cli.js, the artifact a customer actually runs.
// ---------------------------------------------------------------------------
//
// WHY THIS IS NOT JUST MORE ANCHORS. esbuild folds the string concatenations in
// report.ts, so two of the four --help anchors survive into the bundle verbatim
// and two do not. Anchor matching would therefore be silently partial, which is
// the false-coverage failure this gate already exists to end. Instead each probe
// pins the SURROUNDING PROSE, which esbuild does preserve, and reads the number
// out of it.
//
// Each probe is validated from BOTH ends, so it cannot rot into a no-op:
//   - `marker` must appear in the SOURCE file. If the help text is reworded and
//     the probe is not, this fails as a stale probe, not as a clean pass.
//   - `pattern` must match the BUNDLE. If it does not, the bundle predates the
//     source and is reported stale.
//   - the captured number must equal the lock.
//
// AND THE ONE THING THAT IS NOT A FAILURE. CONTRIBUTING is explicit that dist is
// rebuilt ONLY at the release cut and "at the cut it is expected to be behind
// every source change merged since the last release". So a figure change merged
// between releases legitimately leaves the bundle behind. BUNDLE_BEHIND records
// that state EXPLICITLY, pinned to the exact stale value, with a written reason.
// It is not a mute button: the staleness is printed on every run, an unrecorded
// disagreement fails, a DIFFERENT stale value fails, and once the release
// rebuild makes the bundle agree the entry itself fails until it is removed. The
// gate therefore forces the acknowledgement to be cleared at the cut.
const BUNDLE_PATH = FIXTURE_MODE
  ? process.env.MIXSHIFT_FIGURES_BUNDLE || null
  : join(HARNESS_ROOT, 'dist', 'cli.js');

const REAL_BUNDLE_PROBES = [
  // The `(?:/\*[^*]*\*/\s*)?` before the default is not decoration. esbuild
  // KEEPS the anchor comment between the description and the default for these
  // two options (it drops it on the two below, where it folds a concatenation),
  // and it did not keep it in the 0.8.13 bundle, which predates the anchors. A
  // pattern that assumed either shape would report the other one stale. Caught
  // by building dist and re-running this gate against the fresh bundle, not by
  // reasoning about the bundler -- the same method the header's claim about
  // which anchors survive was established by.
  {
    id: 'buybox_floor',
    source: REPORT_TS,
    marker: "'--buybox-floor <pct>'",
    pattern: '"--buybox-floor <pct>",\\s*"[^"]*",\\s*(?:/\\*[^*]*\\*/\\s*)?"([\\d.]+)"',
  },
  {
    id: 'buybox_drop',
    source: REPORT_TS,
    marker: "'--buybox-drop <pts>'",
    pattern: '"--buybox-drop <pts>",\\s*"[^"]*",\\s*(?:/\\*[^*]*\\*/\\s*)?"([\\d.]+)"',
  },
  {
    id: 'oos_rate_threshold',
    source: REPORT_TS,
    marker: 'counts as out of stock (default ',
    pattern: 'counts as out of stock \\(default ([\\d.]+) on the service\\)',
  },
  {
    id: 'min_sellable_units',
    source: REPORT_TS,
    marker: 'A fixed unit floor, not a share of run rate (default ',
    pattern: 'A fixed unit floor, not a share of run rate \\(default ([\\d.]+) on the service',
  },
];

// id -> { found: the exact stale literal in the bundle, or null when the bundle
//         carries no such restatement at all; reason: why, in words }
const REAL_BUNDLE_BEHIND = new Map([
    [
      'oos_rate_threshold',
      {
        found: '0.99',
        reason:
          'The committed bundle is the 0.8.13 build (dist/build-meta.json built_at 2026-09-11), ' +
          'cut before the gateway deployed 0.25 on 2026-09-14. Its --help therefore prints the ' +
          'pre-P-060 default to anyone running the shipped CLI. Feature PRs do not rebuild dist ' +
          '(CONTRIBUTING, "dist/ is release-time, not PR-time"), so this clears at the next ' +
          'release cut and not before.',
      },
    ],
    [
      'min_sellable_units',
      {
        found: null,
        reason:
          'The 0.8.13 bundle has no --min-sellable-units option at all: the flag is added by the ' +
          'source change this gate ships beside. Same release-time rebuild clears it. Recorded ' +
          'rather than silenced so the missing surface is visible while it is missing.',
      },
    ],
  ]);

// The fixture envelope replaces BOTH, or neither. Letting a test override the
// probes while the real acknowledgements stayed behind would run a fixture's
// bundle against production entries, which is a test that proves nothing about
// either.
const BUNDLE_PROBES = fixtureJson('MIXSHIFT_FIGURES_BUNDLE_PROBES') ?? (FIXTURE_MODE ? [] : REAL_BUNDLE_PROBES);
const BUNDLE_BEHIND = fixtureMap('MIXSHIFT_FIGURES_BUNDLE_BEHIND') ?? (FIXTURE_MODE ? new Map() : REAL_BUNDLE_BEHIND);

const bundleNotes = []; // acknowledged staleness, printed loudly on every run
let bundleChecked = false;

if (BUNDLE_PATH) {
  for (const [id, ack] of BUNDLE_BEHIND) {
    if (!ack || typeof ack !== 'object') fail(`BUNDLE_BEHIND["${id}"] must be an object.`);
    if (typeof ack.reason !== 'string' || ack.reason.trim().length < 12) {
      fail(
        `BUNDLE_BEHIND entry "${id}" has no written reason (got ${JSON.stringify(ack.reason)}).\n` +
          '  This records that the SHIPPED bundle states a figure the service no longer\n' +
          '  serves. Write why, and what clears it, or remove the entry.',
      );
    }
    if (ack.found !== null && typeof ack.found !== 'string') {
      fail(
        `BUNDLE_BEHIND["${id}"].found must be the exact stale literal as a string, or null when\n` +
          '  the bundle carries no such restatement. Pinning it is what makes the entry\n' +
          '  self-invalidating rather than a mute button.',
      );
    }
    if (!BUNDLE_PROBES.some((p) => p.id === id)) {
      fail(`BUNDLE_BEHIND["${id}"] has no BUNDLE_PROBES entry, so nothing would ever clear it.`);
    }
  }

  if (!existsSync(BUNDLE_PATH)) {
    fail(
      `no shipped bundle at ${BUNDLE_PATH}.\n` +
        '  dist/cli.js is committed and is the artifact a customer runs. Without it this\n' +
        '  gate cannot tell whether the shipped CLI states a figure the service no longer\n' +
        '  serves, so it fails closed. Rebuild it with `npm run build` from\n' +
        '  plugins/mixshift-ai/harness/.',
    );
  }
  const bundle = readFileSync(BUNDLE_PATH, 'utf8');
  const bundleWhere = rel(resolve(BUNDLE_PATH));
  bundleChecked = true;

  for (const probe of BUNDLE_PROBES) {
    const entry = expected.get(probe.id);
    if (!entry) {
      problems.push({
        kind: 'bundle-probe-stale',
        id: probe.id,
        where: '(BUNDLE_PROBES in this script)',
        detail: `probes for a figure the lock does not carry. Remove the probe, or refresh the lock`,
      });
      continue;
    }
    const sourceAbs = join(REL_BASE, probe.source);
    if (!existsSync(sourceAbs)) {
      problems.push({
        kind: 'bundle-probe-stale',
        id: probe.id,
        where: probe.source,
        detail: 'the source file this probe describes does not exist. Update BUNDLE_PROBES',
      });
      continue;
    }
    if (!readFileSync(sourceAbs, 'utf8').includes(probe.marker)) {
      problems.push({
        kind: 'bundle-probe-stale',
        id: probe.id,
        where: probe.source,
        detail:
          `the probe marker ${JSON.stringify(probe.marker)} is no longer in the source, so this ` +
          'probe can only ever report the bundle stale. The prose was reworded: update the ' +
          'marker and pattern in BUNDLE_PROBES in the same commit',
      });
      continue;
    }

    const hit = new RegExp(probe.pattern).exec(bundle);
    const ack = BUNDLE_BEHIND.get(probe.id);

    if (!hit) {
      if (ack && ack.found === null) {
        bundleNotes.push({
          id: probe.id,
          where: bundleWhere,
          state: 'carries no such restatement at all',
          reason: ack.reason,
        });
        continue;
      }
      problems.push({
        kind: 'bundle-stale',
        id: probe.id,
        where: bundleWhere,
        detail:
          'the source states this figure and the SHIPPED BUNDLE does not carry the restatement ' +
          'at all, so the bundle predates the source. Rebuild it at the release cut ' +
          '(`npm run build` from plugins/mixshift-ai/harness/, committing dist/cli.js and ' +
          'dist/build-meta.json -- CONTRIBUTING, "Release cut"), or record it in BUNDLE_BEHIND ' +
          'with found: null and a written reason',
      });
      continue;
    }

    const shipped = hit[1];
    if (Number(shipped) === entry.value) {
      if (ack) {
        problems.push({
          kind: 'bundle-ack-stale',
          id: probe.id,
          where: '(BUNDLE_BEHIND in this script)',
          detail:
            `the bundle now states ${shipped}, which agrees with the service. The ` +
            'acknowledgement is spent: remove the BUNDLE_BEHIND entry in this commit so the ' +
            'next disagreement fails instead of being pre-excused',
        });
      }
      continue;
    }

    if (ack && ack.found === shipped) {
      bundleNotes.push({
        id: probe.id,
        where: bundleWhere,
        state: `states ${shipped}, the service serves ${entry.value}`,
        reason: ack.reason,
      });
      continue;
    }

    problems.push({
      kind: 'bundle-stale',
      id: probe.id,
      where: bundleWhere,
      detail:
        `the SHIPPED BUNDLE states ${shipped} and the service serves ${entry.value} ${entry.unit} ` +
        `as ${entry.servedAs}. A customer running the packaged CLI reads ${shipped}. The bundle ` +
        'is stale: rebuild it at the release cut (`npm run build` from ' +
        'plugins/mixshift-ai/harness/, committing dist/cli.js and dist/build-meta.json -- ' +
        'CONTRIBUTING, "Release cut"). Between releases the bundle is expected to lag, and that ' +
        `state is recorded in BUNDLE_BEHIND with the exact value and a written reason` +
        (ack ? `; this entry pins ${JSON.stringify(ack.found)}, which is not what the bundle says` : ''),
    });
  }
}

const lockLabel = relative(HARNESS_ROOT, LOCK_PATH).replace(/\\/g, '/') || LOCK_PATH;
const wantTotal = [...EXPECTED_SITES.values()].reduce((a, sites) => a + sites.length, 0);
console.log(
  `check-figures: ${expected.size} figure(s) from ${lockLabel}, ` +
    `${claims} anchored claim(s) (expected ${wantTotal}) across ${files.length} scanned file(s) ` +
    `+ ${otherFiles.length} swept, ` +
    `bundle ${bundleChecked ? `${BUNDLE_PROBES.length} probe(s), ${bundleNotes.length} known behind` : 'not checked'}, ` +
    `${problems.length} problem(s).`,
);

// Printed on EVERY run, pass or fail, and before the problem list. The whole
// point of recording a stale bundle instead of skipping dist is that it stays
// visible; a note nobody sees is the blind spot again with extra steps.
if (bundleNotes.length > 0) {
  console.error('');
  console.error('SHIPPED BUNDLE IS BEHIND THE SERVICE (recorded in BUNDLE_BEHIND, clears at the release cut):\n');
  for (const n of bundleNotes.sort((a, b) => a.id.localeCompare(b.id))) {
    console.error(`  ${n.id}`);
    console.error(`      ${n.where} ${n.state}`);
    console.error(`      ${n.reason}`);
  }
  console.error('');
}

if (problems.length === 0) process.exit(0);

const LABEL = {
  mismatch: 'Prose disagrees with the deployed service',
  'bundle-stale': 'SHIPPED BUNDLE disagrees with the deployed service',
  'bundle-ack-stale': 'BUNDLE_BEHIND acknowledgement contradicted by the bundle',
  'bundle-probe-stale': 'Bundle probe no longer describes the source',
  'site-missing': 'A declared site LOST its anchor',
  'site-undeclared': 'Anchored at a site nobody declared',
  'site-duplicate': 'Two anchors resolve to ONE declared site',
  unlabelled: 'Anchor carries no site label',
  undecided: 'Tuned figure with no anchored site or no recorded expectation',
  'unknown-id': 'Anchor names a figure the lock does not carry',
  unclosed: 'Anchor opened and never closed',
  'not-a-number': 'Anchor does not enclose a bare number',
  'stale-exemption': 'UNANCHORED exemption contradicted by a real site',
  stray: 'Anchor in a file this gate does not parse',
};
console.error('');
for (const kind of [
  'mismatch',
  'bundle-stale',
  'bundle-ack-stale',
  'bundle-probe-stale',
  'site-missing',
  'site-undeclared',
  'site-duplicate',
  'unlabelled',
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
    'A missing SITE is never fixed by deleting the site from EXPECTED_SITES to match\n' +
    'what is left. Delete it only when the prose that carried the figure is genuinely\n' +
    'gone, in the same commit that removes it.\n',
);
process.exit(1);
