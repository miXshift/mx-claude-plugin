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

  // Guard against a silently empty (or silently pruned) fixtures directory:
  // this describe block would otherwise pass vacuously with zero it()s. The
  // nine original incident fixtures must always be present BY NAME; the
  // count is deliberately not pinned, because the append protocol adds a new
  // negative fixture every time a defect ships (E10+ arrive from upstream on
  // re-vendor) and a pinned count would make every append a test edit.
  it('negative fixtures directory carries at least the nine original incidents', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(
        negativeFiles.some((f) => f.startsWith(`E${n}-`)),
        `missing the E${n} incident fixture`,
      ).toBe(true);
    }
    expect(negativeFiles.length).toBeGreaterThanOrEqual(9);
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

  it('fires when a blocking caveat IS declared rendered but its registry entry has no text (it would silently vanish at render)', () => {
    const doc: ReportDataDocument = {
      figures: [figWithBlockingCaveat],
      caveat_registry: { lost_sales_coverage: { severity: 'blocking' } }, // no text
      sections: [
        { id: 'sec.1', figure_refs: ['f.lost-sales'], caveats_rendered: ['lost_sales_coverage'] },
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'CAVEAT-1', subject: 'sec.1' }),
    );
  });

  it('also fires for a registry entry with an empty-string text', () => {
    const doc: ReportDataDocument = {
      figures: [figWithBlockingCaveat],
      caveat_registry: { lost_sales_coverage: { text: '   ', severity: 'blocking' } },
      sections: [
        { id: 'sec.1', figure_refs: ['f.lost-sales'], caveats_rendered: ['lost_sales_coverage'] },
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'CAVEAT-1')).toBe(true);
  });
});

describe('shared_blocks are validated as their own quotation site (TRACE-1 / CAVEAT-1 / UNIT-1)', () => {
  it('TRACE-1: fires when a section\'s shared_block_ref does not resolve', () => {
    const doc: ReportDataDocument = {
      sections: [{ id: 'sec.orphan', shared_block_ref: 'nope' }],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-1', subject: 'sec.orphan' }),
    );
  });

  it('TRACE-1: fires when a shared block\'s own figure_ref does not resolve', () => {
    const doc: ReportDataDocument = {
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.bottom_line' }],
      shared_blocks: {
        'shared.bottom_line': { figure_refs: ['f.does-not-exist'] },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-1', subject: 'shared_blocks.shared.bottom_line' }),
    );
  });

  it('TRACE-1: passes when the shared_block_ref and its figure_refs all resolve', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'A' })],
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.bottom_line' }],
      shared_blocks: { 'shared.bottom_line': { figure_refs: ['f.a'] } },
    };
    expect(validateReportData(doc).some((f) => f.rule === 'TRACE-1')).toBe(false);
  });

  it('CAVEAT-1: fires when a shared block quotes a figure without rendering its blocking caveat -- a pointer section carrying no figure_refs of its own previously let this bypass the validator entirely', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.lost-sales', label: 'Lost sales', caveats: ['lost_sales_coverage'] }),
      ],
      caveat_registry: {
        lost_sales_coverage: { text: 'priced universe only', severity: 'blocking' },
      },
      sections: [
        { id: 'sec.exec', shared_block_ref: 'shared.bottom_line' },
        { id: 'sec.full', shared_block_ref: 'shared.bottom_line' },
      ],
      shared_blocks: {
        'shared.bottom_line': {
          figure_refs: ['f.lost-sales'],
          caveats_rendered: [], // the bug: never rendered
        },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'CAVEAT-1', subject: 'shared_blocks.shared.bottom_line' }),
    );
    // The pointer sections themselves carry no figure_refs, so they must
    // NOT ALSO separately fire (would be a confusing duplicate against the
    // wrong subject id).
    expect(found.filter((f) => f.subject === 'sec.exec' || f.subject === 'sec.full')).toEqual([]);
  });

  it('CAVEAT-1: does not fire when the shared block renders the blocking caveat', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.lost-sales', label: 'Lost sales', caveats: ['lost_sales_coverage'] }),
      ],
      caveat_registry: {
        lost_sales_coverage: { text: 'priced universe only', severity: 'blocking' },
      },
      sections: [{ id: 'sec.exec', shared_block_ref: 'shared.bottom_line' }],
      shared_blocks: {
        'shared.bottom_line': {
          figure_refs: ['f.lost-sales'],
          caveats_rendered: ['lost_sales_coverage'],
        },
      },
    };
    expect(validateReportData(doc).some((f) => f.rule === 'CAVEAT-1')).toBe(false);
  });

  it('UNIT-1: fires when a shared block renders an item_days figure as plain "days"', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.oos', label: 'OOS exposure', unit: 'item_days' })],
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.oos' }],
      shared_blocks: {
        'shared.oos': {
          figure_refs: ['f.oos'],
          display_text: 'Out-of-stock exposure rose from 377 to 855 days.',
        },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'UNIT-1', subject: 'shared_blocks.shared.oos' }),
    );
  });

  it('UNIT-1: does not fire when the shared block says "item-days"', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.oos', label: 'OOS exposure', unit: 'item_days' })],
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.oos' }],
      shared_blocks: {
        'shared.oos': {
          figure_refs: ['f.oos'],
          display_text: 'Out-of-stock exposure rose from 377 to 855 item-days.',
        },
      },
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-1')).toBe(false);
  });

  // A shared block's `claim_refs` -- not just its own `figure_refs` -- reach
  // the rendered page: render-report.ts's renderSectionBody expands a
  // block's claim_refs into figure chips exactly like an ordinary section's
  // (quotedFigureIds), so a block that quotes a figure ONLY via claim_refs
  // previously bypassed CAVEAT-1/UNIT-1/TRACE-1 entirely while still
  // shipping that figure to the page bare.
  it('CAVEAT-1: fires when a shared block quotes a blocking-caveat figure only via claim_refs', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.lost-sales', label: 'Lost sales', caveats: ['lost_sales_coverage'] }),
      ],
      caveat_registry: {
        lost_sales_coverage: { text: 'priced universe only', severity: 'blocking' },
      },
      claims: [{ id: 'c.lost-sales', kind: 'observation', text: 'x', figure_refs: ['f.lost-sales'] }],
      sections: [{ id: 'sec.exec', shared_block_ref: 'shared.bottom_line' }],
      shared_blocks: {
        'shared.bottom_line': {
          // no figure_refs of its own -- the figure is reached only through claim_refs
          claim_refs: ['c.lost-sales'],
          caveats_rendered: [],
        },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'CAVEAT-1', subject: 'shared_blocks.shared.bottom_line' }),
    );
  });

  it('UNIT-1: fires when a shared block renders an item_days figure reached only via claim_refs as plain "days"', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.oos', label: 'OOS exposure', unit: 'item_days' })],
      claims: [{ id: 'c.oos', kind: 'observation', text: 'x', figure_refs: ['f.oos'] }],
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.oos' }],
      shared_blocks: {
        'shared.oos': {
          claim_refs: ['c.oos'],
          display_text: 'Out-of-stock exposure rose from 377 to 855 days.',
        },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'UNIT-1', subject: 'shared_blocks.shared.oos' }),
    );
  });

  it('TRACE-1: fires when a shared block\'s claim_ref does not resolve', () => {
    const doc: ReportDataDocument = {
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.bottom_line' }],
      shared_blocks: {
        'shared.bottom_line': { claim_refs: ['c.does-not-exist'] },
      },
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'TRACE-1', subject: 'shared_blocks.shared.bottom_line' }),
    );
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

describe('UNIT-2 (a unit must not contradict its served contract, or claim an implausible percent)', () => {
  // (a) THE SERVED-CONTRACT PREDICATE

  it('fires when a figure’s unit contradicts the served contract it was extracted under', () => {
    // The engine said these dollars are 'currency'. Something downstream --
    // an assembly pass, a hand edit, a copied figure -- relabelled them a rate.
    // No other rule in this file can see that; every one of them passes.
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: 'ads.ad_driven_sales.p2',
          label: 'Ad-attributed sales',
          value: 22448.2,
          unit: 'ratio',
          served_unit: 'currency',
        }),
      ],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'UNIT-2', subject: 'ads.ad_driven_sales.p2' }),
    );
    expect(found.find((f) => f.rule === 'UNIT-2')?.detail).toContain("contradicts the served contract 'currency'");
  });

  it('does NOT fire when no contract was served — version skew must not manufacture findings', () => {
    // Same figure, same 'ratio' label, no served_unit: a pre-0.2.0 envelope, a
    // hand-authored figure, or a Derived. The rule has nothing to compare
    // against and stays silent by design. The value is kept inside the
    // plausibility ceiling deliberately, so this isolates the served-contract
    // predicate — the backstop is exercised on its own below.
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'ads.ad_driven_sales.p2', label: 'Ad-attributed sales', value: 0.224482, unit: 'ratio' }),
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(false);
  });

  it('does not fire when the unit and the served contract agree', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({
          id: 'ops.ops.p1',
          label: 'Revenue',
          value: 100000,
          unit: 'currency',
          served_unit: 'currency',
        }),
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(false);
  });

  it('does not fire on an empty served_unit (nothing was asserted)', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'A', value: 1, unit: 'currency', served_unit: '' })],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(false);
  });

  it('catches a Derived whose recompute changed the scale without changing the label', () => {
    const doc: ReportDataDocument = {
      derived: [
        {
          id: 'd.tacos',
          label: 'Day-normalised TACoS',
          value: 0.083,
          unit: 'percent',
          served_unit: 'ratio',
          inputs: ['ops.ops.p1'],
          why_not_published: 'reason',
        },
      ],
    };
    expect(validateReportData(doc)).toContainEqual(
      expect.objectContaining({ rule: 'UNIT-2', subject: 'd.tacos' }),
    );
  });

  // (b) THE PERCENT PLAUSIBILITY BACKSTOP — needs no served contract, so it
  // still covers the figures the predicate above cannot reach.

  it('fires on a percent-family figure past 1000% displayed, even with nothing served', () => {
    // The classic scale error: 45 (meaning 45%) stored under 'ratio', which
    // multiplies by 100 on the way to the page. The reader sees "4500.0%".
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'ads.acos.p2', label: 'ACoS', value: 45, unit: 'ratio' })],
    };
    const found = validateReportData(doc);
    expect(found).toContainEqual(expect.objectContaining({ rule: 'UNIT-2', subject: 'ads.acos.p2' }));
    expect(found.find((f) => f.rule === 'UNIT-2')?.detail).toContain('4500.0%');
  });

  it('is scale-aware: the same number is fine under `percent`, which is already whole', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'ads.acos.p2', label: 'ACoS', value: 45, unit: 'percent' })],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(false);
  });

  it('fires on an already-whole percent unit too, once it passes the same displayed ceiling', () => {
    const doc: ReportDataDocument = {
      figures: [figure({ id: 'ads.acos.p2', label: 'ACoS', value: 4500, unit: 'percent' })],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(true);
  });

  it('covers every percent-family token at its own scale, and fires on the negative side too', () => {
    const cases: Array<[string, number, boolean]> = [
      ['ratio', 10.5, true], // 1050% displayed
      ['ratio', -10.5, true], // magnitude, not sign
      ['ratio', 9.9, false], // 990% — loose ceiling, deliberately
      ['points_fraction', 12, true], // 1200 pts
      ['points_fraction', 0.028, false], // a real 2.8-point move
      ['points', 1200, true],
      ['percent-points', 1200, true],
      ['pts', 1200, true],
      ['percent', 999, false],
    ];
    for (const [unit, value, shouldFire] of cases) {
      const doc: ReportDataDocument = {
        figures: [figure({ id: 'f.x', label: 'X', value, unit })],
      };
      expect(
        validateReportData(doc).some((f) => f.rule === 'UNIT-2'),
        `${unit} @ ${value} should ${shouldFire ? '' : 'not '}fire`,
      ).toBe(shouldFire);
    }
  });

  it('ignores non-percent units and non-numeric values entirely', () => {
    const doc: ReportDataDocument = {
      figures: [
        figure({ id: 'f.money', label: 'Money', value: 1_000_000, unit: 'currency' }),
        figure({ id: 'f.count', label: 'Count', value: 500_000, unit: 'count' }),
        figure({ id: 'f.bad', label: 'Bad', value: 'n/a' as unknown as number, unit: 'ratio' }),
        figure({ id: 'f.none', label: 'None', unit: 'ratio' }),
      ],
    };
    expect(validateReportData(doc).some((f) => f.rule === 'UNIT-2')).toBe(false);
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

/**
 * A stringified figure-like value in a population member (e.g. a report
 * assembler that formatted "1,200" before it should have) must not coerce
 * through JS's loose comparisons into a silent pass. The Python executable
 * spec hard-fails (TypeError) on these documents; the TS port must refuse
 * without crashing -- fail closed with POP-2, never certify the check.
 */
describe('POP-2 numeric guard (non-numeric member values fail closed, never coerce)', () => {
  function quantifierClaim(
    check: NonNullable<Claim['check']>,
    members: Array<{ key: string; [k: string]: unknown }>,
  ): ReportDataDocument {
    const figId = 'f.pop';
    return {
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
          kind: 'superlative',
          text: 'x',
          figure_refs: [figId],
          population_ref: figId,
          check,
        },
      ],
    };
  }

  it('extremum: a stringified member value fails closed with POP-2 instead of validating a false superlative CLEAN', () => {
    // 'jul' carries a formatted-string revenue; a naive comparator sorts it
    // via NaN comparisons (always false), so it never outranks the numeric
    // members and a FALSE "jul is the lowest" claim would validate CLEAN.
    const doc = quantifierClaim(
      { type: 'extremum', member_key: 'revenue', direction: 'min', claimed_member: 'jul' },
      [
        { key: 'jan', revenue: 1214000 },
        { key: 'feb', revenue: 1187000 },
        { key: 'jul', revenue: '1,200' },
      ],
    );
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.q' }),
    );
    // Fail-closed, not "coerced and happened to fail for the right reason":
    // the finding must name the non-numeric member, not a mismatched winner.
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/non-numeric/);
  });

  it('none: a stringified predicate THRESHOLD fails closed with POP-2 instead of certifying a false none-claim', () => {
    // 5 > '1,200' coerces to 5 > NaN = false in JS, so every comparison is
    // false, the count is 0, and a FALSE "no member exceeded the threshold"
    // claim would validate CLEAN. The threshold gets the same fail-closed
    // discipline as member values.
    const doc = quantifierClaim(
      { type: 'none', predicate: { member_key: 'delta', op: 'gt', value: '1,200' } },
      [
        { key: 'a', delta: 5000 },
        { key: 'b', delta: 3 },
      ],
    );
    const found = validateReportData(doc);
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/predicate value .* non-numeric/);
  });

  it('count: a stringified predicate threshold fails closed with POP-2 even when the claimed_count matches the coerced zero', () => {
    const doc = quantifierClaim(
      { type: 'count', predicate: { member_key: 'delta', op: 'gt', value: '1,200' }, claimed_count: 0 },
      [
        { key: 'a', delta: 5000 },
        { key: 'b', delta: 3 },
      ],
    );
    const found = validateReportData(doc);
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/predicate value .* non-numeric/);
  });

  it('eq predicate keeps working on string values with a string threshold (no numeric guard false positive)', () => {
    const doc = quantifierClaim(
      { type: 'count', predicate: { member_key: 'status', op: 'eq', value: 'active' }, claimed_count: 1 },
      [
        { key: 'a', status: 'active' },
        { key: 'b', status: 'paused' },
      ],
    );
    expect(validateReportData(doc).filter((f) => f.rule === 'POP-2')).toEqual([]);
  });

  it('extremum: all-numeric members evaluate normally -- a true superlative produces no POP-2', () => {
    const doc = quantifierClaim(
      { type: 'extremum', member_key: 'revenue', direction: 'min', claimed_member: 'feb' },
      [
        { key: 'jan', revenue: 1214000 },
        { key: 'feb', revenue: 1187000 },
        { key: 'jul', revenue: 1300000 },
      ],
    );
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(false);
  });

  it('extremum: all-numeric members evaluate normally -- a false superlative still fails POP-2 on the ordinary mismatch, not a numeric-guard reason', () => {
    const doc = quantifierClaim(
      { type: 'extremum', member_key: 'revenue', direction: 'min', claimed_member: 'jan' },
      [
        { key: 'jan', revenue: 1214000 },
        { key: 'feb', revenue: 1187000 },
        { key: 'jul', revenue: 1300000 },
      ],
    );
    const found = validateReportData(doc);
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).not.toMatch(/non-numeric/);
    expect(finding?.detail).toMatch(/claimed 'jan'/);
  });

  it('count: a stringified member value under a numeric predicate (gt) fails closed with POP-2', () => {
    const doc = quantifierClaim(
      { type: 'count', predicate: { member_key: 'delta', op: 'gt', value: 0 }, claimed_count: 2 },
      [
        { key: 'a', delta: 10 },
        { key: 'b', delta: '1,200' }, // formatted-string, not a real number
        { key: 'c', delta: -5 },
      ],
    );
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.q' }),
    );
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/non-numeric/);
  });

  it('eq predicate still works on string values without the numeric requirement', () => {
    const doc = quantifierClaim(
      { type: 'count', predicate: { member_key: 'tier', op: 'eq', value: 'gold' }, claimed_count: 2 },
      [
        { key: 'a', tier: 'gold' },
        { key: 'b', tier: 'gold' },
        { key: 'c', tier: 'silver' },
      ],
    );
    // Correct claimed_count against string equality -- no findings at all,
    // and specifically no POP-2 numeric-guard false positive.
    expect(validateReportData(doc)).toEqual([]);
  });

  it('eq predicate on string values still fails normally (not via the numeric guard) when the claimed count is wrong', () => {
    const doc = quantifierClaim(
      { type: 'count', predicate: { member_key: 'tier', op: 'eq', value: 'gold' }, claimed_count: 3 },
      [
        { key: 'a', tier: 'gold' },
        { key: 'b', tier: 'gold' },
        { key: 'c', tier: 'silver' },
      ],
    );
    const found = validateReportData(doc);
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).not.toMatch(/non-numeric/);
    expect(finding?.detail).toMatch(/claimed 3 of 3 members match; 2 do/);
  });
});

/**
 * share_of_total divides two figure values directly (never through a
 * population member), so it gets its own numeric guard: a stringified
 * figure value must not coerce through JS's `/` operator into an in-band
 * ratio (Python raises TypeError on str/float division), and a zero
 * denominator must not produce Infinity.
 */
describe('POP-2 numeric guard on share_of_total (stringified figures, zero denominator)', () => {
  function shareClaim(numerator: Figure, denominator: Figure): ReportDataDocument {
    return {
      figures: [numerator, denominator],
      claims: [
        {
          id: 'c.share',
          kind: 'quantifier',
          text: 'x',
          figure_refs: [numerator.id, denominator.id],
          population_ref: denominator.id,
          check: {
            type: 'share_of_total',
            numerator: numerator.id,
            denominator: denominator.id,
            claimed_band: [0.8, 1.0],
          },
        },
      ],
    };
  }

  it('fires POP-2 when the numerator figure carries a stringified value', () => {
    const num = figure({ id: 'f.leg', label: 'Leg', value: '900' as unknown as number });
    const den = figure({ id: 'f.total', label: 'Total', value: 1000 });
    den.population = { complete: true, members: [{ key: 'x' }] };
    const doc = shareClaim(num, den);
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.share' }),
    );
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/numerator.*non-numeric/);
  });

  it('fires POP-2 when the denominator figure carries a stringified value', () => {
    const num = figure({ id: 'f.leg', label: 'Leg', value: 900 });
    const den = figure({ id: 'f.total', label: 'Total', value: '1000' as unknown as number });
    den.population = { complete: true, members: [{ key: 'x' }] };
    const doc = shareClaim(num, den);
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.share' }),
    );
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/denominator.*non-numeric/);
  });

  it('fires POP-2 (not Infinity) when the denominator is zero', () => {
    const num = figure({ id: 'f.leg', label: 'Leg', value: 900 });
    const den = figure({ id: 'f.total', label: 'Total', value: 0 });
    den.population = { complete: true, members: [{ key: 'x' }] };
    const doc = shareClaim(num, den);
    const found = validateReportData(doc);
    expect(found).toContainEqual(
      expect.objectContaining({ rule: 'POP-2', subject: 'c.share' }),
    );
    const finding = found.find((f) => f.rule === 'POP-2');
    expect(finding?.detail).toMatch(/denominator.*zero/);
  });

  it('does not fire when both figures are numeric and the ratio falls inside the claimed band', () => {
    const num = figure({ id: 'f.leg', label: 'Leg', value: 900 });
    const den = figure({ id: 'f.total', label: 'Total', value: 1000 });
    den.population = { complete: true, members: [{ key: 'x' }] };
    const doc = shareClaim(num, den);
    expect(validateReportData(doc).some((f) => f.rule === 'POP-2')).toBe(false);
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
