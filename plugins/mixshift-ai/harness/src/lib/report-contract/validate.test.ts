import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReportData } from './validate.js';
import type {
  ReportDataDocument,
  Finding,
  Figure,
  Derived,
  Claim,
  Section,
} from './validate.js';

/**
 * Acceptance semantics mirror mpr-v2's run_fixtures.py: every fixture JSON
 * carries "_expected" — an empty/absent list means the validator must find
 * NOTHING, a non-empty list means EVERY listed rule id must fire (extra
 * findings are tolerated, but reported so a change in generosity is visible
 * rather than silently masked).
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

interface FixtureDoc extends ReportDataDocument {
  _note?: string;
  _expected?: string[];
}

function loadFixture(path: string): FixtureDoc {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureDoc;
}

function ruleSet(findings: Finding[]): Set<string> {
  return new Set(findings.map((f) => f.rule));
}

describe('report-contract fixtures (golden + negative, run_fixtures.py semantics)', () => {
  const goldenPath = join(fixturesDir, 'golden-minimal.json');
  it(`golden-minimal.json produces zero findings`, () => {
    const doc = loadFixture(goldenPath);
    const expected = new Set(doc._expected ?? []);
    expect(expected.size).toBe(0); // sanity: golden fixture declares no expected rules
    const found = validateReportData(doc);
    expect(found, `expected CLEAN, found: ${JSON.stringify(found)}`).toEqual([]);
  });

  const negativeDir = join(fixturesDir, 'negative');
  const negativeFiles = readdirSync(negativeDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  // Guard against a silently empty fixtures directory (would otherwise make
  // this describe block vacuously pass with zero it()s).
  it('negative fixtures directory is populated', () => {
    expect(negativeFiles.length).toBe(9);
  });

  for (const file of negativeFiles) {
    it(`${file} fires every rule in its _expected list`, () => {
      const doc = loadFixture(join(negativeDir, file));
      const expected = doc._expected ?? [];
      expect(expected.length, `${file} has no _expected rules to check`).toBeGreaterThan(0);
      const found = ruleSet(validateReportData(doc));
      const missing = expected.filter((r) => !found.has(r));
      expect(
        missing,
        `${file}: MISSING ${JSON.stringify(missing)} (found only ${JSON.stringify([...found])})`,
      ).toEqual([]);
    });
  }
});

/**
 * Direct unit tests per rule id — minimal inline examples, independent of
 * the fixture files, so each rule has a co-located example that documents
 * exactly what triggers it.
 */

function figure(overrides: Partial<Figure> & Pick<Figure, 'id' | 'label'>): Figure {
  return { source_path: `envelope:${overrides.id}`, basis: 'settled_month_end', ...overrides };
}

describe('BASIS-1 (one basis per label per document)', () => {
  it('fires when two figures share a label but carry different bases', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.a', label: 'Revenue', basis: 'settled_month_end' }),
        figure({ id: 'f.b', label: 'revenue', basis: 'prior_year' }), // case/whitespace-insensitive label match
      ],
    };
    const found = validateReportData(doc);
    expect(found.some((f) => f.rule === 'BASIS-1')).toBe(true);
  });

  it('does not fire when the same label always carries the same basis', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.a', label: 'Revenue', basis: 'settled_month_end' }),
        figure({ id: 'f.b', label: 'Revenue', basis: 'settled_month_end' }),
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'BASIS-1')).toBe(false);
  });
});

describe('TRACE-1 (source_path present; every ref resolves)', () => {
  it('fires when a figure has no source_path', () => {
    const doc: ReportDataDocument = {
      figures: [{ id: 'f.a', label: 'Revenue' }],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-1', subject: 'f.a' }),
    );
  });

  it('fires when a claim figure_ref does not resolve', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'Revenue' })],
      claims: [{ id: 'c.1', kind: 'observation', text: 'x', figure_refs: ['f.does-not-exist'] }],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-1', subject: 'c.1' }),
    );
  });

  it('does not flag a derived input prefixed sql: or envelope: even though it is not a document object', () => {
    const doc: ReportDataDocument = {
      derived: [
        {
          id: 'd.1',
          label: 'Recomputed',
          inputs: ['sql:some-query'],
          why_not_published: 'reason',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'TRACE-1')).toBe(false);
  });
});

describe('TRACE-2 (Derived requires inputs[] and why_not_published)', () => {
  it('fires (twice) for a derived figure with no inputs and no why_not_published', () => {
    const doc: ReportDataDocument = {
      derived: [{ id: 'd.1', label: 'Recomputed' }],
    };
    const found = validateReportData(doc).filter((f) => f.rule === 'TRACE-2');
    expect(found).toHaveLength(2);
  });

  it('does not fire when both inputs[] and why_not_published are present', () => {
    const doc: ReportDataDocument = {
      derived: [
        {
          id: 'd.1',
          label: 'Recomputed',
          inputs: ['sql:q'],
          why_not_published: 'the published figure does not apply here',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'TRACE-2')).toBe(false);
  });
});

describe('TRACE-3 (a Derived shadowing a published label must name it)', () => {
  it('fires when a derived shares a published label without naming its id', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.published', label: 'Monthly revenue' })],
      derived: [
        {
          id: 'd.recomputed',
          label: 'Monthly revenue',
          inputs: ['sql:q'],
          why_not_published: 'a different reason entirely',
        },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-3', subject: 'd.recomputed' }),
    );
  });

  it('does not fire when why_not_published names the shadowed figure id', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.published', label: 'Monthly revenue' })],
      derived: [
        {
          id: 'd.recomputed',
          label: 'Monthly revenue',
          inputs: ['sql:q'],
          why_not_published: 'f.published divides an unrelated window; recomputed here instead',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'TRACE-3')).toBe(false);
  });
});

describe('CAVEAT-1 (blocking caveats render at every quotation site)', () => {
  const figWithBlockingCaveat = figure({
    id: 'f.lost-sales',
    label: 'Lost sales',
    caveats: ['lost_sales_coverage'],
  });
  const registry = {
    lost_sales_coverage: { text: 'priced universe only', severity: 'blocking' },
  };

  it('fires when a section quotes a figure without rendering its blocking caveat', () => {
    const doc: ReportDataDocument = {
      figures: [figWithBlockingCaveat],
      caveat_registry: registry,
      sections: [{ id: 'sec.1', figure_refs: ['f.lost-sales'], caveats_rendered: [] }],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'CAVEAT-1', subject: 'sec.1' }),
    );
  });

  it('does not fire when the section renders the blocking caveat', () => {
    const doc: ReportDataDocument = {
      figures: [figWithBlockingCaveat],
      caveat_registry: registry,
      sections: [
        { id: 'sec.1', figure_refs: ['f.lost-sales'], caveats_rendered: ['lost_sales_coverage'] },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'CAVEAT-1')).toBe(false);
  });
});

describe('POP-1 (superlative/quantifier claims need a complete population)', () => {
  it('fires when the population is not complete', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: 'f.monthly',
          label: 'Monthly revenue',
          population: { complete: false, members: [{ key: '2026-01', revenue: 100 }] },
        }),
      ],
      claims: [
        {
          id: 'c.lowest',
          kind: 'superlative',
          text: 'x',
          figure_refs: ['f.monthly'],
          population_ref: 'f.monthly',
          check: {
            type: 'extremum',
            member_key: 'revenue',
            direction: 'min',
            claimed_member: '2026-01',
          },
        },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-1', subject: 'c.lowest' }),
    );
  });

  it('fires when the population_ref does not resolve to any population at all', () => {
    const doc: ReportDataDocument = {
      claims: [
        {
          id: 'c.lowest',
          kind: 'superlative',
          text: 'x',
          figure_refs: [],
          population_ref: 'nope',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'POP-1')).toBe(true);
  });
});

describe('POP-2 (superlative/quantifier claims must re-evaluate TRUE)', () => {
  it('fires when a check has no complete/correct answer against the members', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: 'f.monthly',
          label: 'Monthly revenue',
          population: {
            complete: true,
            members: [
              { key: '2026-01', revenue: 100 },
              { key: '2026-02', revenue: 50 },
            ],
          },
        }),
      ],
      claims: [
        {
          id: 'c.lowest',
          kind: 'superlative',
          text: 'x',
          figure_refs: ['f.monthly'],
          population_ref: 'f.monthly',
          check: {
            type: 'extremum',
            member_key: 'revenue',
            direction: 'min',
            claimed_member: '2026-01', // actual min is 2026-02
          },
        },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.lowest' }),
    );
  });

  it('fires when a superlative/quantifier claim has no machine-checkable check at all', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: 'f.monthly',
          label: 'Monthly revenue',
          population: { complete: true, members: [{ key: '2026-01', revenue: 100 }] },
        }),
      ],
      claims: [
        {
          id: 'c.lowest',
          kind: 'superlative',
          text: 'x',
          figure_refs: ['f.monthly'],
          population_ref: 'f.monthly',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(true);
  });
});

describe('CAUSE-1 (causal claims require mechanism + tested_alternatives)', () => {
  it('fires (twice) for a causal claim with neither field', () => {
    const doc: ReportDataDocument = {
      claims: [{ id: 'c.cause', kind: 'causal', text: 'Traffic caused the decline.' }],
    };
    const found = validateReportData(doc).filter((f) => f.rule === 'CAUSE-1');
    expect(found).toHaveLength(2);
  });

  it('does not fire when both mechanism and tested_alternatives are present', () => {
    const doc: ReportDataDocument = {
      claims: [
        {
          id: 'c.cause',
          kind: 'causal',
          text: 'Traffic caused the decline.',
          mechanism: 'a documented outage cut paid traffic for 6 days',
          tested_alternatives: ['ruled out a pricing change', 'ruled out a catalog gap'],
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'CAUSE-1')).toBe(false);
  });
});

describe('CAUSE-2 (non-causal claims may not use causal language)', () => {
  it('fires when a non-causal claim uses causal language', () => {
    const doc: ReportDataDocument = {
      claims: [
        { id: 'c.tracking', kind: 'tracking', text: 'Sessions fell because traffic dropped.' },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'CAUSE-2', subject: 'c.tracking' }),
    );
  });

  it('does not fire on causal-free non-causal prose', () => {
    const doc: ReportDataDocument = {
      claims: [{ id: 'c.tracking', kind: 'tracking', text: 'Sessions fell alongside revenue.' }],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'CAUSE-2')).toBe(false);
  });
});

describe('COMP-1 (comparison_basis must match; comparisons may not mix bases)', () => {
  it('fires when comparison_basis does not match a referenced figure basis', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'A', basis: 'own_baseline' })],
      claims: [
        {
          id: 'c.cmp',
          kind: 'comparison',
          text: 'x',
          figure_refs: ['f.a'],
          comparison_basis: 'prior_year',
        },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'COMP-1', subject: 'c.cmp' }),
    );
  });

  it('fires when a comparison claim mixes bases across its figures with no explicit comparison_basis', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.a', label: 'A', basis: 'own_baseline' }),
        figure({ id: 'f.b', label: 'B', basis: 'prior_year' }),
      ],
      claims: [
        { id: 'c.cmp', kind: 'comparison', text: 'x', figure_refs: ['f.a', 'f.b'] },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'COMP-1')).toBe(true);
  });

  it('does not fire when a comparison claim keeps a single basis across its figures', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.a', label: 'A', basis: 'own_baseline' }),
        figure({ id: 'f.b', label: 'B', basis: 'own_baseline' }),
      ],
      claims: [
        { id: 'c.cmp', kind: 'comparison', text: 'x', figure_refs: ['f.a', 'f.b'] },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'COMP-1')).toBe(false);
  });
});

describe('UNIT-1 (item_days never renders as plain "days")', () => {
  it('fires when a section quoting an item_days figure renders plain "days" text', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.oos', label: 'OOS exposure', unit: 'item_days' })],
      sections: [
        {
          id: 'sec.1',
          figure_refs: ['f.oos'],
          display_text: 'Out-of-stock exposure rose from 377 to 855 days.',
        },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'UNIT-1', subject: 'sec.1' }),
    );
  });

  it('does not fire when the text says "item-days" instead of plain "days"', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.oos', label: 'OOS exposure', unit: 'item_days' })],
      sections: [
        {
          id: 'sec.1',
          figure_refs: ['f.oos'],
          display_text: 'Out-of-stock exposure rose from 377 to 855 item-days.',
        },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-1')).toBe(false);
  });
});

// Exercise the remaining eval_check machinery (extremum_set, count, none,
// share_of_total) not otherwise hit by the direct POP-1/POP-2 tests above,
// so every check `type` has coverage independent of the fixture files.
describe('eval_check machinery, exercised through POP-2', () => {
  function quantifierClaim(
    check: NonNullable<Claim['check']>,
    members: Array<{ key: string; [k: string]: unknown }>,
  ): { doc: ReportDataDocument; figId: string } {
    const figId = 'f.pop';
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: figId,
          label: 'Population figure',
          population: { complete: true, members },
        }),
      ],
      claims: [
        {
          id: 'c.q',
          kind: 'quantifier',
          text: 'x',
          figure_refs: [figId],
          population_ref: figId,
          check,
        },
      ],
    };
    return { doc, figId };
  }

  it('extremum_set: fires when the claimed set does not match the actual bottom/top-n', () => {
    const { doc } = quantifierClaim(
      { type: 'extremum_set', member_key: 'v', direction: 'min', n: 2, claimed_members: ['a', 'b'] },
      [
        { key: 'a', v: 3 },
        { key: 'b', v: 2 },
        { key: 'c', v: 1 },
      ],
    );
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(true);
  });

  it('count: fires when the claimed count of matching members is wrong', () => {
    const { doc } = quantifierClaim(
      { type: 'count', predicate: { member_key: 'v', op: 'lt', value: 0 }, claimed_count: 2 },
      [
        { key: 'a', v: -1 },
        { key: 'b', v: 1 },
        { key: 'c', v: 2 },
      ],
    );
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(true);
  });

  it('none: fires when a member matches a predicate claimed to match none', () => {
    const { doc } = quantifierClaim(
      { type: 'none', predicate: { member_key: 'v', op: 'gt', value: 0 } },
      [
        { key: 'a', v: -1 },
        { key: 'b', v: 1 },
      ],
    );
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(true);
  });

  it('share_of_total: fires when the ratio falls outside the claimed band', () => {
    const figId = 'f.total';
    const legId = 'f.leg';
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: figId, label: 'Total', value: -100 }),
        figure({ id: legId, label: 'Leg', value: -128 }),
      ],
      claims: [
        {
          id: 'c.share',
          kind: 'quantifier',
          text: 'x',
          figure_refs: [figId, legId],
          population_ref: figId,
          check: {
            type: 'share_of_total',
            numerator: legId,
            denominator: figId,
            claimed_band: [0.8, 1.0],
          },
        },
      ],
    };
    // population must resolve+be complete for POP-2 to run the check at all
    (doc.figures as Figure[])[0].population = { complete: true, members: [{ key: 'x' }] };
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(true);
  });
});

// Sanity: the exported types compile as expected for a hand-built document
// (not just fixture JSON cast at the boundary).
describe('typed construction sanity', () => {
  it('accepts a fully-typed minimal document with no findings', () => {
    const fig: Figure = figure({ id: 'f.a', label: 'A' });
    const derived: Derived = {
      id: 'd.a',
      label: 'Derived A',
      inputs: ['sql:q'],
      why_not_published: 'reason',
    };
    const claim: Claim = { id: 'c.a', kind: 'tracking', text: 'A moved.', figure_refs: ['f.a'] };
    const section: Section = { id: 'sec.a', figure_refs: ['f.a'], claim_refs: ['c.a'] };
    const doc: ReportDataDocument = {
      figures: [fig],
      derived: [derived],
      claims: [claim],
      sections: [section],
    };
    expect(validateReportData(doc)).toEqual([]);
  });
});
