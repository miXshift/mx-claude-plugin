import { describe, it, expect } from 'vitest';
import { renderMonthlyReport } from '../src/lib/report-contract/render-report';
import { validateReportData } from '../src/lib/report-contract/validate';

/**
 * The presentation layer: metric tables and KPI cards.
 *
 * Until this existed the renderer emitted four HTML elements (h1, h2,
 * section, p) — a run produces ~200 typed figures and a report could only
 * present them as prose or chips. The section order and tabular split come
 * from the engine author's v1 ruling; the membership rule is his too:
 * presentation is LAYOUT ONLY, membership stays in figure_refs, because a
 * second referencing channel would let figures escape TRACE-1 / CAVEAT-1.
 */

const fig = (id: string, value: number, unit = 'currency') => ({
  id,
  label: id.split('.').pop()!,
  value,
  unit,
  basis: 'ordered_revenue',
  source_path: `envelope:${id}`,
  caveats: [],
});

const doc = (over: Record<string, unknown> = {}) => ({
  schema_version: '2.0-draft',
  brand_slug: 'brand-a',
  currency: 'USD',
  figures: [
    fig('mom.ops.ops.p1', 100000),
    fig('mom.ops.ops.p2', 120000),
    fig('mom.ops.ops.delta', 20000),
    fig('mom.ops.units.p2', 5000, 'number'),
  ],
  derived: [],
  caveat_registry: {},
  claims: [],
  sections: [
    {
      id: 's.table',
      title: 'Performance snapshot',
      figure_refs: ['mom.ops.ops.p1', 'mom.ops.ops.p2', 'mom.ops.ops.delta', 'mom.ops.units.p2'],
      presentation: {
        kind: 'metric_table',
        rows: [
          {
            label: 'Ordered revenue',
            figures: { p1: 'mom.ops.ops.p1', p2: 'mom.ops.ops.p2', delta: 'mom.ops.ops.delta' },
          },
          { label: 'Units', figures: { p2: 'mom.ops.units.p2' } },
        ],
      },
    },
  ],
  ...over,
});

describe('metric_table', () => {
  it('renders a real table with unit-formatted cells', () => {
    const html = renderMonthlyReport(doc() as never);
    expect(html).toContain('<table class="rr-table">');
    expect(html).toContain('$120,000');
    expect(html).toContain('Ordered revenue');
    // A missing column cell is "n/a", never blank and never a dash.
    expect(html).toContain('n/a');
  });

  it('REPLACES the chip strip rather than duplicating every figure', () => {
    // Assert on the rendered ELEMENT, not the class name: the page shell's
    // stylesheet always contains `.rr-figure-strip {`, so a bare substring
    // check matches the CSS and can never fail. (First version of this test
    // did exactly that.)
    const html = renderMonthlyReport(doc() as never);
    expect(html).not.toContain('<div class="rr-figure-strip">');
  });

  it('a section WITHOUT presentation keeps the chip strip exactly as before', () => {
    const d = doc();
    delete (d.sections[0] as Record<string, unknown>).presentation;
    const html = renderMonthlyReport(d as never);
    expect(html).toContain('<div class="rr-figure-strip">');
    expect(html).not.toContain('<table class="rr-table">');
  });

  it('an unknown kind degrades to the chip strip, never to a blank section', () => {
    const d = doc();
    (d.sections[0] as { presentation: { kind: string } }).presentation.kind = 'sparkline';
    const html = renderMonthlyReport(d as never);
    expect(html).toContain('<div class="rr-figure-strip">');
  });
});

describe('kpi_cards', () => {
  it('renders cards with value and delta', () => {
    const d = doc();
    (d.sections[0] as Record<string, unknown>).presentation = {
      kind: 'kpi_cards',
      rows: [
        { label: 'OPS', figures: { value: 'mom.ops.ops.p2', delta: 'mom.ops.ops.delta' } },
      ],
    };
    const html = renderMonthlyReport(d as never);
    expect(html).toContain('rr-kpi-card');
    expect(html).toContain('$120,000');
  });
});

describe('the membership rule (PRES-1)', () => {
  /**
   * The engine author's rule, verbatim reasoning: if tables introduce a
   * second referencing channel, those figures silently escape TRACE-1 and
   * the CAVEAT-1 blocking-caveat guarantee. So an id in a presentation that
   * is not in the section's own figure_refs is an ERROR at the validator and
   * a VISIBLE marker at the renderer, never data.
   */
  it('the validator fails a presentation id missing from figure_refs', () => {
    const d = doc();
    (d.sections[0] as { figure_refs: string[] }).figure_refs = ['mom.ops.ops.p1'];
    const findings = validateReportData(d as never);
    const pres = findings.filter((f) => f.rule === 'PRES-1');
    expect(pres.length).toBeGreaterThan(0);
    expect(pres[0]!.detail).toContain('layout only');
  });

  it('the renderer shows a visible marker for an escaped id, not the value', () => {
    const d = doc();
    (d.sections[0] as { figure_refs: string[] }).figure_refs = ['mom.ops.ops.p1'];
    const html = renderMonthlyReport(d as never);
    expect(html).toContain('[not in figure_refs:');
  });

  it('a clean document has no PRES-1 findings', () => {
    expect(validateReportData(doc() as never).filter((f) => f.rule === 'PRES-1')).toEqual([]);
  });
});
