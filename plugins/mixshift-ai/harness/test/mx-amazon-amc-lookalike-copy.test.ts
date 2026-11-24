/**
 * Copy guard for the mx-amazon-amc skill's Lookalike audiences section
 * (mx-ops#263). Skill 0.6.0 (plugin 0.8.23) was written from Amazon's spec
 * before any lookalike had been created through MixShift, so it called the
 * string form of timeWindowRelative "not yet confirmed on a lookalike" and said
 * nothing about what Amazon fills in. The first production lookalike showed
 * three things, and the skill now states them:
 *   1. timeWindowRelative "TRUE" is accepted on a lookalike;
 *   2. Amazon sets refreshRateDays to 7 by default (it reads back as 7 even
 *      when the create left it out);
 *   3. Amazon stores the name with the prefix "AMC ".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'mx-amazon-amc',
);
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const manifest = readFileSync(join(SKILL_DIR, 'skill.manifest.yaml'), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

// The Lookalike section runs from its heading to the next "### " heading
// (the line-item swap is a "#### " subsection inside it).
function lookalikeSection(): string {
  const start = skill.indexOf('### Lookalike audiences');
  expect(start).toBeGreaterThan(-1);
  const end = skill.indexOf('\n### ', start + 1);
  return flat(skill.slice(start, end === -1 ? undefined : end));
}

describe('mx-amazon-amc lookalike copy: behaviors observed in production', () => {
  it('no longer calls timeWindowRelative unconfirmed on a lookalike', () => {
    expect(flat(skill)).not.toMatch(/not yet confirmed on a lookalike/i);
  });

  it('says Amazon accepted timeWindowRelative "TRUE" on a lookalike', () => {
    expect(lookalikeSection()).toMatch(
      /Amazon accepted `"TRUE"` on a lookalike in production/,
    );
  });

  it('says Amazon sets refreshRateDays to 7 by default, and it is not the user setting', () => {
    const s = lookalikeSection();
    expect(s).toContain('`refreshRateDays: 7`');
    expect(s).toMatch(/Amazon sets 7 by default/);
    expect(s).toMatch(/do not report it as a setting the user chose/);
  });

  it('says the stored name gets the prefix "AMC " and how to handle it', () => {
    const s = lookalikeSection();
    expect(s).toMatch(/Amazon stores the name with `AMC ` in front/);
    expect(s).toContain('"AMC High-value buyers lookalike"');
    expect(s).toMatch(/do not start the name with "AMC" yourself/);
    expect(s).toMatch(/match the stored name with the prefix, or match by `audienceExecutionId`/);
  });

  it('labels the three as observed, not from the spec', () => {
    expect(lookalikeSection()).toMatch(
      /observed on the first lookalike created in production through MixShift, not taken from (the )?Amazon('s)? spec/,
    );
  });

  it('example body name does not start with AMC (it would read back doubled)', () => {
    const names = [...skill.matchAll(/"audienceName":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).not.toMatch(/^AMC\b/);
  });

  it('keeps the skill and manifest versions in step', () => {
    const skillVersion = skill.match(/^\s+version: "([^"]+)"/m)?.[1];
    const manifestVersion = manifest.match(/^version: "([^"]+)"/m)?.[1];
    expect(skillVersion).toBe('0.6.1');
    expect(manifestVersion).toBe(skillVersion);
  });
});
