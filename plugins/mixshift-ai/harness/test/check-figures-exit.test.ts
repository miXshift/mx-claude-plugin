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
 * AND THE ONE THE FIRST VERSION DID NOT GUARD. Coverage was "this id is claimed
 * somewhere" plus a single repo-wide claim floor, which an adversarial review
 * drove green on the exact defect the gate exists to prevent: most figures are
 * anchored at more than one site, so deleting one site's anchors left the id
 * claimed elsewhere and the floor absorbed the loss. `fails when a figure loses
 * ONE of its several anchored sites` is that bypass, and it now exits 1.
 *
 * FIXTURE-MODE ENVELOPE. MIXSHIFT_FIGURES_SCAN_DIR is what puts the gate in
 * fixture mode; MIXSHIFT_FIGURES_EXPECTED_SITES and MIXSHIFT_FIGURES_UNANCHORED
 * are read only inside it, so the two maps a real run hard-codes can still be
 * exercised here. A test that supplies no expected-sites map gets the weaker
 * "documented at least once" rule, which is what the value-comparison and
 * fail-closed cases below actually want to assert.
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
    // told brief authors a threshold the service does not apply. Per-figure
    // counts are what close it.
    writeLock([{ id: 'oos_rate_threshold', value: 0.25 }]);
    writeDoc('SKILL.md', 'Threshold <!-- figure:oos_rate_threshold -->0.25<!-- /figure -->.');
    writeDoc('nested/report.ts', "const help = /* figure:oos_rate_threshold */ '0.25' /* /figure */;");
    const sites = { MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ oos_rate_threshold: 2 }) };
    expect(run(sites).status, 'both sites present').toBe(0);

    // Drop one site. The id is still claimed, and every remaining literal still
    // agrees with the lock.
    writeDoc('SKILL.md', 'Threshold 0.99 applies.');
    const r = run(sites);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expected 2 anchored site\(s\), found 1/);
  });

  it('fails when a new restatement is anchored without recording it', () => {
    // The same blind spot from the other direction: the count drifts up, and a
    // later deletion back down to the recorded number would pass. Exact, both
    // ways.
    writeLock([{ id: 'buybox_floor', value: 92, unit: 'percent' }]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor -->92<!-- /figure -->%.');
    writeDoc('other.md', 'Also floor <!-- figure:buybox_floor -->92<!-- /figure -->%.');
    const r = run({ MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ buybox_floor: 1 }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/expected 1 anchored site\(s\), found 2/);
  });

  it('fails on a lock figure nobody has recorded an expectation for', () => {
    // A new tuned default arrives from the gateway and the lock refresh lands
    // before anyone decides where it is documented. min_sellable_units arrived
    // exactly this way. Refusing to guess is the point.
    writeLock([
      { id: 'buybox_floor', value: 92, unit: 'percent' },
      { id: 'min_sellable_units', value: 40, unit: 'units' },
    ]);
    writeDoc('SKILL.md', 'Floor <!-- figure:buybox_floor -->92<!-- /figure -->%.');
    const r = run({ MIXSHIFT_FIGURES_EXPECTED_SITES: JSON.stringify({ buybox_floor: 1 }) });
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
