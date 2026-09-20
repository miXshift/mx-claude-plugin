/**
 * Integration tests for scripts/check-figures.mjs, spawned as a real subprocess
 * so the assertions are on actual EXIT CODES rather than on an exported
 * function. Same reason as check-catalog-drift-exit.test.ts and
 * check-named-pack-exit.test.ts: the whole value of this gate is what it does to
 * a merge when it cannot verify something, and only a real process exit proves
 * that.
 *
 * WHAT THE GATE IS FOR. It fails a merge when this plugin states a
 * service-tuned figure that the deployed gateway does not serve. That happened
 * for real in Sep 2026 (P-060 / D-056): oos_rate_threshold moved from 0.99 to
 * 0.25 and min_sellable_units 40 appeared, in a different repo with a different
 * merge queue, and the ONLY thing stopping the plugin from telling brief authors
 * the new numbers while the service still applied the old ones was a hand-typed
 * [HOLD] in a PR title.
 *
 * WHY NO OTHER CHECK CATCHES IT. The deployed named-query pack manifest is
 * {schema_version, ids} with no param schema, so check-named-pack passes either
 * way. The battery revision hash folds the contract version and the statement
 * text but never the params schema, so the default could move without changing a
 * single byte on the wire.
 *
 * THE FAILURE MODE THIS SUITE GUARDS. The truth is vendored, not computed, so
 * the tempting "simplification" is to treat a missing or unreadable lock as
 * nothing-to-check and exit 0. That turns the gate into a permanent green tick
 * that certifies nothing. The `fails closed` tests below are the load-bearing
 * ones here, and `replays the real P-060 skew` is the test that proves the gate
 * would have caught the defect it was built for.
 *
 * AND THE TWO THE EARLIER VERSIONS DID NOT GUARD, both found by adversarial
 * review driving the gate green on the exact defect it exists to prevent:
 *
 *   1. Coverage was "this id is claimed somewhere" plus a single repo-wide claim
 *      floor. Most figures are anchored at more than one site, so deleting one
 *      site's anchors left the id claimed elsewhere and the floor absorbed the
 *      loss. `fails when a figure loses ONE of its several anchored sites`.
 *   2. The floor became a per-figure COUNT, which narrowed the hole rather than
 *      closing it: a count never says WHICH prose carries the anchors, so a real
 *      site could lose its anchor and be made whole in the same commit by a
 *      second anchor on an already-covered line, or by a file nobody reads. The
 *      `check-figures declared sites` block replays both, and the expectation is
 *      now a declared list of `<path>#<label>` sites matched exactly once each.
 *
 * AND THE ARTIFACT NOBODY WAS READING. dist/ was in SKIP_DIRS, so the gate never
 * saw the bundle a customer actually executes -- with a live instance of its own
 * defect sitting in the blind spot. `check-figures shipped bundle` covers that
 * stage.
 *
 * FIXTURE-MODE ENVELOPE. MIXSHIFT_FIGURES_SCAN_DIR is what puts the gate in
 * fixture mode; MIXSHIFT_FIGURES_EXPECTED_SITES, MIXSHIFT_FIGURES_UNANCHORED,
 * MIXSHIFT_FIGURES_BUNDLE, MIXSHIFT_FIGURES_BUNDLE_PROBES and
 * MIXSHIFT_FIGURES_BUNDLE_BEHIND are read only inside it, so the maps a real run
 * hard-codes can still be exercised here. A test that supplies no expected-sites
 * map gets the weaker "documented at least once" rule, which is what the
 * value-comparison and fail-closed cases below actually want to assert, and one
 * that supplies no bundle skips the bundle stage entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-figures.mjs');

let root: string;
let scanDir: string;
let lockPath: string;

type Figure = {
  id: string;
  value: unknown;
  unit?: string;
  servedAs?: string;
  source?: string;
};

function writeLock(figures: Figure[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    lockPath,
    JSON.stringify({
      schema_version: 1,
      generator: 'test fixture',
      figures: figures.map((f) => ({
        unit: 'rate',
        servedAs: `thresholds_applied.${f.id}`,
        source: 'fixture: established by writing it down in a test',
        ...f,
      })),
      ...extra,
    }),
    'utf8',
  );
}

function writeDoc(name: string, body: string): void {
  const p = join(scanDir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, 'utf8');
}

function run(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIXSHIFT_FIGURES_SCAN_DIR: scanDir,
      MIXSHIFT_FIGURES_LOCK: lockPath,
      ...env,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'figures-'));
  scanDir = join(root, 'docs');
  lockPath = join(root, 'figures.lock.json');
  mkdirSync(scanDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-figures exit codes', () => {
  it('exits 0 when every anchored literal equals the lock', () => {
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure --> applies.');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 problem(s)');
  });

  it('replays the real P-060 skew: prose ahead of the deployed service', () => {
    // The exact shape of the defect. The docs say 0.25 (the new calibrated
    // rate); the service, until its own PR deploys, still serves 0.99. Every
    // other gate in the repo passes on this input.
    writeLock([{ id: 'oos_rate_threshold', value: 0.99 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure --> applies.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('prose says 0.25, the service serves 0.99');
    // The path and line are what make it actionable: a bare id sends the reader
    // hunting through two repos.
    expect(r.stderr).toMatch(/SKILL\.md:1/);
  });

  it('names the file and line for EVERY site, not just the first', () => {
    // Six numbers are restated ten times across two trees. Reporting one and
    // stopping would send someone back round the loop for each remaining copy.
    writeLock([{ id: 'buybox_floor', value: 92 }]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor -->90<!-- /figure -->%.');
    writeDoc('nested/report.ts', "const help = /* figure:buybox_floor */ '91' /* /figure */;");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SKILL.md');
    expect(r.stderr).toContain('report.ts');
  });

  it('reads a quoted TypeScript literal the same as a bare Markdown one', () => {
    // The --help sites enclose a string literal because that is what commander
    // takes; the Markdown sites enclose the bare number. One grammar, both hosts.
    writeLock([{ id: 'buybox_drop', value: 5 }]);
    writeDoc('report.ts', ".option('--buybox-drop <pts>', 'text', /* figure:buybox_drop */ '5' /* /figure */)");
    expect(run().status).toBe(0);
  });

  it('fails closed when the lock is missing', () => {
    // THE load-bearing case: unverifiable must never read as verified-clean.
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run({ MIXSHIFT_FIGURES_LOCK: join(root, 'does-not-exist.json') });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no figures lock/i);
  });

  it('fails closed when the lock is not valid JSON', () => {
    writeFileSync(lockPath, '{ not json', 'utf8');
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not valid JSON/i);
  });

  it('fails closed on an unrecognised schema_version rather than guessing', () => {
    // The generator lives in the other repo. If its shape moves, this gate must
    // stop and be updated deliberately, not keep reporting green off a file it
    // no longer understands.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }], { schema_version: 2 });
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/schema_version/i);
  });

  it('fails closed when the lock carries no figures', () => {
    // An empty lock makes every doc trivially "agree". That is the green tick
    // that certifies nothing, arriving by way of a generator bug.
    writeLock([]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no figures\[\] entries/i);
  });

  it('rejects a stringified value in the lock', () => {
    // "0.25" would compare fine today and silently stop comparing the day the
    // generator emits "0.250". Reject it at the door instead.
    writeLock([{ id: 'oos_rate_threshold', value: '0.25' }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/finite NUMBER/i);
  });

  it('requires every figure to say how it was established', () => {
    // The standing rule, enforced at the contract boundary. An empty source
    // reads as "measured" to the next person; "NO RECORDED BASIS" is the
    // honest answer and passes.
    writeLock([{ id: 'buybox_floor', value: 92, source: '' }]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor -->92<!-- /figure -->%.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/how the value was established/i);

    writeLock([{ id: 'buybox_floor', value: 92, source: 'NO RECORDED BASIS' }]);
    expect(run().status, 'an explicitly absent basis is a valid answer').toBe(0);
  });

  it('fails when a figure loses ONE of its several anchored sites', () => {
    // THE BYPASS THE FIRST VERSION OF THIS GATE HAD, and the reason the global
    // floor is gone. Coverage used to be "this id is claimed somewhere" plus one
    // repo-wide floor. Four of the six real figures are anchored at more than
    // one site, so deleting one site's anchors left the id claimed elsewhere and
    // the floor absorbed the loss: reverting the SKILL.md threshold paragraph to
    // the pre-P-060 values and dropping those anchors exited 0 while the skill
    // told brief authors a threshold the service does not apply.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold@thresholds -->0.25<!-- /figure -->.');
    writeDoc('nested/report.ts', "const help = /* figure:oos_rate_threshold@help */ '0.25' /* /figure */;");
    const sites = {
      MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({
        oos_rate_threshold: ['SKILL.md#thresholds', 'nested/report.ts#help'],
      }),
    };
    expect(run(sites).status, 'both sites present').toBe(0);

    // Drop one site. The id is still claimed, and every remaining literal still
    // agrees with the lock.
    writeDoc('SKILL.md', 'Threshold 0.99 applies.');
    const r = run(sites);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/declared site LOST its anchor/i);
    expect(r.stderr).toContain('SKILL.md#thresholds');
  });

  it('fails when a new restatement is anchored without recording it', () => {
    // The same blind spot from the other direction: an unrecorded site drifts
    // in, and a later deletion of a real one would then be absorbed.
    writeLock([{ id: 'buybox_floor', value: 92, unit: 'percent' }]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor@thresholds -->92<!-- /figure -->%.');
    writeDoc('other.md', 'Also floor <!-- figure:buybox_floor@elsewhere -->92<!-- /figure -->%.');
    const r = run({
      MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ buybox_floor: ['SKILL.md#thresholds'] }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/site nobody declared/i);
    expect(r.stderr).toContain('other.md#elsewhere');
  });

  it('fails on a lock figure nobody has recorded an expectation for', () => {
    // A new tuned default arrives from the gateway and the lock refresh lands
    // before anyone decides where it is documented. min_sellable_units arrived
    // exactly this way. Refusing to guess is the point.
    writeLock([
      { id: 'buybox_floor', value: 92, unit: 'percent' },
      { id: 'min_sellable_units', value: 40, unit: 'units' },
    ]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor@thresholds -->92<!-- /figure -->%.');
    const r = run({
      MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ buybox_floor: ['SKILL.md#thresholds'] }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('min_sellable_units');
    expect(r.stderr).toMatch(/no expectation for it/i);
  });

  it('rejects an UNANCHORED exemption with no written reason', () => {
    // The escape hatch used to test key presence only, so an empty string
    // silenced a figure the service tunes and customers see. A reason has to be
    // written, to the same bar `source` is held to.
    writeLock([{ id: 'buybox_floor', value: 92, unit: 'percent' }]);
    writeDoc('SKILL.md', 'Floor 92% is not anchored anywhere.');
    const empty = run({ MIXSHIFT_FIGURES_UNANCHORED: JSON.stringify({ buybox_floor: '' }) });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/no written reason/i);

    const gestured = run({ MIXSHIFT_FIGURES_UNANCHORED: JSON.stringify({ buybox_floor: 'n/a' }) });
    expect(gestured.status, 'a token non-answer is not a reason either').toBe(1);

    const real = run({
      MIXSHIFT_FIGURES_UNANCHORED: JSON.stringify({
        buybox_floor: 'internal-only knob, never quoted in customer-facing prose',
      }),
    });
    expect(real.status, 'a written reason is a valid answer').toBe(0);
  });

  it('fails when an UNANCHORED exemption is contradicted by a real site', () => {
    // A stale exemption is the same hazard one step later: the prose came back
    // and nobody removed the silence.
    writeLock([{ id: 'buybox_floor', value: 92, unit: 'percent' }]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor -->92<!-- /figure -->%.');
    const r = run({
      MIXSHIFT_FIGURES_UNANCHORED: JSON.stringify({
        buybox_floor: 'internal-only knob, never quoted in customer-facing prose',
      }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/exempted as never quoted/i);
  });

  it('fails on an anchor hiding in a file type the main pass does not parse', () => {
    // False coverage in its purest form: the author believes the figure is
    // gated, the anchor sits in a file this gate cannot read as prose, and the
    // summary still says "0 problem(s)". The sweep makes it loud instead.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    writeDoc('notes.rst', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not parse/i);
    expect(r.stderr).toContain('notes.rst');
  });

  it('fails closed when the scan root does not exist', () => {
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    const r = run({ MIXSHIFT_FIGURES_SCAN_DIR: join(root, 'nope') });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/scan root not found/i);
  });

  it('catches a tuned figure that no prose site documents', () => {
    // The other direction of drift, and the one a value comparison alone misses:
    // the gateway starts serving a new customer-visible default and the docs
    // never mention it. min_sellable_units arrived exactly this way.
    writeLock([
      { id: 'oos_rate_threshold', value: 0.25 },
      { id: 'min_sellable_units', value: 40, unit: 'units' },
    ]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('min_sellable_units');
    expect(r.stderr).toMatch(/no anchored prose site quotes it|no expectation for it/i);
  });

  it('catches an anchor naming a figure the lock does not carry', () => {
    // A typo in the anchor, or a lock that was never refreshed after the
    // gateway retired a param. Either way the doc is making a claim nobody can
    // verify, which must not read as agreement.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc(
      'SKILL.md',
      'A <!-- figure:oos_rate_threshold -->0.25<!-- /figure --> and <!-- figure:oos_rate_treshold -->0.25<!-- /figure -->.',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('oos_rate_treshold');
  });

  it('catches an anchor that opened and never closed', () => {
    // Without this the claim vanishes silently and the run still reports clean,
    // which is how a gate rots into a formality.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25 applies everywhere.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/never closed/i);
  });

  it('will not let a mistyped close anchor bind a literal from another line', () => {
    // The false-pass hazard, and the only outcome worse than a false failure: a
    // greedy match would run past the broken close, pick up the NEXT anchor's
    // number and certify it against the wrong id.
    writeLock([
      { id: 'oos_rate_threshold', value: 0.25 },
      { id: 'buybox_floor', value: 92, unit: 'percent' },
    ]);
    writeDoc(
      'SKILL.md',
      [
        'Rate <!-- figure:oos_rate_threshold -->0.25 with no close here.',
        'Floor <!-- figure:buybox_floor -->92<!-- /figure -->%.',
      ].join('\n'),
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/never closed/i);
    // And specifically NOT reported as a clean pass on the rate.
    expect(r.stdout).not.toContain('0 problem(s)');
  });

  it('ignores numbers that are not anchored, including near-miss ones', () => {
    // The whole design rests on this. The --min-sellable-units help text states
    // 40 (live), 0.99 and 1 (the values that restore the pre-2026-09 rule) and a
    // 2026 date; rules-provenance.md prints 0.25 and 40 dozens of times as
    // measured grid cells. A find-every-number gate would flag all of it every
    // run, and a gate people wave through is worse than no gate.
    writeLock([{ id: 'min_sellable_units', value: 40, unit: 'units' }]);
    writeDoc(
      'report.ts',
      "'...(default ' + /* figure:min_sellable_units */ '40' /* /figure */ + " +
        "' on the service; 1 together with --oos-rate-threshold 0.99 restores the pre-2026-09 rule)'",
    );
    writeDoc('rules-provenance.md', 'Rate grid at floor 40: 0.20 -> 2 / 16; 0.25 -> 1 / 16; 0.99 -> 5 / 0.');
    expect(run().status).toBe(0);
  });

  it('rejects an anchor that encloses something other than a bare number', () => {
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->about a quarter<!-- /figure -->.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a bare numeric literal/i);
  });
});

/**
 * THE BAG-COUNT BYPASS, and why the expectation is a declared list of SITES
 * rather than a number.
 *
 * Version two of this gate held each figure to a per-figure COUNT of anchored
 * claims. A count says how many anchors exist and never which prose carries
 * them, so the SAME move that broke version one's global floor still worked one
 * level down: drop the anchor on a real restatement and add one anywhere else in
 * the same commit, and the count is whole while the restatement a customer reads
 * is no longer compared to anything. Both of the cheap ways to do that are
 * replayed here, and both now exit 1.
 */
describe('check-figures declared sites', () => {
  const TWO_SITES = {
    MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({
      oos_rate_threshold: ['SKILL.md#thresholds', 'SKILL.md#knobs'],
    }),
  };

  function writeBothSites(): void {
    writeDoc(
      'SKILL.md',
      [
        'Threshold <!-- figure:oos_rate_threshold@thresholds -->0.25<!-- /figure --> applies.',
        'Knobs: <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure --> by default.',
      ].join('\n'),
    );
  }

  beforeEach(() => {
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeBothSites();
  });

  it('passes when every declared site is anchored exactly once', () => {
    expect(run(TWO_SITES).status).toBe(0);
  });

  it('a SECOND anchor on an already-covered line cannot make a lost site whole', () => {
    // The bag-count bypass, replayed verbatim. The threshold sentence reverts to
    // the pre-P-060 value and loses its anchor; the knobs line picks up a second
    // anchor carrying the same label. Two anchors, two claims: a count is whole
    // and exits 0 while the sentence a brief author reads says 0.99.
    writeDoc(
      'SKILL.md',
      [
        'Threshold 0.99 applies.',
        'Knobs: <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure --> by default, ' +
          'or <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure --> again.',
      ].join('\n'),
    );
    const r = run(TWO_SITES);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/declared site LOST its anchor/i);
    expect(r.stderr).toContain('SKILL.md#thresholds');
    // And the doubling itself is named, not just the shortfall.
    expect(r.stderr).toMatch(/Two anchors resolve to ONE declared site/i);
  });

  it('a throwaway file cannot make a lost site whole either', () => {
    // The other half of the same move: the compensating anchor goes somewhere
    // nobody reads. The count is whole; the site is gone, and the file that
    // covered for it is named.
    writeDoc('SKILL.md', 'Threshold 0.99 applies.\nKnobs: <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure -->.');
    writeDoc('scratch/notes.md', 'Bookkeeping <!-- figure:oos_rate_threshold@thresholds -->0.25<!-- /figure -->.');
    const r = run(TWO_SITES);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SKILL.md#thresholds');
    expect(r.stderr).toMatch(/site nobody declared/i);
    expect(r.stderr).toContain('scratch/notes.md#thresholds');
  });

  it('names the site that went missing, so the fix is not a hunt', () => {
    writeDoc('SKILL.md', 'Threshold 0.99 applies.\nKnobs: <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure -->.');
    const r = run(TWO_SITES);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SKILL.md#thresholds');
    expect(r.stderr).not.toContain('SKILL.md#knobs');
  });

  it('reports an unlabelled anchor instead of silently not counting it', () => {
    // Without this an anchor written in the old grammar matches no declared site
    // and the failure reads as "the prose is gone" when the prose is right
    // there, which is how a real fix gets applied to the wrong thing.
    writeDoc(
      'SKILL.md',
      [
        'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure --> applies.',
        'Knobs: <!-- figure:oos_rate_threshold@knobs -->0.25<!-- /figure --> by default.',
      ].join('\n'),
    );
    const r = run(TWO_SITES);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no site label/i);
  });

  it('rejects a bare count in place of a site list', () => {
    // The shape the gate used to take. Accepting it silently would restore the
    // bypass for any figure whose entry was left behind.
    const r = run({ MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ oos_rate_threshold: 2 }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be a non-empty ARRAY/i);
  });
});

/**
 * THE SHIPPED BUNDLE. dist/ was in SKIP_DIRS, so the gate never read the one
 * artifact a customer actually executes, and the blind spot had a live defect
 * sitting in it: the committed 0.8.13 bundle prints
 * `--oos-rate-threshold ... (default 0.99 on the service)` while the service has
 * served 0.25 since 2026-09-14, with every gate in the repo green over it.
 *
 * The bundle is rebuilt only at the release cut (CONTRIBUTING, "dist/ is
 * release-time, not PR-time"), so between releases it legitimately lags. That
 * state is RECORDED, pinned to the exact stale value, never skipped: an
 * unrecorded disagreement fails, a different stale value fails, and the
 * recording expires the moment the rebuild makes the bundle agree.
 */
describe('check-figures shipped bundle', () => {
  let bundlePath: string;

  const PROBES = JSON.stringify([
    {
      id: 'oos_rate_threshold',
      source: 'report.ts',
      marker: 'counts as out of stock (default ',
      pattern: 'counts as out of stock \\(default ([\\d.]+) on the service\\)',
    },
  ]);

  function writeBundle(body: string): void {
    writeFileSync(bundlePath, body, 'utf8');
  }

  beforeEach(() => {
    bundlePath = join(root, 'cli.js');
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    // Stands in for the --help string in report.ts: the probe's marker has to be
    // in the SOURCE, or the probe is stale rather than the bundle.
    writeDoc('report.ts', "'...counts as out of stock (default ' + rate + ' on the service)'");
  });

  it('fails when the shipped bundle states a figure the service no longer serves', () => {
    // The live defect, reproduced. Source and docs agree with the lock; only the
    // committed bundle is behind, and it is the bundle a customer runs.
    writeBundle('x("counts as out of stock (default 0.99 on the service)")');
    const r = run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SHIPPED BUNDLE disagrees/i);
    expect(r.stderr).toContain('states 0.99 and the service serves 0.25');
    // The error has to name the step that fixes it, or it just reads as noise
    // to whoever hits it on an unrelated PR.
    expect(r.stderr).toMatch(/npm run build/);
    expect(r.stderr).toMatch(/release cut/i);
  });

  it('fails when the bundle carries no restatement at all', () => {
    // How the real min_sellable_units case looks: the option is in the source
    // and simply absent from a bundle cut before it existed.
    writeBundle('x("some other help text entirely")');
    const r = run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not carry the restatement/i);
  });

  it('a recorded stale bundle is loud but not fatal', () => {
    writeBundle('x("counts as out of stock (default 0.99 on the service)")');
    const r = run({
      MIXSHIFT_FIGURES_BUNDLE: bundlePath,
      MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES,
      MIXSHIFT_FIGURES_BUNDLE_BEHIND: JSON.stringify({
        oos_rate_threshold: { found: '0.99', reason: 'bundle predates the deploy; clears at the release cut' },
      }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/SHIPPED BUNDLE IS BEHIND THE SERVICE/);
    expect(r.stderr).toContain('states 0.99');
  });

  it('a recording pinned to a DIFFERENT value does not cover a new skew', () => {
    // The pin is what stops the entry becoming a mute button: it excuses one
    // known value, not "whatever the bundle happens to say".
    writeBundle('x("counts as out of stock (default 0.5 on the service)")');
    const r = run({
      MIXSHIFT_FIGURES_BUNDLE: bundlePath,
      MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES,
      MIXSHIFT_FIGURES_BUNDLE_BEHIND: JSON.stringify({
        oos_rate_threshold: { found: '0.99', reason: 'bundle predates the deploy; clears at the release cut' },
      }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/which is not what the bundle says/);
  });

  it('the recording expires the moment the rebuild makes the bundle agree', () => {
    // Otherwise the release cut leaves a pre-signed excuse behind for the NEXT
    // skew. The gate forces it to be cleared in the commit that rebuilds dist.
    writeBundle('x("counts as out of stock (default 0.25 on the service)")');
    const r = run({
      MIXSHIFT_FIGURES_BUNDLE: bundlePath,
      MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES,
      MIXSHIFT_FIGURES_BUNDLE_BEHIND: JSON.stringify({
        oos_rate_threshold: { found: '0.99', reason: 'bundle predates the deploy; clears at the release cut' },
      }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/acknowledgement is spent/i);
  });

  it('rejects a recording with no written reason', () => {
    writeBundle('x("counts as out of stock (default 0.99 on the service)")');
    const r = run({
      MIXSHIFT_FIGURES_BUNDLE: bundlePath,
      MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES,
      MIXSHIFT_FIGURES_BUNDLE_BEHIND: JSON.stringify({ oos_rate_threshold: { found: '0.99', reason: 'n/a' } }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no written reason/i);
  });

  it('reads the default whether or not the bundler kept the anchor comment', () => {
    // A REAL defect, caught by building dist and re-running the gate rather than
    // by reasoning about esbuild. It keeps the anchor comment between an
    // option's description and its default where it does not fold a string
    // concatenation, and the 0.8.13 bundle predates the anchors entirely, so a
    // pattern written against either shape reports the other one stale. That is
    // a false failure on an unrelated PR, which is how a gate gets waved through.
    const probes = JSON.stringify([
      {
        id: 'oos_rate_threshold',
        source: 'report.ts',
        marker: 'counts as out of stock (default ',
        pattern: '"--oos-rate-threshold <rate>",\\s*"[^"]*",\\s*(?:/\\*[^*]*\\*/\\s*)?"([\\d.]+)"',
      },
    ]);
    const withComment =
      '.option(\n  "--oos-rate-threshold <rate>",\n  "help",\n  /* figure:oos_rate_threshold@harness-help-oos-rate */\n  "0.25"\n)';
    const withoutComment = '.option("--oos-rate-threshold <rate>", "help", "0.25")';

    writeBundle(withComment);
    expect(run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: probes }).status).toBe(0);

    writeBundle(withoutComment);
    expect(run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: probes }).status).toBe(0);

    // And it is still reading the number, not just matching the shape.
    writeBundle(withComment.replace('"0.25"', '"0.99"'));
    const skewed = run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: probes });
    expect(skewed.status).toBe(1);
    expect(skewed.stderr).toContain('states 0.99 and the service serves 0.25');
  });

  it('fails when the probe no longer describes the source', () => {
    // A probe that matches nothing in the source can only ever report the bundle
    // stale, which is a false failure that teaches people to ignore this gate.
    // Reworded help text has to be met with a reworded probe.
    writeDoc('report.ts', "'...the help text was rewritten and the probe was not'");
    writeBundle('x("counts as out of stock (default 0.25 on the service)")');
    const r = run({ MIXSHIFT_FIGURES_BUNDLE: bundlePath, MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no longer describes the source/i);
  });

  it('fails closed when the shipped bundle is missing', () => {
    const r = run({
      MIXSHIFT_FIGURES_BUNDLE: join(root, 'no-such-bundle.js'),
      MIXSHIFT_FIGURES_BUNDLE_PROBES: PROBES,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no shipped bundle/i);
  });
});
