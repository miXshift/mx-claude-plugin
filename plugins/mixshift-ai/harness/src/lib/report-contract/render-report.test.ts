import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMonthlyReport } from './render-report.js';
import type { RenderReportDataDocument, DisplaySection } from './render-report.js';
import type { Figure } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, 'fixtures', 'golden-minimal.json');

function loadGolden(): RenderReportDataDocument {
  return JSON.parse(readFileSync(goldenPath, 'utf8')) as RenderReportDataDocument;
}

/** Extract the inner HTML of `<section ... id="ID">...</section>` for
 *  byte-for-byte comparison between two injection sites. */
function sectionInner(html: string, id: string): string {
  const re = new RegExp(
    `<section class="rr-section" id="${id}">\\n([\\s\\S]*?)</section>`,
  );
  const m = html.match(re);
  if (!m) throw new Error(`section '${id}' not found in rendered output`);
  return m[1]!;
}

describe('renderMonthlyReport — golden-minimal.json (a)', () => {
  it('renders without throwing and contains the quoted figure formatted value', () => {
    const doc = loadGolden();
    let html = '';
    expect(() => {
      html = renderMonthlyReport(doc);
    }).not.toThrow();
    // ops.lost_sales.current: value 20081, unit currency, precision 0,
    // currency USD -> "$20,081", quoted by sec.availability.
    expect(html).toContain('$20,081');
    expect(html).toContain('Estimated lost sales, current');
    expect(html).toContain('brand-a');
  });
});

describe('renderMonthlyReport — determinism (b)', () => {
  it('produces byte-identical output across two renders of the same document', () => {
    const doc = loadGolden();
    const first = renderMonthlyReport(doc);
    const second = renderMonthlyReport(doc);
    expect(second).toBe(first);
  });

  it('produces byte-identical output across two independently parsed copies', () => {
    const a = renderMonthlyReport(loadGolden());
    const b = renderMonthlyReport(loadGolden());
    expect(a).toBe(b);
  });
});

describe('renderMonthlyReport — sign/accent behavior (c)', () => {
  it('gives a negative figure the negative accent class and a positive one the positive class', () => {
    const doc: RenderReportDataDocument = {
      brand_slug: 'accent-test',
      currency: 'USD',
      figures: [
        {
          id: 'f.down',
          label: 'Sessions, MoM change',
          value: -1250,
          unit: 'count',
          basis: 'settled_month_end',
          source_path: 'envelope:sessions.mom',
          signed: true,
          accent: 'auto',
        },
        {
          id: 'f.up',
          label: 'Revenue, MoM change',
          value: 4200,
          unit: 'currency',
          basis: 'settled_month_end',
          source_path: 'envelope:revenue.mom',
          signed: true,
          accent: 'auto',
        },
      ],
      sections: [
        { id: 'sec.down', figure_refs: ['f.down'], display_text: 'Sessions fell.' },
        { id: 'sec.up', figure_refs: ['f.up'], display_text: 'Revenue rose.' },
      ],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toMatch(/rr-figure-value is-negative">−1,250</);
    expect(html).toMatch(/rr-figure-value is-positive">\+\$4,200</);
  });

  it('inverts the good/bad read for accent: auto_invert (a rise is bad)', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.acos-up',
          label: 'ACoS, MoM change',
          value: 3.2,
          unit: 'points',
          basis: 'settled_month_end',
          source_path: 'envelope:acos.mom',
          signed: true,
          accent: 'auto_invert',
        },
      ],
      sections: [{ id: 'sec.acos', figure_refs: ['f.acos-up'], display_text: 'ACoS rose.' }],
    };
    const html = renderMonthlyReport(doc);
    // A positive ACoS delta is bad -> negative (red) accent under auto_invert.
    expect(html).toContain('rr-figure-value is-negative');
    expect(html).not.toContain('rr-figure-value is-positive');
  });
});

describe('renderMonthlyReport — forecast suppression (d)', () => {
  const figures: RenderReportDataDocument['figures'] = [
    {
      id: 'f.fc',
      label: 'Forecast variance',
      value: 5000,
      unit: 'currency',
      basis: 'settled_month_end',
      source_path: 'envelope:forecast.variance',
    },
  ];
  const forecastSection: DisplaySection = {
    id: 'sec.forecast',
    kind: 'forecast',
    figure_refs: ['f.fc'],
    display_text: 'The account is running ahead of its forecast, projected to beat plan.',
  };
  const standardSection: DisplaySection = {
    id: 'sec.standard',
    display_text: 'Revenue held steady month over month.',
  };

  it('renders zero forecast vocabulary when the document has no provided-current forecast', () => {
    const doc: RenderReportDataDocument = {
      figures,
      sections: [standardSection, forecastSection],
    };
    const html = renderMonthlyReport(doc);
    expect(html.toLowerCase()).not.toContain('forecast');
    expect(html.toLowerCase()).not.toContain('projected');
    expect(html.toLowerCase()).not.toContain('ahead');
    expect(html.toLowerCase()).not.toContain('behind');
    expect(html).toContain('Revenue held steady month over month.');
  });

  it('renders the forecast section when the document marks the forecast provided-current', () => {
    const doc: RenderReportDataDocument = {
      figures,
      forecast: { state: 'provided_current' },
      sections: [standardSection, forecastSection],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('running ahead of its forecast');
  });
});

describe('renderMonthlyReport — blocking caveat rendered at every quotation site (e)', () => {
  it('renders the caveat text at every section that quotes the flagged figure', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.lost-sales',
          label: 'Lost sales',
          value: 20081,
          unit: 'currency',
          basis: 'priced_only',
          source_path: 'envelope:ops.lostSales.current.total',
          caveats: ['lost_sales_coverage'],
        },
      ],
      caveat_registry: {
        lost_sales_coverage: {
          text: 'Lost-sales estimate covers the priced universe only.',
          severity: 'blocking',
        },
      },
      sections: [
        {
          id: 'sec.exec',
          figure_refs: ['f.lost-sales'],
          caveats_rendered: ['lost_sales_coverage'],
          display_text: 'Lost sales reached a notable level this month.',
        },
        {
          id: 'sec.full',
          figure_refs: ['f.lost-sales'],
          caveats_rendered: ['lost_sales_coverage'],
          display_text: 'Availability drove a meaningful share of the miss.',
        },
      ],
    };
    const html = renderMonthlyReport(doc);
    const caveatText = 'Lost-sales estimate covers the priced universe only.';
    const occurrences = html.split(caveatText).length - 1;
    expect(occurrences).toBe(2);
  });
});

describe('renderMonthlyReport — item_days phrasing (f)', () => {
  it('renders an item_days figure as "N item-days", never bare "N days"', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.oos',
          label: 'OOS exposure',
          value: 672,
          unit: 'item_days',
          basis: 'full_universe',
          source_path: 'envelope:ops.availability.oosItemDays.current',
        },
      ],
      sections: [
        { id: 'sec.oos', figure_refs: ['f.oos'], display_text: 'Out-of-stock exposure rose.' },
      ],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('672 item-days');
    // The exact UNIT-1 carve-out the validator checks: a bare number
    // immediately followed by "day"/"days" never appears.
    expect(html).not.toMatch(/\b672\s*days\b/);
  });

  it('uses the singular "item-day" for a value of exactly 1', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.oos-one',
          label: 'OOS exposure',
          value: 1,
          unit: 'item_days',
          basis: 'full_universe',
          source_path: 'envelope:ops.availability.oosItemDays.current',
        },
      ],
      sections: [{ id: 'sec.oos-one', figure_refs: ['f.oos-one'] }],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('1 item-day<');
    expect(html).not.toContain('1 item-days');
  });
});

describe('renderMonthlyReport — shared-block injection (g)', () => {
  it('renders a block referenced by two sections twice with byte-identical inner content', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.revenue',
          label: 'Monthly revenue',
          value: 1234500,
          unit: 'currency',
          basis: 'settled_month_end',
          source_path: 'envelope:ops.monthlySeries',
        },
      ],
      shared_blocks: {
        'shared.bottom_line': {
          id: 'shared.bottom_line',
          title: 'Bottom line',
          figure_refs: ['f.revenue'],
          display_text: 'Revenue held near plan this month.',
        },
      },
      sections: [
        { id: 'sec.exec-summary', shared_block_ref: 'shared.bottom_line' },
        { id: 'sec.full-report', shared_block_ref: 'shared.bottom_line' },
      ],
    };
    const html = renderMonthlyReport(doc);
    const execInner = sectionInner(html, 'sec.exec-summary');
    const fullInner = sectionInner(html, 'sec.full-report');
    expect(execInner).toBe(fullInner);
    expect(execInner).toContain('Revenue held near plan this month.');
    expect(execInner).toContain('$1,234,500');
    // Sanity: the two outer wrapper ids are still distinct quotation sites.
    expect(html).toContain('id="sec.exec-summary"');
    expect(html).toContain('id="sec.full-report"');
  });

  it('throws a clear error when a section points at an undefined shared block', () => {
    const doc: RenderReportDataDocument = {
      sections: [{ id: 'sec.orphan', shared_block_ref: 'nope' }],
    };
    expect(() => renderMonthlyReport(doc)).toThrow(/shared_block_ref 'nope'/);
  });
});

describe('renderMonthlyReport — currency handling', () => {
  it('defaults to a bare "$" when the document declares no currency', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.x',
          label: 'Revenue',
          value: 500,
          unit: 'currency',
          basis: 'settled_month_end',
          source_path: 'envelope:x',
        },
      ],
      sections: [{ id: 'sec.x', figure_refs: ['f.x'] }],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('$500');
    expect(html).not.toContain('Currency');
  });

  it('honors a document-declared non-USD currency symbol', () => {
    const doc: RenderReportDataDocument = {
      currency: 'GBP',
      figures: [
        {
          id: 'f.x',
          label: 'Revenue',
          value: 500,
          unit: 'currency',
          basis: 'settled_month_end',
          source_path: 'envelope:x',
        },
      ],
      sections: [{ id: 'sec.x', figure_refs: ['f.x'] }],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('£500');
    expect(html).toContain('Currency GBP');
  });
});

// Type-level sanity: figure() convenience matches validate.ts's own Figure
// shape, so a caller can build documents without repeating boilerplate.
function figure(overrides: Partial<Figure> & Pick<Figure, 'id' | 'label'>): Figure {
  return { source_path: `envelope:${overrides.id}`, basis: 'settled_month_end', ...overrides };
}

describe('renderMonthlyReport — permissive on absent optional data', () => {
  it('renders a document with only the required top-level fields', () => {
    const doc: RenderReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'A', value: 10 })],
      sections: [{ id: 'sec.a', figure_refs: ['f.a'] }],
    };
    expect(() => renderMonthlyReport(doc)).not.toThrow();
  });
});
