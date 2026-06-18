/**
 * Brand Context renderer — confidence-marker + scale-aware-sub-brand suite
 * (Phase 7 of the Brand Context pivot).
 *
 * Runs fully OFFLINE against the committed golden fixtures (no warehouse, no
 * auth, no network — everything routes through `dataDirOverride`). Asserts:
 *
 *   1. The composed page still renders EVERY section (no regression).
 *   2. Each registered brand field carries a confidence marker sourced from
 *      `resolveBrandFields` (✓ context / ⊙ brain / ◯ gap), and the page-level
 *      framing + legend are present.
 *   3. The provenance is correct per fixture (ACOS-primary vs TACOS-primary
 *      flips the tacos-target gap; brain-only fields render pre-filled).
 *   4. review.json carries a machine-readable `confidence` block matching the
 *      glyphs.
 *   5. Sub-brands render scale-aware: 1 inline, 2-4 list, 5+ roll-up.
 *   6. Gaps surface a paste-ready set hint.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBrandContextReport } from './brand-context-composer.js';
import {
  sectionSubBrands,
  type ReportState,
  type ResolvedFieldMap,
} from './brand-context-sections.js';
import { BRAND_FIELD_KEYS } from '../brain/read.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, '..', '..', '..', 'test', 'fixtures', 'golden-data-dir');
const DS_DIR = join(here, '..', '..', '..', 'assets', 'design-system');

// The renderer walks up for assets; in unit-test runs from src/ that walk
// can land outside the harness. Pin it so renderPage finds the CSS + logos.
beforeAll(() => {
  process.env.MIXSHIFT_DESIGN_SYSTEM_DIR = DS_DIR;
});

interface Composed {
  html: string;
  review: Record<string, any>;
  verdict: string;
}

async function compose(slug: string, brandName: string): Promise<Composed> {
  const res = await composeBrandContextReport({
    brandSlug: slug,
    brandName,
    runDate: '2026-06-18',
    theme: 'light',
    dataDirOverride: DATA_DIR,
  });
  const [html, reviewRaw] = await Promise.all([
    readFile(res.html_path, 'utf-8'),
    readFile(res.review_path, 'utf-8'),
  ]);
  return { html, review: JSON.parse(reviewRaw), verdict: res.verdict };
}

const FIXTURES: Array<{ slug: string; name: string }> = [
  { slug: 'goldenbrand-sc-acos', name: 'Tidewell Hydration' },
  { slug: 'goldenbrand-vc-tacos', name: 'Northgrove Coffee Roasters' },
];

// Every section's stable heading / sentinel — the page must keep rendering all
// of them after the confidence reframe (no section dropped).
const SECTION_SENTINELS = [
  'What we know, and how sure we are', // new confidence summary
  'What I know about this brand', // brand summary
  'Required fields', // review at a glance scorecard
  'Runtime inputs required',
  'Skill readiness',
  'What I&#39;m watching right now', // active conditions (apostrophe escaped)
  'Account snapshot',
  'Sub-brand structure',
  'Item groups by sub-brand',
  'Brand term dictionary',
  'ASIN negation corpora',
  'Seasonality &amp; tentpole calendar', // escaped ampersand
  'Attribution backfill calibration',
  'Detected anomalies (advisory)',
  'Brand identity (prose context)',
  'Missing context buckets', // open gaps
  'Schema coverage audit',
];

describe('brand-context render — no section dropped', () => {
  for (const { slug, name } of FIXTURES) {
    it(`${slug}: renders every section`, async () => {
      const { html } = await compose(slug, name);
      const missing = SECTION_SENTINELS.filter((s) => !html.includes(s));
      expect(missing).toEqual([]);
    });
  }
});

describe('brand-context render — confidence framing + legend', () => {
  for (const { slug, name } of FIXTURES) {
    it(`${slug}: page leads with the confidence framing + key`, async () => {
      const { html } = await compose(slug, name);
      expect(html).toContain('What we know about this brand, and how sure we are');
      expect(html).toContain('rc-conf-legend');
      // All three glyphs appear (legend + at least one field each).
      expect(html).toContain('✓');
      expect(html).toContain('⊙');
      expect(html).toContain('◯');
    });
  }
});

describe('brand-context render — provenance correctness', () => {
  it('sc-acos: context fields confirmed, brain-only fields pre-filled, tacos gap', async () => {
    const { review } = await compose('goldenbrand-sc-acos', 'Tidewell Hydration');
    const f = review.confidence.fields;
    // Tier-3 context fields → confirmed.
    expect(f.acos_target_pct.level).toBe('confirmed');
    expect(f.primary_metric.level).toBe('confirmed');
    expect(f.sub_brands.level).toBe('confirmed');
    expect(f.protected_terms.level).toBe('confirmed');
    // Tier-2 brain-only fields → pre-filled, with a fetched_at stamp.
    expect(f.monthly_budget.level).toBe('prefilled');
    expect(f.recent_spend_30d.level).toBe('prefilled');
    expect(f.hero_asins.level).toBe('prefilled');
    expect(typeof f.recent_spend_30d.fetched_at).toBe('string');
    // ACOS-primary fixture has no tacos target → gap.
    expect(f.tacos_target_pct.level).toBe('gap');
    // Counts are internally consistent.
    const { confirmed, prefilled, gap } = review.confidence;
    expect(confirmed + prefilled + gap).toBe(BRAND_FIELD_KEYS.length);
    expect(prefilled).toBe(5); // the 5 brain-only registry fields
  });

  it('vc-tacos: tacos target is confirmed (TACOS-primary)', async () => {
    const { review } = await compose('goldenbrand-vc-tacos', 'Northgrove Coffee Roasters');
    const f = review.confidence.fields;
    expect(f.tacos_target_pct.level).toBe('confirmed');
    expect(f.primary_metric.level).toBe('confirmed');
    expect(f.monthly_budget.level).toBe('prefilled');
  });
});

describe('brand-context render — set hints on gaps', () => {
  it('sc-acos: a gap field exposes a paste-ready set snippet', async () => {
    const { html } = await compose('goldenbrand-sc-acos', 'Tidewell Hydration');
    expect(html).toContain('rc-set-hint');
    // The tacos gap snippet is keyed to the field + brand.
    expect(html).toContain('set tacos_target_pct for goldenbrand-sc-acos');
  });
});

// ---------------------------------------------------------------------------
// Scale-aware sub-brand rendering (unit — minimal ReportState).
// ---------------------------------------------------------------------------

function stateWithSubBrands(
  subs: Array<{ slug: string; name: string; item_groups?: string[] }>,
): ReportState {
  const resolved = Object.fromEntries(
    BRAND_FIELD_KEYS.map((k) => [k, null]),
  ) as ResolvedFieldMap;
  // Mark sub_brands as confirmed so the marker path is exercised.
  resolved.sub_brands =
    subs.length > 0 ? { value: subs, source: 'context' } : null;
  return {
    brand_slug: 'b',
    brand_name: 'B',
    run_date: '2026-06-18',
    sources: {
      context: { sub_brands: subs },
      context_path: '',
      narrative_md: null,
      narrative_path: '',
      brand_intelligence: null,
      brand_intelligence_path: '',
      corpora_summary: [],
      corpora_path: '',
      enrichment: null,
      last_updated: null,
    },
    narrative_sections: {},
    coverage: {
      rows: [],
      required_present: 0,
      required_total: 0,
      recommended_present: 0,
      recommended_total: 0,
      stale_count: 0,
      open_gaps_count: 0,
    },
    verdict: 'GREEN',
    verdict_reason: '',
    buckets: [],
    skill_readiness: [],
    resolved_fields: resolved,
  };
}

describe('brand-context render — scale-aware sub-brands', () => {
  it('1 sub-brand → inline one-liner (no list, no table)', () => {
    const html = sectionSubBrands(
      stateWithSubBrands([{ slug: 'alpha', name: 'Alpha', item_groups: ['x'] }]),
    );
    expect(html).toContain('One sub-brand');
    expect(html).toContain('Alpha');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('rc-table');
  });

  it('2-4 sub-brands → compact list (no giant table)', () => {
    const subs = [1, 2, 3, 4].map((i) => ({
      slug: `s${i}`,
      name: `Sub${i}`,
      item_groups: [`g${i}`],
    }));
    const html = sectionSubBrands(stateWithSubBrands(subs));
    expect(html).toContain('<ul');
    expect(html).toContain('Sub4');
    expect(html).not.toContain('rc-table');
  });

  it('5+ sub-brands → summarized roll-up (count + names, no table)', () => {
    const subs = [1, 2, 3, 4, 5, 6].map((i) => ({
      slug: `s${i}`,
      name: `Sub${i}`,
      item_groups: [`g${i}`, `h${i}`],
    }));
    const html = sectionSubBrands(stateWithSubBrands(subs));
    expect(html).toContain('<strong>6</strong> sub-brands');
    expect(html).toContain('item group'); // total item-group count line
    expect(html).toContain('Sub6'); // every name still present
    expect(html).not.toContain('rc-table');
  });

  it('0 sub-brands with no provenance → gap empty-state + set hint', () => {
    const html = sectionSubBrands(stateWithSubBrands([]));
    expect(html).toContain('rc-empty');
    expect(html).toContain('rc-set-hint');
    expect(html).toContain('set sub_brands for b');
  });
});
