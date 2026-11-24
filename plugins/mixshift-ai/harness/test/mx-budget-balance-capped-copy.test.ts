/**
 * Copy guard for mx-budget-balance's capped test (mx-ops#410, loop 410).
 *
 * Skill 0.1.0 (plugin 0.8.23) counted a campaign as capped when Amazon's
 * PercentTimeInBudget was >= 0.5. That field is the share of the last 7 days
 * the campaign stayed IN budget, so the test was inverted: campaigns with
 * budget left over qualified for RAISE, and campaigns that ran out of budget
 * missed the signal. The rule lives in SKILL.md (the model applies it to the
 * BB-02 rows; no harness code reads the field), so this test pins the text:
 *   1. Amazon's signal counts only when the normalized value is >= 0 and < 0.5;
 *      -1 and NULL are unknown and never count;
 *   2. a run holding 0-100 values is divided by 100 before the test;
 *   3. the RAISE reason and the self-review state the direction.
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
  'mx-budget-balance',
);
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const manifest = readFileSync(join(SKILL_DIR, 'skill.manifest.yaml'), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

function section(heading: string): string {
  const start = skill.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const end = skill.indexOf('\n### ', start + 1);
  return skill.slice(start, end === -1 ? undefined : end);
}

/** The `capped = ...` expression from the Step 3 code block, whitespace-flattened. */
function cappedExpression(): string {
  const classify = section('### Step 3 - Classify');
  const m = classify.match(/\ncapped\s+=([\s\S]*?)\npoor\s/);
  expect(m).not.toBeNull();
  return flat(m![1]).trim();
}

describe('mx-budget-balance: Amazon time-in-budget reads in the right direction', () => {
  it('no longer counts PercentTimeInBudget >= 0.5 as capped', () => {
    expect(skill).not.toMatch(/PercentTimeInBudget\s*>=\s*0\.5/);
    expect(cappedExpression()).not.toMatch(/>=\s*0\.5/);
  });

  it('counts Amazon\'s signal as capped only at 0 or above and below 0.5, when known', () => {
    expect(cappedExpression()).toBe(
      'days_at_cap >= cap_days OR (in_budget is known AND 0 <= in_budget < 0.5)',
    );
  });

  it('defines in_budget: -1, NULL and negatives are unknown, never zero', () => {
    const step2 = flat(section('### Step 2 - Run prefetch'));
    expect(step2).toContain('share of the last 7 days the campaign stayed IN budget');
    expect(step2).toMatch(/`-1`, NULL, or any other negative value .* `in_budget` is unknown, never zero/);
  });

  it('normalizes 0-100 values before the test', () => {
    const step2 = flat(section('### Step 2 - Run prefetch'));
    expect(step2).toMatch(/may be a 0-100 percent instead of a fraction/);
    expect(step2).toMatch(/If any known value in this run's BB-02 rows is above 1, the run holds percents: divide every known value by 100/);
    expect(step2).toMatch(/A value still above 1 after that is unknown/);
  });

  it('states the direction next to the rule, with an unknown value never making a campaign capped', () => {
    const classify = flat(section('### Step 3 - Classify'));
    expect(classify).toMatch(/a LOW value is the capped signal/);
    expect(classify).toMatch(/An unknown `in_budget` \(-1, NULL\) never makes a campaign capped/);
  });

  it('RAISE reason states the direction when Amazon\'s signal fired', () => {
    const classify = flat(section('### Step 3 - Classify'));
    expect(classify).toMatch(/When Amazon's signal fired, state its direction/);
    expect(classify).toContain('in budget only 30 percent of the last 7 days (Amazon)');
    expect(classify).toMatch(/Never write a time-in-budget value as time at cap or as time out of budget/);
  });

  it('self-review checks the direction, not only the unknown values', () => {
    const review = flat(section('### Step 8 - Self-review'));
    expect(review).toMatch(/low time in budget means capped, high means budget was left over/);
    expect(review).toMatch(/at least 0 and below 0\.5/);
    expect(review).toMatch(/0-100 values were divided by 100 first/);
    expect(review).toContain('"in budget only X percent"');
  });

  it('manifest note matches the direction', () => {
    const notes = flat(manifest);
    expect(notes).not.toMatch(/PercentTimeInBudget is a fraction and -1 means no recommendation/);
    expect(notes).toMatch(/a LOW value is the capped signal/);
  });

  it('keeps the skill and manifest versions in step', () => {
    const skillVersion = skill.match(/^\s+version: "([^"]+)"/m)?.[1];
    const manifestVersion = manifest.match(/^version: "([^"]+)"/m)?.[1];
    expect(skillVersion).toBe('0.1.1');
    expect(manifestVersion).toBe(skillVersion);
  });
});
