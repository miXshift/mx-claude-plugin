/**
 * Integration tests for scripts/check-catalog-drift.mjs, spawned as a real
 * subprocess so the assertions are on actual EXIT CODES rather than on an
 * exported function. That matters here for the same reason it does in
 * check-named-pack-exit.test.ts: the whole value of this gate is what it does
 * to a release when it cannot verify something, and only a real process exit
 * proves that.
 *
 * WHAT THE GATE IS FOR. It fails a release when a shipped skill names an
 * Amazon operation id the catalog does not have. That went unnoticed for weeks
 * in Aug 2026, and no other check could have caught it: the plugin CLI refuses
 * an uncataloged operation id BEFORE it issues any request, so a doc promising
 * a capability we lack produces zero failed calls and zero telemetry. Two
 * users built real plans against ids that did not exist and hand-keyed the
 * result into Amazon's console instead.
 *
 * THE FAILURE MODE THIS SUITE GUARDS. The catalog is owned by the service and
 * lives outside this repo, so the gate has to be pointed at it. The tempting
 * "simplification" is to treat a missing catalog as nothing-to-check and exit 0,
 * which would turn a release gate into a permanent green tick that certifies
 * nothing — the exact anti-pattern check-named-pack's header warns about. The
 * two `fails closed` tests below are therefore the load-bearing ones here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-catalog-drift.mjs',
);

let root: string;
let catalogDir: string;
let skillsDir: string;

/** Minimal stand-in for the service's ads-operations.ts catalog source. */
function writeCatalog(ids: string[]): void {
  const entries = ids.map((id) => `  { id: '${id}', method: 'POST' },`).join('\n');
  writeFileSync(
    join(catalogDir, 'ads-operations.ts'),
    `export const ADS_OPERATIONS = [\n${entries}\n];\n`,
    'utf8',
  );
}

function writeSkill(name: string, body: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function run(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, MIXSHIFT_CATALOG_DIR: catalogDir, MIXSHIFT_SKILLS_DIR: skillsDir, ...env },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'drift-'));
  catalogDir = join(root, 'amazon');
  skillsDir = join(root, 'skills');
  mkdirSync(catalogDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('check-catalog-drift exit codes', () => {
  it('exits 0 when every operation a skill names exists', () => {
    writeCatalog(['sb.create_targets', 'sp.create_campaigns']);
    writeSkill('mx-amazon-ads', 'Use `sb.create_targets` and then `sp.create_campaigns`.');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 missing');
  });

  it('exits 1 and names the operation AND the file when a skill claims one that does not exist', () => {
    writeCatalog(['sb.create_targets']);
    writeSkill('mx-amazon-ads', 'Create the ad with `sb.create_ads`.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sb.create_ads');
    // The path is what makes the failure actionable; a bare id sends the
    // reader hunting through 27 skills.
    expect(r.stderr).toContain('mx-amazon-ads/SKILL.md');
  });

  it('fails closed when the catalog path is wrong', () => {
    // THE load-bearing case: unverifiable must never read as verified-clean.
    writeSkill('mx-amazon-ads', 'Anything at all.');
    const r = run({ MIXSHIFT_CATALOG_DIR: join(root, 'does-not-exist') });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not exist/i);
  });

  it('fails closed when the catalog location was never configured', () => {
    // The same case arriving by omission rather than by typo, and the likelier
    // one in practice: someone runs the gate without setting the variable. It
    // must not read as "nothing to check".
    writeSkill('mx-amazon-ads', 'Uses `sb.create_ads`.');
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: (() => {
        const e = { ...process.env, MIXSHIFT_SKILLS_DIR: skillsDir };
        delete e.MIXSHIFT_CATALOG_DIR;
        return e;
      })(),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not set/i);
  });

  it('fails closed when the catalog directory exists but yields no operation ids', () => {
    // A renamed catalog file or a changed entry shape would otherwise produce
    // an empty id set, against which EVERY skill reference looks like drift —
    // or, if the comparison were inverted, none would. Refuse to guess.
    writeSkill('mx-amazon-ads', 'Uses `sb.create_targets`.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no operation ids/i);
  });

  it('ignores dotted tokens that are not operation ids', () => {
    // `catalog` and `reporting` are real catalog namespaces AND ordinary
    // English, so namespace filtering alone cannot separate an operation id
    // from a filename or a config key. The allowlist is the only escape
    // hatch, which is why every entry in it carries a reason.
    writeCatalog(['catalog.search_items', 'reporting.create_report']);
    writeSkill(
      'mx-amazon-report',
      'Propose a new `catalog.yaml` entry, and set `reporting.audience` in context.',
    );
    const r = run();
    expect(r.status).toBe(0);
  });

  it('ignores bare prose but CATCHES a runnable command in a fenced block', () => {
    // Two halves of one rule. Prose mentioning an operation is not a promise,
    // and flagging it would train people to ignore the gate. But a
    // copy-pasteable command IS the strongest promise the docs can make, and
    // matching only backticks missed every one of them -- the original defect
    // (`sb.create_ads`) was caught only because it happened to be written
    // inline. Had it been written as a fenced example, this gate would have
    // passed it.
    writeCatalog(['sb.create_targets']);
    writeSkill('mx-amazon-ads', 'There is no sb.create_ads operation yet; use `sb.create_targets`.');
    expect(run().status, 'bare prose is not a claim').toBe(0);

    writeSkill(
      'mx-amazon-ads',
      ['Run it:', '', '```bash', 'mixshift ads call sb.create_ads --commit', '```'].join('\n'),
    );
    const r = run();
    expect(r.status, 'a runnable command IS a claim').toBe(1);
    expect(r.stderr).toContain('sb.create_ads');
  });

  it('does not count a commented-out catalog entry as a live capability', () => {
    // Commenting an entry out is the likeliest way an operation gets retired.
    // A raw regex over the source keeps counting it, so the gate would certify
    // a capability the service refuses at runtime -- the exact case it exists
    // to catch, inverted.
    writeFileSync(
      join(catalogDir, 'ads-operations.ts'),
      [
        'export const ADS_OPERATIONS = [',
        "  { id: 'sb.create_targets', method: 'POST' },",
        "  // { id: 'sb.create_ads', method: 'POST' },  // DISABLED: endpoint retired",
        '];',
        "/* { id: 'sb.create_video_ads' } */",
      ].join('\n'),
      'utf8',
    );
    writeSkill('mx-amazon-ads', 'Use `sb.create_ads` and `sb.create_video_ads`.');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sb.create_ads');
    expect(r.stderr).toContain('sb.create_video_ads');
  });

  it('fails closed when the docs side yields too few claims to be a real check', () => {
    // The mirror of the catalog-side guard, and the one that was missing: an
    // empty or mis-pointed skills dir reported "0 missing" and exited 0. A
    // partially-loaded catalog lands in the same place, because the namespace
    // filter silently drops every reference belonging to a file that was not
    // read. Both mean "not fully compared", never "they agree".
    writeCatalog(['sb.create_targets']);
    writeSkill('mx-amazon-ads', 'Uses `sb.create_targets`.');
    const r = run({ MIXSHIFT_DRIFT_MIN_CLAIMS: '40' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/below the floor/i);
  });

  it('reads operation ids out of skill manifests, not just markdown', () => {
    // skill.manifest.yaml lists harness_commands naming operation ids. Those
    // are capability claims that the docs gate never looked at.
    writeCatalog(['sb.create_targets']);
    const dir = join(skillsDir, 'mx-amazon-ads');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'See the manifest.', 'utf8');
    writeFileSync(
      join(dir, 'skill.manifest.yaml'),
      ['harness_commands:', '  - mixshift ads call sb.create_ads --commit'].join('\n'),
      'utf8',
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('skill.manifest.yaml');
  });

  it('scans nested skill docs, not just top-level SKILL.md', () => {
    writeCatalog(['sb.create_targets']);
    const nested = join(skillsDir, 'mx-amazon-ads', 'reference');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'examples.md'), 'Call `sb.create_ads` here.', 'utf8');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('sb.create_ads');
  });
});
