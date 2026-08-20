import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMonthlyReport, formatFigureValue, figureAccentClass, scanForecastVocabulary } from './render-report.js';
import type { RenderReportDataDocument, DisplaySection, FigureDisplay } from './render-report.js';
import type { Figure, FigureCommon } from './validate.js';

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

// ---------------------------------------------------------------------------
// formatFigureValue / figureAccentClass — non-numeric values (F5)
// ---------------------------------------------------------------------------

function figLike(overrides: Partial<FigureCommon & FigureDisplay> & { value?: unknown } = {}): FigureCommon & FigureDisplay {
  return { id: 'f.x', label: 'X', unit: 'currency', ...overrides } as FigureCommon & FigureDisplay;
}

describe('formatFigureValue — non-numeric values render the missing placeholder, never "$NaN" (F5)', () => {
  it('renders the missing-value placeholder for a non-numeric string ("n/a")', () => {
    const text = formatFigureValue(figLike({ value: 'n/a' as unknown as number }), 'USD');
    expect(text).not.toContain('NaN');
    expect(text).toBe('—');
  });

  it('renders the missing-value placeholder for a numeric-LOOKING string ("1,234") -- never coerced to a real value', () => {
    const text = formatFigureValue(figLike({ value: '1,234' as unknown as number }), 'USD');
    expect(text).not.toContain('NaN');
    expect(text).toBe('—');
  });

  it('renders the missing-value placeholder for an object value', () => {
    const text = formatFigureValue(figLike({ value: { v: 2 } as unknown as number }), 'USD');
    expect(text).toBe('—');
  });

  it('still formats a genuine numeric value normally (regression guard)', () => {
    const text = formatFigureValue(figLike({ value: 4200 }), 'USD');
    expect(text).toBe('$4,200');
  });
});

describe('figureAccentClass — non-finite values are always neutral, never a sign accent (F5)', () => {
  it('returns is-neutral for a non-numeric string under accent: auto', () => {
    const cls = figureAccentClass(figLike({ value: 'n/a' as unknown as number, accent: 'auto' }));
    expect(cls).toBe('is-neutral');
  });

  it('returns is-neutral for a non-numeric string under accent: auto_invert', () => {
    const cls = figureAccentClass(figLike({ value: 'n/a' as unknown as number, accent: 'auto_invert' }));
    expect(cls).toBe('is-neutral');
  });

  it('still resolves a real positive/negative value normally (regression guard)', () => {
    expect(figureAccentClass(figLike({ value: 10, accent: 'auto' }))).toBe('is-positive');
    expect(figureAccentClass(figLike({ value: -10, accent: 'auto' }))).toBe('is-negative');
  });
});

describe('renderMonthlyReport end-to-end — a non-numeric figure value never reaches the page as "$NaN" with a sign accent (F5)', () => {
  it('renders the placeholder and a neutral accent class, not is-positive/is-negative', () => {
    const doc: RenderReportDataDocument = {
      currency: 'USD',
      figures: [
        {
          id: 'f.bad',
          label: 'Garbage figure',
          value: 'n/a' as unknown as number,
          unit: 'currency',
          basis: 'b',
          source_path: 'envelope:x',
          accent: 'auto',
          signed: true,
        },
      ],
      sections: [{ id: 'sec.bad', figure_refs: ['f.bad'] }],
    };
    const html = renderMonthlyReport(doc);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('rr-figure-value is-positive');
    expect(html).not.toContain('rr-figure-value is-negative');
    expect(html).toContain('rr-figure-value is-neutral');
  });
});

// ---------------------------------------------------------------------------
// Blocking caveat with no text renders a visible marker, not nothing (F4)
// ---------------------------------------------------------------------------

describe('a blocking caveat with no registry text renders a visible marker instead of vanishing (F4)', () => {
  it('renders "[caveat text missing: <id>]" when the registry entry has no text', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.lost-sales',
          label: 'Lost sales',
          value: 100,
          unit: 'currency',
          basis: 'b',
          source_path: 'envelope:x',
          caveats: ['lost_sales_coverage'],
        },
      ],
      caveat_registry: { lost_sales_coverage: { severity: 'blocking' } }, // no text
      sections: [
        {
          id: 'sec.a',
          figure_refs: ['f.lost-sales'],
          caveats_rendered: ['lost_sales_coverage'],
        },
      ],
    };
    const html = renderMonthlyReport(doc);
    expect(html).toContain('[caveat text missing: lost_sales_coverage]');
  });

  it('renders nothing for a non-blocking caveat with no text (unaffected)', () => {
    const doc: RenderReportDataDocument = {
      figures: [
        {
          id: 'f.a',
          label: 'A',
          value: 100,
          unit: 'currency',
          basis: 'b',
          source_path: 'envelope:x',
          caveats: ['some_note'],
        },
      ],
      caveat_registry: { some_note: { severity: 'disclosure' } }, // no text, non-blocking
      sections: [{ id: 'sec.a', figure_refs: ['f.a'], caveats_rendered: ['some_note'] }],
    };
    const html = renderMonthlyReport(doc);
    expect(html).not.toContain('caveat text missing');
  });
});

// ---------------------------------------------------------------------------
// No file:// URLs / local paths in the rendered HTML (F6)
// ---------------------------------------------------------------------------

describe('rendered HTML never embeds a local file:// font path (F6, cross-machine determinism)', () => {
  it('contains no file:// URLs anywhere', () => {
    const doc = loadGolden();
    const html = renderMonthlyReport(doc);
    expect(html).not.toMatch(/file:\/\//);
  });

  it('contains no absolute local filesystem path (the design-system directory itself)', () => {
    const doc = loadGolden();
    const html = renderMonthlyReport(doc);
    // The CSS should carry no url('fonts/...') references at all once the
    // local @font-face rules are stripped, and no Windows drive-letter path
    // (a backslash never legitimately appears in this renderer's output --
    // unlike a bare "C:" prefix, which would false-positive against the
    // "https:" in the Google Fonts @import lines that stay untouched).
    expect(html).not.toMatch(/url\(['"]?fonts\//);
    expect(html).not.toContain('\\');
    expect(html).not.toMatch(/[A-Za-z]:[/\\](Users|home)[/\\]/i); // no Windows/POSIX user-home path
  });

  it('still renders successfully (fallback font stack carries the page, no throw)', () => {
    const doc = loadGolden();
    expect(() => renderMonthlyReport(doc)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scanForecastVocabulary — the fail-closed door helper (F7)
// ---------------------------------------------------------------------------

describe('scanForecastVocabulary — untagged forecast prose is caught when the forecast is not provided-current (F7)', () => {
  it('returns [] when the forecast IS provided-current, regardless of vocabulary present', () => {
    const doc: RenderReportDataDocument = {
      forecast: { state: 'provided_current' },
      sections: [{ id: 'sec.a', display_text: 'Revenue is projected to grow, running ahead of plan.' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual([]);
  });

  it('flags an UNTAGGED section whose display_text carries forecast vocabulary', () => {
    const doc: RenderReportDataDocument = {
      sections: [{ id: 'sec.a', display_text: 'The account is running ahead of its forecast.' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual(['sec.a']);
  });

  it('flags a claim whose text carries forecast vocabulary', () => {
    const doc: RenderReportDataDocument = {
      claims: [{ id: 'claim.a', text: 'Spend is projected to rise next month.' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual(['claim.a']);
  });

  it('does NOT flag a section explicitly tagged kind: "forecast" -- opt-in suppression stays as-is', () => {
    const doc: RenderReportDataDocument = {
      sections: [{ id: 'sec.fc', kind: 'forecast', display_text: 'Running ahead of forecast, projected to beat plan.' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual([]);
  });

  it('resolves a shared_block_ref section to the BLOCK it points at (never the pointer section\'s own ignored fields)', () => {
    const doc: RenderReportDataDocument = {
      shared_blocks: {
        'shared.bl': { id: 'shared.bl', display_text: 'Behind forecast this month.' },
      },
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.bl' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual(['shared.bl']);
  });

  it('does not flag a shared block tagged kind: "forecast" even when referenced by an untagged section', () => {
    const doc: RenderReportDataDocument = {
      shared_blocks: {
        'shared.bl': { id: 'shared.bl', kind: 'forecast', display_text: 'Ahead of forecast, projected to beat plan.' },
      },
      sections: [{ id: 'sec.a', shared_block_ref: 'shared.bl' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual([]);
  });

  it('returns [] on plain prose with no forecast vocabulary at all', () => {
    const doc: RenderReportDataDocument = {
      sections: [{ id: 'sec.a', display_text: 'Revenue held steady month over month.' }],
    };
    expect(scanForecastVocabulary(doc)).toEqual([]);
  });
});

describe('renderMonthlyReport — permissive on absent optional data', () => {
  it('renders a document with only the required top-level fields', () => {
    const doc: RenderReportDataDocument = {
      figures: [figure({ id: 'f.a', label: 'A', value: 10 })],
      sections: [{ id: 'sec.a', figure_refs: ['f.a'] }],
    };
    expect(() => renderMonthlyReport(doc)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit vocabulary — the analysis engine's tokens, not just ours
//
// Figures extracted from an analysis envelope carry the ENGINE's unit
// vocabulary: `extract.ts` passes `component.valueUnit` straight through onto
// every bridge-leg figure. Anything the renderer did not recognize fell
// through to a bare number, so a rate, a ratio and a count became
// indistinguishable on the page. All values below are synthetic.
// ---------------------------------------------------------------------------

/** A figure carrying just a unit + value — the two inputs that decide the
 *  formatted text (precision is exercised explicitly where it matters). */
function unitFig(
  unit: string | undefined,
  value: number,
  extra: Partial<FigureCommon & FigureDisplay> = {},
): FigureCommon & FigureDisplay {
  return { id: 'f.u', label: 'U', unit, value, ...extra } as unknown as FigureCommon & FigureDisplay;
}

describe('formatFigureValue — engine HorizontalBridgeValueUnit tokens (the vocabulary that reaches us today)', () => {
  it('currency-2dp renders money at TWO decimals, not the 0dp `currency` rounding', () => {
    // ASP / CPC / CPA / AOV. Before: fell through to raw -> "12.34".
    expect(formatFigureValue(unitFig('currency-2dp', 12.34), 'USD')).toBe('$12.34');
    // Sub-dollar CPC is the case a 0dp render destroys entirely.
    expect(formatFigureValue(unitFig('currency-2dp', 0.85), 'USD')).toBe('$0.85');
  });

  it('currency-2dp honors the document currency symbol', () => {
    expect(formatFigureValue(unitFig('currency-2dp', 12.34), 'GBP')).toBe('£12.34');
  });

  it('number renders a grouped whole number', () => {
    expect(formatFigureValue(unitFig('number', 48210.4), 'USD')).toBe('48,210');
  });

  it('number-2dp keeps sub-integer movement that `number` would erase', () => {
    // The engine added this precisely so 0.69 -> 1.47 does not display "1 -> 1".
    expect(formatFigureValue(unitFig('number-2dp', 0.69), 'USD')).toBe('0.69');
    expect(formatFigureValue(unitFig('number-2dp', 1.47), 'USD')).toBe('1.47');
  });
});

describe('formatFigureValue — engine DisplayUnit + our own extractor tokens', () => {
  it('percent-points renders an already-whole points value with its affix', () => {
    expect(formatFigureValue(unitFig('percent-points', 2.4), 'USD')).toBe('2.4 pts');
  });

  it('points_fraction converts TACoS rate units to points (engine: 0.01 = 1 pt)', () => {
    // Worked example: the extractor emits tacosDecomposition legs in rate
    // units. 0.031 rate units = 3.1 points. Before: bare "0.031", which reads
    // as a rounding artifact rather than a three-point move.
    expect(formatFigureValue(unitFig('points_fraction', 0.031), 'USD')).toBe('3.1 pts');
    expect(formatFigureValue(unitFig('points_fraction', -0.031), 'USD')).toBe('−3.1 pts');
  });
});

describe('formatFigureValue — engine ContributionUnit tokens (stored-scale conversions pinned)', () => {
  it('bps renders as-stored, integer-rounded, with its token', () => {
    // The engine stores contribution x 10^4 and renders `bps` as-stored.
    expect(formatFigureValue(unitFig('bps', 1654), 'USD')).toBe('1,654 bps');
  });

  it('bps-1dp keeps the one decimal that whole points round away', () => {
    // The CTR case: contributions are hundredths of a point, so `pts` had
    // rounded every driver row to "0.0 pts".
    expect(formatFigureValue(unitFig('bps-1dp', 4.7), 'USD')).toBe('4.7 bps');
  });

  it('pts reads as points, exactly like its two near-synonyms (red team 2026-08-18)', () => {
    // REVERSED from the first cut, which applied the engine's stored/100
    // contribution scale and rendered this 2.4 as "0.0 pts" -- silently
    // destroying the magnitude. Nothing carrying that scale can reach this
    // renderer (the contribution vocabulary is never serialized into an
    // envelope), so the only documents that CAN carry `pts` are authored by
    // hand or by the model, where the plain reading is what was meant.
    // Three tokens for one idea, one of which quietly zeroes the number, is
    // a trap; they must agree.
    expect(formatFigureValue(unitFig('pts', 2.4), 'USD')).toBe('2.4 pts');
    expect(formatFigureValue(unitFig('points', 2.4), 'USD')).toBe('2.4 pts');
    expect(formatFigureValue(unitFig('percent-points', 2.4), 'USD')).toBe('2.4 pts');
  });

  it('ratio-2dp reads as a plain multiple, for the same reason', () => {
    // Was stored/10000, which rendered a 2.06x ROAS as "0.00x".
    expect(formatFigureValue(unitFig('ratio-2dp', 2.06), 'USD')).toBe('2.06×');
  });

  it('does NOT apply the contribution divide to the overloaded tokens', () => {
    // `currency-2dp` and `weeks` exist in BOTH the level and contribution
    // vocabularies with different scales. The level reading is the one that
    // reaches this renderer, so a real $0.85 CPC must not become $0.000085.
    expect(formatFigureValue(unitFig('currency-2dp', 0.85), 'USD')).toBe('$0.85');
    expect(formatFigureValue(unitFig('weeks', 6.2), 'USD')).toBe('6.2');
  });
});

describe('formatFigureValue — an unknown unit is visible, never a silent bare number', () => {
  it('renders the number AND the unrecognized token', () => {
    expect(formatFigureValue(unitFig('furlongs', 4.7), 'USD')).toBe('4.7 furlongs');
  });

  it('a garbage unit still renders the number and does not read as a plain count', () => {
    const text = formatFigureValue(unitFig('!!!@@@', 4.7), 'USD');
    expect(text).toBe('4.7 [unknown unit]');
    expect(text).not.toBe('4.7');
  });

  it('allowlists the OUTPUT alphabet so an untrusted unit cannot carry markup', () => {
    const text = formatFigureValue(unitFig('<script>alert(1)</script>', 4.7), 'USD');
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(text).toBe('4.7 scriptalert1script');
  });

  it('bounds an absurdly long unit token', () => {
    const text = formatFigureValue(unitFig('a'.repeat(200), 4.7), 'USD');
    expect(text).toBe(`4.7 ${'a'.repeat(24)}`);
  });

  it('a figure with NO unit at all still renders, as a bare number', () => {
    // An absent unit asserts "this figure genuinely has no unit" -- unchanged.
    expect(formatFigureValue(unitFig(undefined, 4.7), 'USD')).toBe('4.7');
    expect(formatFigureValue(unitFig('', 4.7), 'USD')).toBe('4.7');
    expect(formatFigureValue(unitFig('raw', 4.7), 'USD')).toBe('4.7');
  });

  it('an unknown unit still carries sign and suffix handling', () => {
    expect(formatFigureValue(unitFig('furlongs', -4.7), 'USD')).toBe('−4.7 furlongs');
    expect(formatFigureValue(unitFig('furlongs', 4.7, { signed: true }), 'USD')).toBe('+4.7 furlongs');
  });

  it('a NON-STRING unit degrades instead of throwing (red team 2026-08-18)', () => {
    // `unit` is typed `string?` but the document is untrusted JSON read with
    // a bare cast, and validateReportData never type-checks it. Before the
    // unit-carrying fallback existed the default branch never touched
    // `unit`, so a malformed figure still rendered; calling `.replace` on a
    // number turned it into a TypeError that escaped the whole render and
    // wrote NO HTML -- a malformed figure taking down the page. The value
    // guard in this same function already handles exactly this class.
    for (const bad of [42, ['pts'], {}, true, null] as unknown[]) {
      const fig = { id: 'f.bad', label: 'Bad', value: 4.7, unit: bad } as never;
      expect(() => formatFigureValue(fig, 'USD')).not.toThrow();
      expect(formatFigureValue(fig, 'USD')).toContain('4.7');
    }
  });

  it('a whole document with a non-string unit still renders a page', () => {
    // The end-to-end version: the failure that mattered was not the thrown
    // TypeError, it was `report render` writing no file at all.
    const doc = {
      figures: [{ id: 'f.bad', label: 'Revenue', value: 1234.5, unit: 42 }],
      sections: [
        {
          id: 'sec.only',
          title: 'Only section',
          figure_refs: ['f.bad'],
          claim_refs: [],
          caveats_rendered: [],
          display_text: 'A figure with a malformed unit.',
        },
      ],
    } as never;
    const html = renderMonthlyReport(doc);
    // No thousands separator: an unrecognized unit keeps the raw-number
    // formatting it always had, and only gains the token.
    expect(html).toContain('1234.5');
    expect(html).toContain('Only section');
  });
});

describe('formatFigureValue — the pre-existing unit cases are unchanged (regression guard)', () => {
  // Every unit the renderer handled before this change, pinned so the
  // additive engine-vocabulary work cannot have moved one of them.
  const cases: [string, number, string][] = [
    ['currency', 20081, '$20,081'],
    ['currency_abbrev', 2400000, '$2.4M'],
    ['currency_abbrev', 2400, '$2.4K'],
    ['currency_abbrev', 240, '$240'],
    ['count', 48210, '48,210'],
    ['ratio', 0.1234, '12.3%'],
    ['percent', 12.34, '12.3%'],
    ['points', 2.4, '2.4 pts'],
    ['weeks', 6.2, '6.2'],
    ['raw', 4.7, '4.7'],
  ];
  for (const [unit, value, expected] of cases) {
    it(`${unit} still renders ${expected}`, () => {
      expect(formatFigureValue(unitFig(unit, value), 'USD')).toBe(expected);
    });
  }

  it('item_days still renders "item-day(s)", never bare "N days" (UNIT-1)', () => {
    expect(formatFigureValue(unitFig('item_days', 3), 'USD')).toBe('3 item-days');
    expect(formatFigureValue(unitFig('item_days', 1), 'USD')).toBe('1 item-day');
  });

  it('explicit precision still overrides the per-unit default', () => {
    expect(formatFigureValue(unitFig('currency', 12.345, { precision: 2 }), 'USD')).toBe('$12.35');
    expect(formatFigureValue(unitFig('ratio', 0.1234, { precision: 2 }), 'USD')).toBe('12.34%');
  });
});

describe('renderMonthlyReport — an engine-unit figure reaches the page carrying its unit', () => {
  it('a bridge-leg figure carrying currency-2dp is no longer a naked number', () => {
    const doc: RenderReportDataDocument = {
      currency: 'USD',
      figures: [
        figure({
          id: 'f.leg',
          label: 'ASP leg',
          value: 12.34,
          unit: 'currency-2dp',
          source_path: 'envelope:insights[0].insight.components[0].impact',
        }),
      ],
      sections: [{ id: 'sec.leg', figure_refs: ['f.leg'] }],
    };
    expect(renderMonthlyReport(doc)).toContain('$12.34');
  });

  it('an unknown unit surfaces its token in the page', () => {
    const doc: RenderReportDataDocument = {
      currency: 'USD',
      figures: [figure({ id: 'f.odd', label: 'Odd figure', value: 4.7, unit: 'zorkmids' })],
      sections: [{ id: 'sec.odd', figure_refs: ['f.odd'] }],
    };
    expect(renderMonthlyReport(doc)).toContain('4.7 zorkmids');
  });
});

describe('a document-authored `precision` degrades, never crashes the render', () => {
  /**
   * ⚠ THE EXTRACTOR IS THE WRONG SEAM FOR THIS GUARD. `readServedFormat`
   * range-checks the precision it reads off an ENVELOPE, but `report render`
   * never reads envelopes -- it reads report-data.json, which SKILL.md Step 5
   * has the MODEL compose by hand. A precision authored there goes straight to
   * toFixed / toLocaleString, and both throw a RangeError outside 0..100,
   * which kills the whole render and writes NO HTML at all.
   */
  const docWithPrecision = (precision: unknown): RenderReportDataDocument =>
    ({
      meta: { brand: 'Example', period: 'Jun 2026' },
      figures: [
        {
          id: 'f1',
          label: 'Revenue',
          value: 1000,
          unit: 'currency',
          precision,
          basis: 'ordered_revenue',
          source_path: 'envelope:metrics[0].totals.p1',
        },
      ],
      sections: [
        { id: 's', title: 'S', prose: 'x', figure_refs: ['f1'], caveats_rendered: [] },
      ],
    }) as unknown as RenderReportDataDocument;

  it.each([[1e9], [101], [-1], [NaN], ['2'], [null]])(
    'renders rather than throwing on precision %p',
    (precision) => {
      expect(() => renderMonthlyReport(docWithPrecision(precision))).not.toThrow();
      expect(renderMonthlyReport(docWithPrecision(precision)).length).toBeGreaterThan(0);
    },
  );

  it('falls back to the unit’s own default precision instead of inventing one', () => {
    // currency defaults to 0dp, so the garbage precision must leave "$1,000",
    // not a differently-rounded number.
    expect(renderMonthlyReport(docWithPrecision(1e9))).toContain('$1,000');
  });

  it('still honours a precision that IS in domain', () => {
    expect(renderMonthlyReport(docWithPrecision(2))).toContain('$1,000.00');
  });

  /** `weeks` defaults to 1dp, unlike currency's 0dp, so a precision that is
   *  wrongly accepted as 0 is visible as "12" where "12.4" belongs. */
  const weeksDoc = (precision: unknown) =>
    ({
      meta: { brand: 'Example', period: 'Jun 2026' },
      figures: [
        {
          id: 'f1',
          label: 'Weeks',
          value: 12.4,
          unit: 'weeks',
          precision,
          basis: 'ordered_revenue',
          source_path: 'envelope:metrics[0].totals.p1',
        },
      ],
      sections: [{ id: 's', title: 'S', prose: 'x', figure_refs: ['f1'], caveats_rendered: [] }],
    }) as unknown as RenderReportDataDocument;

  it.each([[-0.5], [-0.9], [0.5], [1.5]])(
    'rejects the non-integer precision %p instead of truncating it into the valid range',
    (precision) => {
      // Math.trunc(-0.5) is -0, which PASSES a `>= 0` gate — so a nonsense
      // precision would silently become 0 decimals and OVERRIDE the unit's own
      // default rather than falling back to it. Checking integer-ness BEFORE
      // truncating is what closes that.
      expect(renderMonthlyReport(weeksDoc(precision))).toContain('12.4');
    },
  );

  it('treats an explicit -0 as the 0 the author meant, not as garbage', () => {
    // -0 IS an integer and reads as zero decimals; rejecting it would be
    // over-correction. The defect was fractional values truncating INTO range,
    // not a signed zero.
    expect(renderMonthlyReport(weeksDoc(-0))).toContain('12');
  });

  it('unused-doc guard: the in-domain path still applies the authored precision', () => {
    expect(renderMonthlyReport(weeksDoc(3))).toContain('12.400');
  });

});
