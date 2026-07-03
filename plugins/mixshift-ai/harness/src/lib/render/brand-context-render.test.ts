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
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { composeBrandContextReport } from './brand-context-composer.js';
import {
  sectionSubBrands,
  type ReportState,
  type ResolvedFieldMap,
} from './brand-context-sections.js';
import { BRAND_FIELD_KEYS } from '../brain/read.js';
import { assembleBrain } from '../brain/assemble.js';
import { saveBrain } from '../brain/read.js';

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
    // ACOS-primary fixture has no tacos goal → gap.
    expect(f.tacos_goal_pct.level).toBe('gap');
    // Counts are internally consistent.
    const { confirmed, prefilled, gap } = review.confidence;
    expect(confirmed + prefilled + gap).toBe(BRAND_FIELD_KEYS.length);
    expect(prefilled).toBe(5); // the 5 brain-only registry fields
  });

  it('vc-tacos: tacos goal is confirmed (TACOS-primary, via the legacy tacos_target_pct alias)', async () => {
    const { review } = await compose('goldenbrand-vc-tacos', 'Northgrove Coffee Roasters');
    const f = review.confidence.fields;
    // This fixture's context.yaml still sets management.tacos_target_pct
    // (the deprecated alias) — proves the loader's normalization makes it
    // resolve as confirmed under the canonical tacos_goal_pct key.
    expect(f.tacos_goal_pct.level).toBe('confirmed');
    expect(f.primary_metric.level).toBe('confirmed');
    expect(f.monthly_budget.level).toBe('prefilled');
  });
});

// ---------------------------------------------------------------------------
// Brain-only early state (FIX 2): a brand keyed via `brand key add` has its
// Tier-2 brain auto-fetched but NO context.yaml. It must render a non-RED
// "auto-discovered" early state — not the RED "fix context.yaml" schema-fail —
// while the ⊙ brain confidence rendering stays intact.
// ---------------------------------------------------------------------------

const BRAIN_ONLY_SLUG = 'goldenbrand-brain-only';

/** Compose a brand that has a brain but no context.yaml, in an isolated temp
 *  data dir. Mirrors the post-`brand key add`, pre-cold-start state. */
async function composeBrainOnly(): Promise<Composed & { verdictReason: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mx-brain-only-'));
  try {
    // Build + persist a Tier-2 brain (seller scalars present), no context.yaml.
    const brain = assembleBrain({
      brandSlug: BRAIN_ONLY_SLUG,
      sellerRows: [
        {
          ID: 900303,
          ACOSTarget: '23.0',
          MerchantAlias: 'Brookhaven Provisions US',
          Name: 'Brookhaven Provisions',
          MonthlyBudget: 28000,
          MarketPlaceName: 'US',
          DefaultCurrencyCode: 'USD',
        },
      ],
      sellerSproc: 'sp_brain_seller_fetch',
      primarySellerId: 900303,
      generator: 'plugin@test',
      now: new Date('2026-06-16T13:40:00.000Z'),
    });
    await saveBrain(brain, dir);

    const res = await composeBrandContextReport({
      brandSlug: BRAIN_ONLY_SLUG,
      brandName: 'Brookhaven Provisions',
      runDate: '2026-06-18',
      theme: 'light',
      dataDirOverride: dir,
    });
    const [html, reviewRaw] = await Promise.all([
      readFile(res.html_path, 'utf-8'),
      readFile(res.review_path, 'utf-8'),
    ]);
    return {
      html,
      review: JSON.parse(reviewRaw),
      verdict: res.verdict,
      verdictReason: res.verdict_reason,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('brand-context render — brain-only early state (FIX 2)', () => {
  it('does NOT render the RED schema-fail verdict for a brain-only brand', async () => {
    const { verdict, verdictReason, html } = await composeBrainOnly();
    expect(verdict).not.toBe('RED');
    // The old jarring message must be gone.
    expect(verdictReason).not.toContain('Schema validator failed');
    expect(html).not.toContain('Schema validator failed');
  });

  it('marks downstream skills Ready (brain unblocks), not Blocked by context', async () => {
    const { review } = await composeBrainOnly();
    const readiness =
      (review as { skill_readiness?: Array<{ skill: string; status: string; notes: string }> })
        .skill_readiness ?? [];
    // The unravel's contract: a brain-only brand runs every analytical skill
    // from the brain + defaults; nothing reads "Blocked by context".
    const analytical = readiness.filter((r) => r.skill !== 'mx-monthly-report');
    expect(analytical.length).toBe(3);
    for (const r of analytical) {
      expect(r.status).toBe('Ready');
      expect(r.notes.toLowerCase()).toContain('brain');
    }
    expect(readiness.find((r) => r.skill === 'mx-monthly-report')?.status).toContain('Ready');
    expect(readiness.every((r) => !r.status.toLowerCase().includes('blocked'))).toBe(true);
  });

  it('renders the ⊙ auto-discovered early-state framing (non-RED verdict + reframed reason)', async () => {
    const { verdict, verdictReason, html } = await composeBrainOnly();
    // OBSERVATIONAL is the non-RED early-state verdict (blue "runtime" tone).
    expect(verdict).toBe('OBSERVATIONAL');
    expect(verdictReason.toLowerCase()).toContain('auto-discovered');
    expect(verdictReason).toContain('confirm and enrich');
    // The ⊙ brain confidence rendering (Phase 7) must still work: brain-sourced
    // seller scalars resolve as pre-filled, and the glyph renders.
    expect(html).toContain('⊙');
    expect(html).toContain('What we know, and how sure we are');
  });

  it('resolves brain-sourced fields as pre-filled, with context fields as gaps', async () => {
    const { review } = await composeBrainOnly();
    const f = review.confidence.fields;
    // Brain supplies these (seller row) → pre-filled.
    expect(f.acos_target_pct.level).toBe('prefilled');
    expect(f.monthly_budget.level).toBe('prefilled');
    expect(f.marketplace.level).toBe('prefilled');
    // Tier-3-only fields with no context → gaps (not errors).
    expect(f.primary_metric.level).toBe('gap');
    expect(f.protected_terms.level).toBe('gap');
    // At least one field resolved from the brain (the early-state trigger).
    expect(review.confidence.prefilled).toBeGreaterThan(0);
  });

  it('still renders every section in the early state (no section dropped)', async () => {
    const { html } = await composeBrainOnly();
    const missing = SECTION_SENTINELS.filter((s) => !html.includes(s));
    expect(missing).toEqual([]);
  });
});

describe('brand-context render — malformed context stays RED (FIX 2 guard)', () => {
  it('a PRESENT but schema-invalid context.yaml still renders RED', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mx-bad-ctx-'));
    try {
      // context.yaml present but schema-invalid (missing required structure) →
      // genuinely broken, must stay RED with the schema-fail message. No brain.
      const brandDir = join(dir, 'clients', 'goldenbrand-bad-context');
      await mkdir(brandDir, { recursive: true });
      await writeFile(
        join(brandDir, 'context.yaml'),
        stringifyYaml({ schema_version: 1, totally: 'not a valid context' }),
        'utf-8',
      );
      const res = await composeBrandContextReport({
        brandSlug: 'goldenbrand-bad-context',
        brandName: 'Broken Brand',
        runDate: '2026-06-18',
        theme: 'light',
        dataDirOverride: dir,
      });
      expect(res.verdict).toBe('RED');
      expect(res.verdict_reason).toContain('Schema validator failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('brand-context render — set hints on gaps', () => {
  it('sc-acos: a gap field exposes a paste-ready set snippet', async () => {
    const { html } = await compose('goldenbrand-sc-acos', 'Tidewell Hydration');
    expect(html).toContain('rc-set-hint');
    // The tacos gap snippet is keyed to the field + brand (canonical field
    // name — the hint always points at tacos_goal_pct, never the deprecated
    // tacos_target_pct alias).
    expect(html).toContain('set tacos_goal_pct for goldenbrand-sc-acos');
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
