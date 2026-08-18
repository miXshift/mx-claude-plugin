import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFigures, checkFigures, CompositeSelectionError, COMPOSITE_SELECTIONS } from './extract.js';
import type { ExtractDocument, ExtractedFigure, CompositeSelection } from './extract.js';
// The unit a figure carries is only VISIBLE in rendered output -- the
// report-contract validator checks claim/figure relationships, never units --
// so the end-to-end block at the bottom of this file renders for real.
import { renderMonthlyReport } from './render-report.js';
import type { RenderReportDataDocument } from './render-report.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

function byId(out: ExtractDocument): Map<string, ExtractedFigure> {
  return new Map(out.figures.map((f) => [f.id, f]));
}

// ---------------------------------------------------------------------------
// (a) extraction over the anonymized envelope fixture
// ---------------------------------------------------------------------------

describe('extractFigures over envelope-minimal.json (ops total-scope + crossDomain + evidence)', () => {
  const doc = loadFixture('envelope-minimal.json');
  const out = extractFigures(doc);
  const figs = byId(out);

  it('carries the envelope source metadata', () => {
    expect(out.schema_version).toBe('2.0-draft');
    expect(out.source.bridgeDomain).toBe('ops');
    expect(out.source.bridgeRunId).toBe('run-example-0001');
    expect(out.source.companionRunId).toBe('run-example-0002');
    expect(out.source.currency).toBe('USD');
    expect(out.source.entityKey).toBeUndefined();
  });

  it('emits p1/p2/delta figures for every total-scope metric, correctly namespaced and unit/basis-tagged', () => {
    expect(figs.get('ops.ops.p1')).toMatchObject({ value: 100000, unit: 'currency', basis: 'ordered_revenue' });
    expect(figs.get('ops.ops.p2')).toMatchObject({ value: 144000, unit: 'currency', basis: 'ordered_revenue' });
    expect(figs.get('ops.ops.delta')).toMatchObject({ value: 44000, unit: 'currency', basis: 'ordered_revenue' });
    expect(figs.get('ops.units.delta')).toMatchObject({ value: 1000, unit: 'count', basis: 'ordered_units' });
    expect(figs.get('ops.sessions.delta')).toMatchObject({ value: 2000, unit: 'count', basis: 'sessions' });
    // WAS `unit: 'ratio'`, which PINNED A DEFECT: 0.05 is a five-POINT move
    // (20% -> 25%), and 'ratio' rendered it "5.0%" -- read as a 5% relative
    // rise, and in a different denomination from the very legs that foot to
    // it. The engine declares `deltaUnit: 'pts'` for every 'percent' metric.
    // Levels stay 'ratio' (asserted below).
    expect(figs.get('ops.conversion.delta')).toMatchObject({
      value: 0.05,
      unit: 'points_fraction',
      basis: 'sessions',
    });
    expect(figs.get('ops.conversion.p1')).toMatchObject({ value: 0.2, unit: 'ratio' });
    expect(figs.get('ops.buy_box.delta')).toMatchObject({ value: -0.01, unit: 'points_fraction' });
    // ASP: the engine registry declares display 'currency-2dp' / decimals 2,
    // so the interim map carries 'currency-2dp' and the renderer keeps the
    // cents. 'currency' (0dp) had been rounding them away.
    expect(figs.get('ops.ops_per_unit.delta')).toMatchObject({ value: -2, unit: 'currency-2dp', basis: 'ordered_revenue' });
    expect(figs.get('ops.lost_sales.delta')).toMatchObject({ value: 1000, unit: 'currency', basis: 'ordered_revenue' });
    expect(figs.get('ops.weeks_of_cover.delta')).toMatchObject({ unit: 'weeks' });
  });

  it('attaches a non-complete population to a delta figure whose metric carries topDrivers', () => {
    const delta = figs.get('ops.ops.delta');
    expect(delta?.population?.complete).toBe(false);
    expect(delta?.population?.members).toEqual([
      { key: 'item-group-a', delta: 20000 },
      { key: 'item-group-b', delta: 5000 },
    ]);
  });

  it('does not attach a population when topDrivers is empty', () => {
    expect(figs.get('ops.sessions.delta')?.population).toBeUndefined();
  });

  it('rides every envelope caveat id on every delta figure', () => {
    const delta = figs.get('ops.ops.delta');
    expect(delta?.caveats).toHaveLength(3);
    expect(delta?.caveats).toEqual(
      expect.arrayContaining(['env.filtered_scope.0', 'env.surge_window.1', 'env.matched_window.2']),
    );
    // p1/p2 (level) figures do NOT carry the comparison-period caveats
    expect(figs.get('ops.ops.p1')?.caveats).toEqual([]);
  });

  it('emits bridge leg figures per insight variant, namespaced ops.bridge.<metric>.<variant>.<component>', () => {
    expect(figs.get('ops.bridge.ops.primary.sessions')).toMatchObject({ value: 20000, footing_ok: true, net_change: 44000 });
    expect(figs.get('ops.bridge.ops.primary.conversion')).toMatchObject({ value: 15000 });
    expect(figs.get('ops.bridge.ops.primary.ops_per_unit')).toMatchObject({ value: 9000 });
    // total-scope bridge legs are emitted for BOTH variants (no secondary-skip
    // at total scope -- that rule is entity-scope only)
    expect(figs.get('ops.bridge.ops.secondary.units')).toMatchObject({ value: 35000 });
    expect(figs.get('ops.bridge.ops.secondary.ops_per_unit')).toMatchObject({ value: 9000 });
    // lost_sales only has a secondary variant in this envelope; total scope
    // does not skip it (again, entity-scope only rule)
    expect(figs.get('ops.bridge.lost_sales.secondary.oos_days')).toMatchObject({ value: -500 });
  });

  it('drops the duplicate (metricKey, variant) insight, keeping only the first-seen legs', () => {
    // the fixture's trailing duplicate ops/primary/total insight carries a
    // bogus 999999 impact on "sessions" -- if dedup broke, this value would
    // win or duplicate the figure id
    expect(figs.get('ops.bridge.ops.primary.sessions')?.value).toBe(20000);
    const sessionsLegs = out.figures.filter((f) => f.id === 'ops.bridge.ops.primary.sessions');
    expect(sessionsLegs).toHaveLength(1);
  });

  it('emits crossDomain duo.* figures (tacos, attributedShare, paidPressure, aspVsAdAov)', () => {
    expect(figs.get('duo.tacos.p1')).toMatchObject({ value: 0.15, unit: 'ratio', basis: 'cross_domain_joined' });
    expect(figs.get('duo.tacos.p2')).toMatchObject({ value: 0.12 });
    // WAS `unit: 'points'`, and that expectation PINNED A DEFECT: the engine
    // computes `deltaPts` as `p2 - p1` over a RATIO pair, so this -0.03 is a
    // three-POINT move stored as a fraction. Under `points` (an
    // already-whole number) the renderer printed "0.0 pts" and erased it.
    // See the `changeUnitOf` call in extract.ts's crossDomain solo blocks.
    expect(figs.get('duo.tacos.delta_pts')).toMatchObject({ value: -0.03, unit: 'points_fraction' });
    expect(figs.get('duo.attributedShare.delta_pts')).toMatchObject({ value: 0.02, unit: 'points_fraction' });
    expect(figs.get('duo.paidPressure.p1')).toMatchObject({ value: 0.55 });
    // WAS `unit: 'currency'` (0dp), another pinned defect: this block IS
    // `pair(ops, 'ops_per_unit')` / `pair(ads, 'ad_aov')`, both of which the
    // engine registry declares 'currency-2dp'. At 0dp a $59.38 ad AOV printed
    // "$59" -- the cents are the whole point of a per-unit money metric.
    expect(figs.get('duo.asp.p1')).toMatchObject({ value: 50, unit: 'currency-2dp' });
    expect(figs.get('duo.adAov.p2')).toMatchObject({ value: 59.38, unit: 'currency-2dp' });
  });

  it('emits the cross-domain tacos bridge legs without a footing_ok flag (Python source never sets one there)', () => {
    const leg = figs.get('duo.bridge.tacos.primary.ad_cpc');
    expect(leg).toMatchObject({ value: -0.01, unit: 'points_fraction', net_change: -0.03 });
    expect(leg?.footing_ok).toBeUndefined();
  });

  it('never reads crossDomain.ads (it is unused, structural-only data on the real envelope)', () => {
    expect(figs.has('ads.ad_spend.p1')).toBe(false);
    expect(figs.has('duo.spend.p1')).toBe(false);
  });

  it('checkFigures reports zero problems on the golden fixture', () => {
    expect(checkFigures(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) caveat severity mapping
// ---------------------------------------------------------------------------

describe('caveat severity mapping (CAVEAT_SEVERITY, interim-until-catalog)', () => {
  it('maps each known kind to its documented severity, and an unknown kind to disclosure', () => {
    const doc = {
      envelope: {
        bridgeDomain: 'ops',
        caveats: [
          { kind: 'filtered_scope', message: 'a' },
          { kind: 'decomposition_degraded', message: 'b' },
          { kind: 'surge_window', message: 'c' },
          { kind: 'dark_run', message: 'd' },
          { kind: 'restatement', message: 'e' },
          { kind: 'matched_window', message: 'f' },
          { kind: 'something_new', message: 'g' },
        ],
        metrics: [],
        insights: [],
      },
    };
    const out = extractFigures(doc);
    expect(out.caveat_registry['env.filtered_scope.0'].severity).toBe('blocking');
    expect(out.caveat_registry['env.decomposition_degraded.1'].severity).toBe('blocking');
    expect(out.caveat_registry['env.surge_window.2'].severity).toBe('disclosure');
    expect(out.caveat_registry['env.dark_run.3'].severity).toBe('disclosure');
    expect(out.caveat_registry['env.restatement.4'].severity).toBe('disclosure');
    expect(out.caveat_registry['env.matched_window.5'].severity).toBe('context');
    expect(out.caveat_registry['env.something_new.6'].severity).toBe('disclosure');
  });

  it('defaults an unnamed caveat kind to "unknown" in its registry id', () => {
    const doc = { envelope: { bridgeDomain: 'ops', caveats: [{ message: 'no kind' }], metrics: [], insights: [] } };
    const out = extractFigures(doc);
    expect(out.caveat_registry['env.unknown.0']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (c) entity-scope extraction
// ---------------------------------------------------------------------------

describe('entity-scope extraction (env.entityKey present)', () => {
  const entityDoc = {
    envelope: {
      bridgeDomain: 'ops',
      bridgeRunId: 'run-entity-0001',
      entityKey: 'item-group-a',
      basis: { revenue: 'ordered_revenue', units: 'ordered_units', traffic: 'sessions' },
      caveats: [{ kind: 'surge_window', message: 'entity-scoped surge' }],
      insights: [
        {
          metricKey: 'ops',
          variantKey: 'primary',
          p1Value: 20000,
          p2Value: 25000,
          netChange: 5000,
          pctChange: 0.25,
          components: [
            { key: 'sessions', impact: 3000, valueUnit: 'number' },
            { key: 'conversion', impact: 2000, valueUnit: 'percent' },
          ],
          footing: { ok: true },
        },
        {
          // secondary, non-lost_sales variant: skipped entirely at entity scope
          metricKey: 'ops',
          variantKey: 'secondary',
          p1Value: 20000,
          p2Value: 25000,
          netChange: 5000,
          components: [{ key: 'units', impact: 5000, valueUnit: 'number' }],
          footing: { ok: true },
        },
        {
          // secondary lost_sales: the ONE exception that is kept
          metricKey: 'lost_sales',
          variantKey: 'secondary',
          p1Value: 1000,
          p2Value: 1200,
          netChange: 200,
          components: [{ key: 'oos_days', impact: 200, valueUnit: 'number' }],
          footing: { ok: true },
        },
        {
          // duplicate (metricKey, variant) -- must be skipped
          metricKey: 'ops',
          variantKey: 'primary',
          p1Value: 20000,
          p2Value: 25000,
          netChange: 5000,
          components: [{ key: 'sessions', impact: 999999, valueUnit: 'number' }],
          footing: { ok: true },
        },
      ],
    },
  };
  const out = extractFigures(entityDoc);
  const figs = byId(out);

  it('routes to the entity extraction path and records entityKey in source', () => {
    expect(out.source.entityKey).toBe('item-group-a');
    expect(out.source.bridgeRunId).toBe('run-entity-0001');
  });

  it('namespaces figures under <domain>.entity.<key>.*', () => {
    expect(figs.get('ops.entity.item-group-a.ops.p1')).toMatchObject({ value: 20000, unit: 'currency' });
    expect(figs.get('ops.entity.item-group-a.ops.p2')).toMatchObject({ value: 25000 });
    expect(figs.get('ops.entity.item-group-a.ops.delta')).toMatchObject({ value: 5000 });
  });

  it('namespaces bridge legs under <domain>.entity.<key>.bridge.<metric>.<variant>.<component>', () => {
    expect(figs.get('ops.entity.item-group-a.bridge.ops.primary.sessions')).toMatchObject({ value: 3000, footing_ok: true, net_change: 5000 });
    expect(figs.get('ops.entity.item-group-a.bridge.ops.primary.conversion')).toMatchObject({ value: 2000 });
  });

  it('skips the secondary non-lost_sales variant entirely', () => {
    expect(figs.has('ops.entity.item-group-a.ops.secondary.p1')).toBe(false);
    expect(figs.has('ops.entity.item-group-a.bridge.ops.secondary.units')).toBe(false);
  });

  it('keeps the secondary lost_sales variant (the documented exception)', () => {
    expect(figs.get('ops.entity.item-group-a.lost_sales.delta')).toMatchObject({ value: 200 });
    expect(figs.get('ops.entity.item-group-a.bridge.lost_sales.secondary.oos_days')).toMatchObject({ value: 200 });
  });

  it('drops the duplicate (metricKey, variant) entry, keeping the first-seen legs', () => {
    expect(figs.get('ops.entity.item-group-a.bridge.ops.primary.sessions')?.value).toBe(3000);
  });

  it('rides envelope caveats onto entity delta figures too', () => {
    expect(figs.get('ops.entity.item-group-a.ops.delta')?.caveats).toEqual(['env.surge_window.0']);
  });
});

// ---------------------------------------------------------------------------
// (b) --check invariants: one passing + one failing case each
// ---------------------------------------------------------------------------

function minimalOut(overrides: Partial<ExtractDocument> = {}): ExtractDocument {
  return {
    schema_version: '2.0-draft',
    source: {
      bridgeRunId: 'r1',
      bridgeDomain: 'ops',
      engineVersion: null,
      schemaVersion: null,
      period: null,
      tenant: null,
      currency: 'USD',
      channel: null,
      companionRunId: null,
      selection: null,
    },
    caveat_registry: {},
    figures: [],
    ...overrides,
  };
}

function f(overrides: Partial<ExtractedFigure> & Pick<ExtractedFigure, 'id'>): ExtractedFigure {
  return {
    label: overrides.id,
    value: 1,
    unit: 'currency',
    basis: 'engine_default',
    source_path: `envelope:${overrides.id}`,
    confidence: 'published',
    caveats: [],
    ...overrides,
  };
}

describe('checkFigures: REQUIRED (id, label, value, unit, basis, source_path all present)', () => {
  it('passes when every required field is present', () => {
    const out = minimalOut({ figures: [f({ id: 'ops.ops.p1', value: 100 })] });
    expect(checkFigures(out).filter((p) => p.rule === 'REQUIRED')).toEqual([]);
  });

  it('fails when a required field is missing', () => {
    const broken = f({ id: 'ops.ops.p1' });
    // simulate a defect in the extractor: label dropped
    delete (broken as Partial<ExtractedFigure>).label;
    const out = minimalOut({ figures: [broken] });
    const problems = checkFigures(out);
    expect(problems).toContainEqual({ rule: 'REQUIRED', subject: 'ops.ops.p1', detail: 'missing label' });
  });
});

describe('checkFigures: NUMERIC (every figure value must be a finite number, never coerced)', () => {
  it('passes for an ordinary numeric value', () => {
    const out = minimalOut({ figures: [f({ id: 'ops.ops.p1', value: 100 })] });
    expect(checkFigures(out).filter((p) => p.rule === 'NUMERIC')).toEqual([]);
  });

  it('fires when a value is a non-numeric string ("n/a") -- does not silently pass', () => {
    const out = minimalOut({ figures: [f({ id: 'ops.ops.p1', value: 'n/a' as unknown as number })] });
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'NUMERIC', subject: 'ops.ops.p1' }),
    );
  });

  it('fires when a value is a numeric-LOOKING string ("20000") -- reported, never coerced', () => {
    const out = minimalOut({ figures: [f({ id: 'ops.ops.p1', value: '20000' as unknown as number })] });
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'NUMERIC', subject: 'ops.ops.p1' }),
    );
  });

  it('fires when a value is an object ({"v":2})', () => {
    const out = minimalOut({ figures: [f({ id: 'ops.ops.p1', value: { v: 2 } as unknown as number })] });
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'NUMERIC', subject: 'ops.ops.p1' }),
    );
  });

  it('fires when a value is literally NaN or Infinity', () => {
    const out = minimalOut({
      figures: [f({ id: 'a', value: NaN }), f({ id: 'b', value: Infinity })],
    });
    const problems = checkFigures(out).filter((p) => p.rule === 'NUMERIC');
    expect(problems.map((p) => p.subject).sort()).toEqual(['a', 'b']);
  });

  it('does not double-report a missing value already covered by REQUIRED', () => {
    const broken = f({ id: 'ops.ops.p1' });
    delete (broken as Partial<ExtractedFigure>).value;
    const out = minimalOut({ figures: [broken] });
    const problems = checkFigures(out);
    expect(problems.filter((p) => p.rule === 'REQUIRED' && p.subject === 'ops.ops.p1')).toHaveLength(1);
    expect(problems.filter((p) => p.rule === 'NUMERIC' && p.subject === 'ops.ops.p1')).toHaveLength(0);
  });

  it('a non-numeric delta value no longer silently passes DELTA-IDENTITY (the original defect: Math.abs(NaN) > TOL is false)', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.ops.p1', value: 100 }),
        f({ id: 'ops.ops.p2', value: 130 }),
        f({ id: 'ops.ops.delta', value: 'n/a' as unknown as number }),
      ],
    });
    const problems = checkFigures(out);
    expect(problems).toContainEqual(expect.objectContaining({ rule: 'NUMERIC', subject: 'ops.ops.delta' }));
    // The arithmetic invariant is SKIPPED for a figure already flagged
    // non-numeric -- no NaN comparison, and no spurious DELTA-IDENTITY
    // finding piled on top of the NUMERIC one for the same root cause.
    expect(problems.filter((p) => p.rule === 'DELTA-IDENTITY')).toEqual([]);
  });
});

describe('checkFigures: SOURCE-PATH (source_path must be envelope-rooted)', () => {
  it('passes for envelope: and crossDomain: rooted paths', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'a', source_path: 'envelope:metrics[0].totals.p1' }),
        f({ id: 'b', source_path: 'crossDomain.tacos.p1' }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'SOURCE-PATH')).toEqual([]);
  });

  it('fails when source_path escapes the envelope', () => {
    const out = minimalOut({ figures: [f({ id: 'a', source_path: 'sql:some_query' })] });
    expect(checkFigures(out)).toContainEqual({
      rule: 'SOURCE-PATH',
      subject: 'a',
      detail: 'source_path outside the envelope',
    });
  });
});

describe('checkFigures: DELTA-IDENTITY (delta === p2 - p1 within TOL)', () => {
  it('passes when delta equals p2 - p1 exactly', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.ops.p1', value: 100 }),
        f({ id: 'ops.ops.p2', value: 130 }),
        f({ id: 'ops.ops.delta', value: 30 }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'DELTA-IDENTITY')).toEqual([]);
  });

  it('passes within the 0.011 cent tolerance', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.ops.p1', value: 100 }),
        f({ id: 'ops.ops.p2', value: 130.01 }),
        f({ id: 'ops.ops.delta', value: 30 }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'DELTA-IDENTITY')).toEqual([]);
  });

  it('fails when delta does not equal p2 - p1', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.ops.p1', value: 100 }),
        f({ id: 'ops.ops.p2', value: 130 }),
        f({ id: 'ops.ops.delta', value: 25 }),
      ],
    });
    expect(checkFigures(out)).toContainEqual({ rule: 'DELTA-IDENTITY', subject: 'ops.ops.delta', detail: 'delta != p2 - p1' });
  });

  // DELTA-IDENTITY derives its p1/p2 lookups from the delta figure's OWN id
  // (slice off '.delta', look up '<stem>.p1'/'.p2') rather than a hardcoded
  // root, so it needs no prefix-awareness of its own -- proving that here
  // rather than assuming it, since the sibling SKU-SPLIT rule looked
  // identically safe until its hardcoded 'ads.' root was checked.
  it('still fires on a PREFIXED (mom.ops selection) document -- stem-relative lookup needs no prefix-awareness', () => {
    const out = minimalOut({
      source: {
        bridgeRunId: 'r1',
        bridgeDomain: 'ops',
        engineVersion: null,
        schemaVersion: null,
        period: null,
        tenant: null,
        currency: 'USD',
        channel: null,
        companionRunId: null,
        selection: 'mom.ops',
      },
      figures: [
        f({ id: 'mom.ops.ops.p1', value: 100 }),
        f({ id: 'mom.ops.ops.p2', value: 130 }),
        f({ id: 'mom.ops.ops.delta', value: 25 }), // broken: should be 30
      ],
    });
    expect(checkFigures(out)).toContainEqual({
      rule: 'DELTA-IDENTITY',
      subject: 'mom.ops.ops.delta',
      detail: 'delta != p2 - p1',
    });
  });

  it('ignores bridge-leg ids ending in .delta-shaped stems (never applies to .bridge. figures)', () => {
    // a bridge figure id happens to not end in ".delta" in practice, but the
    // guard is explicit in the source -- exercise it directly via an id that
    // both ends in .delta AND contains .bridge., which must be skipped
    const out = minimalOut({
      figures: [
        f({ id: 'ops.bridge.ops.primary.delta', value: 999 }), // no matching .p1/.p2 anyway
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'DELTA-IDENTITY')).toEqual([]);
  });
});

describe('checkFigures: SKU-SPLIT (ads domain only: same + other + view_through === total)', () => {
  // `selection` optionally simulates a composite-selection document: every
  // id gets the same period prefix a real extractFigures(..., selection)
  // call would apply, and source.selection is set to match (SKU-SPLIT is the
  // one invariant that reads it back).
  function adsOut(
    totalP1: number,
    sameP1: number,
    otherP1: number,
    vtP1: number,
    selection: CompositeSelection | null = null,
  ) {
    const p = selection ? `${selection.split('.')[0]}.` : '';
    return minimalOut({
      source: {
        bridgeRunId: 'r1',
        bridgeDomain: 'ads',
        engineVersion: null,
        schemaVersion: null,
        period: null,
        tenant: null,
        currency: 'USD',
        channel: null,
        companionRunId: null,
        selection,
      },
      figures: [
        f({ id: `${p}ads.ad_sales.p1`, value: totalP1 }),
        f({ id: `${p}ads.ad_sales_same_sku.p1`, value: sameP1 }),
        f({ id: `${p}ads.ad_sales_other_sku.p1`, value: otherP1 }),
        f({ id: `${p}ads.ad_sales_view_through.p1`, value: vtP1 }),
      ],
    });
  }

  it('passes when the three parts sum exactly to the total', () => {
    const out = adsOut(100, 60, 30, 10);
    expect(checkFigures(out).filter((p) => p.rule === 'SKU-SPLIT')).toEqual([]);
  });

  it('fails when the parts do not sum to the total', () => {
    const out = adsOut(100, 60, 30, 5);
    expect(checkFigures(out).some((p) => p.rule === 'SKU-SPLIT')).toBe(true);
  });

  it('does not run at all for non-ads domains', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ads.ad_sales.p1', value: 100 }),
        f({ id: 'ads.ad_sales_same_sku.p1', value: 1 }),
        f({ id: 'ads.ad_sales_other_sku.p1', value: 1 }),
        f({ id: 'ads.ad_sales_view_through.p1', value: 1 }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'SKU-SPLIT')).toEqual([]);
  });

  // SKU-SPLIT is the one invariant with a hardcoded id root ('ads.ad_sales...'),
  // so it is the one at risk of becoming a silent no-op under period
  // prefixing: figs.get('ads.ad_sales.p1') simply misses every figure in a
  // 'mom.ads.ad_sales.p1'-shaped document and the whole rule stops firing
  // with no error. These two prove it still resolves the right ids.
  it('still fires on a PREFIXED (mom.ads) document when the parts do not sum to the total', () => {
    const out = adsOut(100, 60, 30, 5, 'mom.ads'); // 60+30+5=95 != 100
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'SKU-SPLIT', subject: 'mom.ads.ad_sales.p1' }),
    );
  });

  it('does not false-positive on a matching PREFIXED (mom.ads) document (sanity: it found the right ids to sum, not just any ids)', () => {
    const out = adsOut(100, 60, 30, 10, 'mom.ads');
    expect(checkFigures(out).filter((p) => p.rule === 'SKU-SPLIT')).toEqual([]);
  });
});

describe('checkFigures: BRIDGE-FOOTING (legs foot to net whenever footing_ok)', () => {
  it('passes when legs sum to net_change within tolerance', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.bridge.ops.primary.a', value: 20, footing_ok: true, net_change: 30 }),
        f({ id: 'ops.bridge.ops.primary.b', value: 10, footing_ok: true, net_change: 30 }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'BRIDGE-FOOTING')).toEqual([]);
  });

  it('fails when legs do not foot to net_change', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.bridge.ops.primary.a', value: 20, footing_ok: true, net_change: 30 }),
        f({ id: 'ops.bridge.ops.primary.b', value: 5, footing_ok: true, net_change: 30 }),
      ],
    });
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'BRIDGE-FOOTING', subject: 'ops.bridge.ops.primary' }),
    );
  });

  it('is skipped for legs whose engine footing was not ok', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.bridge.ops.primary.a', value: 20, footing_ok: false, net_change: 30 }),
        f({ id: 'ops.bridge.ops.primary.b', value: 999, footing_ok: false, net_change: 30 }),
      ],
    });
    expect(checkFigures(out).filter((p) => p.rule === 'BRIDGE-FOOTING')).toEqual([]);
  });

  // Like DELTA-IDENTITY, BRIDGE-FOOTING groups legs by slicing each figure's
  // OWN id (up to its last '.') rather than a hardcoded root, so a uniform
  // period prefix never breaks the grouping -- proving it rather than
  // assuming it, same rationale as the DELTA-IDENTITY prefixed case above.
  it('still fires on a PREFIXED (yoy.ops selection) document', () => {
    const out = minimalOut({
      source: {
        bridgeRunId: 'r1',
        bridgeDomain: 'ops',
        engineVersion: null,
        schemaVersion: null,
        period: null,
        tenant: null,
        currency: 'USD',
        channel: null,
        companionRunId: null,
        selection: 'yoy.ops',
      },
      figures: [
        f({ id: 'yoy.ops.bridge.ops.primary.a', value: 20, footing_ok: true, net_change: 30 }),
        f({ id: 'yoy.ops.bridge.ops.primary.b', value: 5, footing_ok: true, net_change: 30 }), // 20+5=25 != 30
      ],
    });
    expect(checkFigures(out)).toContainEqual(
      expect.objectContaining({ rule: 'BRIDGE-FOOTING', subject: 'yoy.ops.bridge.ops.primary' }),
    );
  });

  it('never throws when a leg value is a numeric STRING (the original defect: string-concat reduce + s.toFixed crashing mid-check and losing earlier findings)', () => {
    const out = minimalOut({
      figures: [
        f({ id: 'ops.ops.p1', value: 100 }), // an earlier, unrelated finding-free figure
        f({ id: 'ops.bridge.ops.primary.a', value: '20000' as unknown as number, footing_ok: true, net_change: 30000 }),
        f({ id: 'ops.bridge.ops.primary.b', value: '10000' as unknown as number, footing_ok: true, net_change: 30000 }),
      ],
    });
    let problems: ReturnType<typeof checkFigures> = [];
    expect(() => {
      problems = checkFigures(out);
    }).not.toThrow();
    // Each string leg is its own NUMERIC finding (never coerced)...
    expect(problems.filter((p) => p.rule === 'NUMERIC')).toHaveLength(2);
    // ...and the group is excluded from BRIDGE-FOOTING entirely rather than
    // string-concatenating "20000" + "10000" into "2000010000" and either
    // throwing on .toFixed or comparing garbage against net_change.
    expect(problems.filter((p) => p.rule === 'BRIDGE-FOOTING')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) composite bundle handling (INS-MONTHLY-01 mom/yoy unwrapping)
// ---------------------------------------------------------------------------

describe('composite bundle handling (INS-MONTHLY-01 mom/yoy unwrapping)', () => {
  // Reuse the anonymized envelope fixture's inner `envelope` object -- inside
  // a composite bundle, mom.ops / yoy.ops ARE envelope objects directly, one
  // level down from where a bare-response caller would find them (that
  // caller sees {envelope, crossDomain, ...}; the composite's mom.ops IS the
  // `envelope` value from that shape, not the wrapper around it).
  const opsEnvelope = (loadFixture('envelope-minimal.json') as { envelope: unknown }).envelope;

  // Small synthetic ads envelope -- just enough shape to exercise ads.*
  // figures without pulling in a second full fixture.
  const adsEnvelope = {
    bridgeDomain: 'ads',
    bridgeRunId: 'run-example-ads-0001',
    currency: 'USD',
    caveats: [],
    metrics: [
      { metricKey: 'ad_spend', totals: { p1: 15000, p2: 16000, delta: 1000, pctChange: 0.0667 }, topDrivers: [] },
      { metricKey: 'ad_sales', totals: { p1: 70000, p2: 95000, delta: 25000, pctChange: 0.357 }, topDrivers: [] },
    ],
    insights: [],
  };

  // Small synthetic crossDomain block -- only what's needed to prove duo.*
  // figures ride along with the mom.ops selection.
  const crossDomain = {
    tacos: { p1: 0.15, p2: 0.12, deltaPts: -0.03 },
  };

  function buildComposite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ok: true,
      mom: { ops: opsEnvelope, ads: adsEnvelope, crossDomain },
      yoy: { ops: opsEnvelope },
      headline: {},
      limitations: [],
      meta: {},
      ...overrides,
    };
  }

  it('a composite bundle with no selection throws CompositeSelectionError naming the available choices', () => {
    const composite = buildComposite();
    let error: unknown;
    try {
      extractFigures(composite);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CompositeSelectionError);
    for (const choice of COMPOSITE_SELECTIONS) {
      expect((error as Error).message).toContain(choice);
    }
  });

  it('REGRESSION: a composite never silently extracts zero figures that would pass checkFigures vacuously (the original defect)', () => {
    // Old behavior: no top-level `envelope` key on the composite, so it was
    // treated as a bare-but-empty envelope -- metrics/insights both resolved
    // to [], figures stayed [], and checkFigures([]) === [] is a CLEAN pass
    // with zero figures extracted. The guard exists so this sequence can no
    // longer happen: extraction throws before any document -- empty or
    // otherwise -- is ever produced from an unselected composite.
    const composite = buildComposite();
    let out: ExtractDocument | undefined;
    let error: unknown;
    try {
      out = extractFigures(composite);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CompositeSelectionError);
    expect(out).toBeUndefined();
    // Belt-and-suspenders: even if a future change stopped this from
    // throwing, it must never come back as the silent-empty pass.
    if (out !== undefined) {
      const completed: ExtractDocument = out;
      const isSilentEmptyPass = completed.figures.length === 0 && checkFigures(completed).length === 0;
      expect(isSilentEmptyPass).toBe(false);
    }
  });

  it('--select mom.ops extracts the ops envelope and picks up mom.crossDomain (duo.* present), all ids mom.-prefixed', () => {
    const composite = buildComposite();
    const out = extractFigures(composite, 'mom.ops');
    const figs = byId(out);
    expect(out.source.bridgeDomain).toBe('ops');
    expect(out.source.selection).toBe('mom.ops');
    expect(figs.get('mom.ops.ops.p1')).toMatchObject({ value: 100000, unit: 'currency' });
    expect(figs.get('mom.ops.ops.p2')).toMatchObject({ value: 144000 });
    expect(out.figures.some((fg) => fg.id.includes('duo.'))).toBe(true);
    expect(figs.get('mom.duo.tacos.p1')).toMatchObject({ value: 0.15, unit: 'ratio' });
    expect(figs.get('mom.duo.tacos.p2')).toMatchObject({ value: 0.12 });
    // never the bare, unprefixed shape a single-response extraction would emit
    expect(figs.has('ops.ops.p1')).toBe(false);
    expect(figs.has('duo.tacos.p1')).toBe(false);
  });

  it('--select mom.ads ids are period-prefixed AND still carry the ads.* domain structure (ads.* present, duo.* absent -- crossDomain belongs to the pair, not the ads run)', () => {
    const composite = buildComposite();
    const out = extractFigures(composite, 'mom.ads');
    const figs = byId(out);
    expect(out.source.bridgeDomain).toBe('ads');
    expect(out.source.selection).toBe('mom.ads');
    expect(figs.get('mom.ads.ad_spend.p1')).toMatchObject({ value: 15000, unit: 'currency' });
    expect(figs.get('mom.ads.ad_sales.delta')).toMatchObject({ value: 25000 });
    expect(out.figures.filter((fg) => fg.id.includes('duo.'))).toEqual([]);
    expect(figs.has('ads.ad_spend.p1')).toBe(false); // never the bare, unprefixed shape
    expect(checkFigures(out)).toEqual([]); // still checks clean, prefixed
  });

  it('--select yoy.ops works, carries no crossDomain, and its ids are yoy.-prefixed -- DISJOINT from mom.ops on the identical underlying envelope', () => {
    const composite = buildComposite();
    const out = extractFigures(composite, 'yoy.ops');
    const figs = byId(out);
    expect(out.source.bridgeDomain).toBe('ops');
    expect(out.source.selection).toBe('yoy.ops');
    expect(figs.get('yoy.ops.ops.p1')).toMatchObject({ value: 100000 });
    expect(out.figures.filter((fg) => fg.id.includes('duo.'))).toEqual([]);
    expect(figs.has('ops.ops.p1')).toBe(false); // never the bare, unprefixed shape
    expect(figs.has('mom.ops.ops.p1')).toBe(false); // never the OTHER period's prefix
  });

  // ---------------------------------------------------------------------
  // THE P0 REGRESSION: mom.ops and yoy.ops here read the EXACT SAME
  // underlying opsEnvelope fixture object (see `buildComposite` above) --
  // before period-prefixing, `${domain}.${key}.${side}` gave both documents
  // the identical id set (ops.ops.p1, ops.ops.delta, ops.bridge.ops.primary.
  // sessions, ...). SKILL.md Step 2 composes every selection's document into
  // one report, so those collided ids meant a MoM figure_ref could resolve
  // to the YoY value through render-report.ts / validate.ts's last-wins
  // Maps, with every validator reporting clean. These two tests are the
  // regression guard.
  // ---------------------------------------------------------------------

  it('REGRESSION: caveat registry keys are period-namespaced too, and figures reference the prefixed ids', () => {
    // The first cut of this fix prefixed figure ids but NOT caveat registry
    // keys, which collide identically (`env.surge_window.0` in both periods).
    // Since the skill merges both documents into one report-data and a merged
    // registry is last-wins, a figure could have rendered the OTHER period's
    // caveat text. Blocking caveats are exactly the ones that must never be
    // wrong, so this is the same failure class as the figure-id collision.
    const caveated = {
      ...(opsEnvelope as Record<string, unknown>),
      caveats: [{ kind: 'surge_window', message: 'A surge window overlaps the comparison period.' }],
    };
    const composite = buildComposite({ mom: { ops: caveated, ads: adsEnvelope, crossDomain }, yoy: { ops: caveated } });

    const mom = extractFigures(composite, 'mom.ops');
    const yoy = extractFigures(composite, 'yoy.ops');

    expect(Object.keys(mom.caveat_registry)).toContain('mom.env.surge_window.0');
    expect(Object.keys(yoy.caveat_registry)).toContain('yoy.env.surge_window.0');
    // The bare, collidable key is gone from both.
    expect(Object.keys(mom.caveat_registry)).not.toContain('env.surge_window.0');

    // A merged registry (what the skill actually composes) loses nothing.
    const mergedKeys = new Set([
      ...Object.keys(mom.caveat_registry),
      ...Object.keys(yoy.caveat_registry),
    ]);
    expect(mergedKeys.size).toBe(
      Object.keys(mom.caveat_registry).length + Object.keys(yoy.caveat_registry).length,
    );

    // Figures must point at the prefixed keys, or the reference dangles.
    const momCaveatRefs = mom.figures.flatMap((f) => f.caveats);
    expect(momCaveatRefs.length).toBeGreaterThan(0);
    for (const ref of momCaveatRefs) {
      expect(ref.startsWith('mom.')).toBe(true);
      expect(mom.caveat_registry[ref]).toBeDefined();
    }
  });

  it('REGRESSION (P0): mom.ops and yoy.ops from the same composite produce DISJOINT id sets, never colliding', () => {
    const composite = buildComposite();
    const mom = extractFigures(composite, 'mom.ops');
    const yoy = extractFigures(composite, 'yoy.ops');
    const momIds = new Set(mom.figures.map((fg) => fg.id));
    const yoyIds = new Set(yoy.figures.map((fg) => fg.id));

    expect(momIds.size).toBeGreaterThan(0);
    expect(yoyIds.size).toBeGreaterThan(0);
    for (const id of momIds) expect(yoyIds.has(id)).toBe(false);
    for (const id of yoyIds) expect(momIds.has(id)).toBe(false);

    // the SPECIFIC ids that collided pre-fix (both selections read the same
    // opsEnvelope, so both used to emit the exact same bare id here)
    expect(momIds.has('mom.ops.ops.p1')).toBe(true);
    expect(yoyIds.has('yoy.ops.ops.p1')).toBe(true);
    expect(momIds.has('mom.ops.ops.delta')).toBe(true);
    expect(yoyIds.has('yoy.ops.ops.delta')).toBe(true);
    expect(momIds.has('mom.ops.bridge.ops.primary.sessions')).toBe(true);
    expect(yoyIds.has('yoy.ops.bridge.ops.primary.sessions')).toBe(true);
  });

  it('simulated skill merge (SKILL.md Step 2: compose every selection\'s figures document together) yields zero duplicate ids across mom.ops + mom.ads + yoy.ops', () => {
    const composite = buildComposite();
    const mom = extractFigures(composite, 'mom.ops');
    const ads = extractFigures(composite, 'mom.ads');
    const yoy = extractFigures(composite, 'yoy.ops');

    // exactly what the skill does at Step 5: concatenate every extracted
    // document's figures[] into one report-data.json figures[] array
    const merged = [...mom.figures, ...ads.figures, ...yoy.figures];
    const ids = merged.map((fg) => fg.id);
    expect(new Set(ids).size).toBe(ids.length); // no id repeats anywhere

    // and reproduce validate.ts / render-report.ts's own last-wins index
    // directly: every figure survives, none is silently shadowed
    const byIdMap = new Map(merged.map((fg) => [fg.id, fg]));
    expect(byIdMap.size).toBe(merged.length);
  });

  it('yoy: null (a run without YoY) + --select yoy.ops throws, naming what IS available', () => {
    const composite = buildComposite({ yoy: null });
    let error: unknown;
    try {
      extractFigures(composite, 'yoy.ops');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CompositeSelectionError);
    const message = (error as Error).message;
    expect(message).toContain("no 'yoy' block");
    expect(message).toContain('mom.ops');
    expect(message).toContain('mom.ads');
    expect(message).not.toContain('yoy.ops'); // excluded from "available" -- it's the one that's missing
  });

  it('a selection passed for a plain single response throws', () => {
    const plain = loadFixture('envelope-minimal.json');
    expect(() => extractFigures(plain, 'mom.ops')).toThrow(CompositeSelectionError);
  });

  it('a plain single response still extracts exactly as before (regression guard: unprefixed ids, parity with the upstream Python extractor)', () => {
    const plain = loadFixture('envelope-minimal.json');
    const out = extractFigures(plain);
    const figs = byId(out);
    expect(out.source.bridgeDomain).toBe('ops');
    expect(out.source.selection).toBeNull(); // no composite selection on this path
    expect(figs.get('ops.ops.p1')).toMatchObject({ value: 100000, unit: 'currency', basis: 'ordered_revenue' });
    expect(figs.get('ops.ops.delta')).toMatchObject({ value: 44000 });
    expect(figs.get('duo.tacos.p1')).toMatchObject({ value: 0.15 });
    expect(checkFigures(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INTERIM-UNTIL-CATALOG unit map, reconciled against the engine's metric
// registry (METRIC_DEFINITIONS[key].display). Synthetic envelopes only.
// ---------------------------------------------------------------------------

describe('OPS_UNITS / ADS_UNITS agree with the engine metric registry', () => {
  /** Minimal envelope carrying one totals row per requested metric. */
  function unitsOut(domain: 'ops' | 'ads', keys: string[]) {
    return byId(
      extractFigures({
        bridgeDomain: domain,
        bridgeRunId: 'run-example-units-0001',
        currency: 'USD',
        caveats: [],
        metrics: keys.map((metricKey) => ({
          metricKey,
          totals: { p1: 1, p2: 2, delta: 1, pctChange: 1 },
          topDrivers: [],
        })),
        insights: [],
      }),
    );
  }

  it('maps the per-unit money metrics to currency-2dp, not 0dp currency', () => {
    // engine: ops_per_unit / ad_cpc / ad_cpa / ad_aov all declare
    // display 'currency-2dp', decimals 2. These are per-click / per-order /
    // per-unit amounts, routinely sub-dollar, so a 0dp render erased them.
    expect(unitsOut('ops', ['ops_per_unit']).get('ops.ops_per_unit.p1')?.unit).toBe('currency-2dp');
    const ads = unitsOut('ads', ['ad_cpc', 'ad_cpa', 'ad_aov']);
    expect(ads.get('ads.ad_cpc.p1')?.unit).toBe('currency-2dp');
    expect(ads.get('ads.ad_cpa.p1')?.unit).toBe('currency-2dp');
    expect(ads.get('ads.ad_aov.p1')?.unit).toBe('currency-2dp');
  });

  it('maps ROAS to currency-2dp — it is a multiple, never a percentage', () => {
    // engine: display 'currency-2dp' ("displayed as currency ($2.06),
    // matching the ASP ($/unit) convention"). As 'ratio' the renderer turned
    // a 2.06x ROAS into "206.0%".
    expect(unitsOut('ads', ['roas']).get('ads.roas.p1')?.unit).toBe('currency-2dp');
  });

  it('covers the ops-grid ad-attribution fold instead of defaulting it to count', () => {
    // These three are in the engine's OPS_FAMILY_METRICS but were absent from
    // the map, so the `?? 'count'` fallback rendered two dollar metrics and a
    // rate as bare counts.
    const ops = unitsOut('ops', ['ad_driven_sales', 'ad_driven_halo', 'ad_driven_share']);
    expect(ops.get('ops.ad_driven_sales.p1')?.unit).toBe('currency');
    expect(ops.get('ops.ad_driven_halo.p1')?.unit).toBe('currency');
    expect(ops.get('ops.ad_driven_share.p1')?.unit).toBe('ratio');
  });

  it('leaves the entries the engine registry already agreed with untouched', () => {
    // our `ratio` (stored fraction, rendered x100 with %) == engine `percent`;
    // our `count` (bare whole number) == engine `number`.
    const ops = unitsOut('ops', [
      'ops', 'units', 'sessions', 'conversion', 'buy_box',
      'sellable_inventory', 'weeks_of_cover', 'lost_sales', 'glance_views', 'gv_conversion',
    ]);
    expect(ops.get('ops.ops.p1')?.unit).toBe('currency');
    expect(ops.get('ops.lost_sales.p1')?.unit).toBe('currency');
    expect(ops.get('ops.units.p1')?.unit).toBe('count');
    expect(ops.get('ops.sessions.p1')?.unit).toBe('count');
    expect(ops.get('ops.glance_views.p1')?.unit).toBe('count');
    expect(ops.get('ops.sellable_inventory.p1')?.unit).toBe('count');
    expect(ops.get('ops.conversion.p1')?.unit).toBe('ratio');
    expect(ops.get('ops.buy_box.p1')?.unit).toBe('ratio');
    expect(ops.get('ops.gv_conversion.p1')?.unit).toBe('ratio');
    expect(ops.get('ops.weeks_of_cover.p1')?.unit).toBe('weeks');

    const ads = unitsOut('ads', [
      'ad_spend', 'ad_sales', 'acos', 'ad_impressions', 'ad_clicks', 'ad_ctr',
      'ad_orders', 'ad_conversion', 'ad_sales_same_sku', 'ad_sales_other_sku',
      'ad_sales_view_through', 'ad_orders_same_sku', 'ad_orders_other_sku',
      'ad_orders_view_through',
    ]);
    for (const k of ['ad_spend', 'ad_sales', 'ad_sales_same_sku', 'ad_sales_other_sku', 'ad_sales_view_through']) {
      expect(ads.get(`ads.${k}.p1`)?.unit).toBe('currency');
    }
    for (const k of ['ad_impressions', 'ad_clicks', 'ad_orders', 'ad_orders_same_sku', 'ad_orders_other_sku', 'ad_orders_view_through']) {
      expect(ads.get(`ads.${k}.p1`)?.unit).toBe('count');
    }
    for (const k of ['acos', 'ad_ctr', 'ad_conversion']) {
      expect(ads.get(`ads.${k}.p1`)?.unit).toBe('ratio');
    }
  });

  it('an unmapped metric key still falls back to count rather than throwing', () => {
    expect(unitsOut('ops', ['not_a_real_metric']).get('ops.not_a_real_metric.p1')?.unit).toBe('count');
  });
});

// ---------------------------------------------------------------------------
// Bridge-leg units come from the ANCHOR metric, not the lever.
//
// A leg figure stores `component.impact` -- the leg's contribution to the
// ANCHOR metric's net change -- so its unit is the anchor's, never
// `component.valueUnit` (which the engine uses only for the leg's own
// p1Value/p2Value levels, numbers this extractor does not emit). The fixture
// below is the repo's own synthetic envelope; every leg in it carries a
// valueUnit that DISAGREES with its anchor, which is exactly the shape of the
// live defect. All values synthetic.
// ---------------------------------------------------------------------------

describe('bridge legs take their unit from the anchor metric, not comp.valueUnit', () => {
  const out = extractFigures(loadFixture('envelope-minimal.json'));
  const figs = byId(out);

  it('a dollar bridge labels every leg in dollars, whatever the lever is', () => {
    // Anchor: ops (currency). The three legs foot to the ops delta --
    // 20000 + 15000 + 9000 = 44000 -- so all three ARE dollars, yet their
    // valueUnits are 'number', 'percent' and 'currency-2dp' respectively.
    // The conversion leg is the live defect: $15,000 labeled 'percent'
    // rendered "15000.0%".
    expect(figs.get('ops.bridge.ops.primary.sessions')?.unit).toBe('currency');
    expect(figs.get('ops.bridge.ops.primary.conversion')?.unit).toBe('currency');
    expect(figs.get('ops.bridge.ops.primary.ops_per_unit')?.unit).toBe('currency');
    // ...and the values are untouched by the relabel.
    expect(figs.get('ops.bridge.ops.primary.conversion')?.value).toBe(15000);
  });

  it('a RATE bridge labels its legs points_fraction — the change unit of a ratio', () => {
    // Anchor: conversion (ratio). Legs 0.03 + 0.02 = 0.05 = the conversion
    // delta, i.e. fractions of a rate: a three-point and a two-point
    // contribution. Both carry valueUnit 'number', which rendered them "0".
    expect(figs.get('ops.bridge.conversion.primary.units')?.unit).toBe('points_fraction');
    expect(figs.get('ops.bridge.conversion.primary.sessions')?.unit).toBe('points_fraction');
    // Buy Box is the contribution-only shape (legs with no p1/p2 at all),
    // which makes the lever-unit reading impossible on its own terms.
    expect(figs.get('ops.bridge.buy_box.primary.rate')?.unit).toBe('points_fraction');
    expect(figs.get('ops.bridge.buy_box.primary.mix')?.unit).toBe('points_fraction');
  });

  it('carries the anchor unit through for the non-currency, non-rate anchors too', () => {
    // ASP anchor: dollars-per-unit at 2dp, so its legs are too -- including
    // the 'sessions' leg, whose own level is a count.
    expect(figs.get('ops.bridge.ops_per_unit.primary.ops')?.unit).toBe('currency-2dp');
    expect(figs.get('ops.bridge.ops_per_unit.primary.sessions')?.unit).toBe('currency-2dp');
    // Weeks of cover: a weeks-denominated anchor.
    expect(figs.get('ops.bridge.weeks_of_cover.primary.inventory')?.unit).toBe('weeks');
    expect(figs.get('ops.bridge.weeks_of_cover.primary.demand')?.unit).toBe('weeks');
    // Lost sales: a dollar anchor whose legs are all SYNTHETIC factors (no
    // MetricKey of their own), so the anchor is the only sound source.
    expect(figs.get('ops.bridge.lost_sales.secondary.oos_days')?.unit).toBe('currency');
    expect(figs.get('ops.bridge.lost_sales.secondary.convr')?.unit).toBe('currency');
  });

  it('every leg agrees with the net change it foots to (the BRIDGE-FOOTING unit corollary)', () => {
    // Structural, not enumerated: legs SUM to the anchor's delta, and numbers
    // that sum to each other share a unit. Whatever unit the anchor's own
    // delta figure carries, its legs carry the change form of it.
    const changeUnitOf = (u: string): string => (u === 'ratio' ? 'points_fraction' : u);
    const legs = out.figures.filter((f) => f.id.startsWith('ops.bridge.'));
    expect(legs.length).toBeGreaterThan(10); // the rule is exercised, not vacuous
    for (const leg of legs) {
      const metric = leg.id.split('.')[2];
      const delta = figs.get(`ops.${metric}.delta`);
      expect(delta, `no delta figure for anchor ${metric}`).toBeDefined();
      expect(leg.unit, `${leg.id} disagrees with ops.${metric}.delta`).toBe(
        changeUnitOf(delta!.unit),
      );
    }
  });

  it('leaves the cross-domain TACOS legs on their own anchor (regression guard)', () => {
    // These legs are anchored on the cross-domain TACOS rate, which is not a
    // metric key in either units map, so they are NOT derived from it -- they
    // were already labeled points_fraction and must stay that way. Their
    // components' own valueUnits are 'currency-2dp' / 'percent'.
    expect(figs.get('duo.bridge.tacos.primary.ad_cpc')?.unit).toBe('points_fraction');
    expect(figs.get('duo.bridge.tacos.primary.ad_conversion')?.unit).toBe('points_fraction');
    expect(figs.get('duo.bridge.tacos.primary.ads_pct_total_sales')?.unit).toBe('points_fraction');
  });

  it('falls back to the same unit the anchor metric’s own figures fall back to', () => {
    const odd = byId(
      extractFigures({
        bridgeDomain: 'ops',
        bridgeRunId: 'run-example-legs-0001',
        metrics: [{ metricKey: 'not_a_real_metric', totals: { p1: 1, p2: 3, delta: 2 } }],
        insights: [
          {
            insight: {
              scope: 'total',
              metricKey: 'not_a_real_metric',
              variantKey: 'primary',
              netChange: 2,
              components: [{ key: 'lever', impact: 2, valueUnit: 'percent' }],
            },
          },
        ],
      }),
    );
    // 'count' both places -- a leg can never disagree with the net it foots to.
    expect(odd.get('ops.not_a_real_metric.delta')?.unit).toBe('count');
    expect(odd.get('ops.bridge.not_a_real_metric.primary.lever')?.unit).toBe('count');
  });

  it('applies the same anchor rule at entity scope', () => {
    const entity = byId(
      extractFigures({
        envelope: {
          bridgeDomain: 'ops',
          bridgeRunId: 'run-example-legs-0002',
          entityKey: 'item-group-a',
          insights: [
            {
              metricKey: 'ops',
              variantKey: 'primary',
              p1Value: 20000,
              p2Value: 25000,
              netChange: 5000,
              components: [
                { key: 'sessions', impact: 3000, valueUnit: 'number' },
                { key: 'conversion', impact: 2000, valueUnit: 'percent' },
              ],
            },
            {
              metricKey: 'conversion',
              variantKey: 'primary',
              p1Value: 0.2,
              p2Value: 0.25,
              netChange: 0.05,
              components: [{ key: 'units', impact: 0.05, valueUnit: 'number' }],
            },
          ],
        },
      }),
    );
    expect(entity.get('ops.entity.item-group-a.bridge.ops.primary.sessions')?.unit).toBe('currency');
    expect(entity.get('ops.entity.item-group-a.bridge.ops.primary.conversion')?.unit).toBe('currency');
    expect(entity.get('ops.entity.item-group-a.bridge.conversion.primary.units')?.unit).toBe(
      'points_fraction',
    );
  });

  it('changes only the unit label — ids, values, source paths and footing metadata are identical', () => {
    const leg = figs.get('ops.bridge.ops.primary.conversion');
    expect(leg).toMatchObject({
      id: 'ops.bridge.ops.primary.conversion',
      label: 'ops conversion leg (primary)',
      value: 15000,
      basis: 'ordered_revenue',
      source_path: 'envelope:insights[0].insight.components[1].impact',
      footing_ok: true,
      net_change: 44000,
    });
    expect(checkFigures(out)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// crossDomain delta_pts is a FRACTION, not points.
// ---------------------------------------------------------------------------

describe('duo.<block>.delta_pts carries the fraction-scaled points unit', () => {
  /** A cross-domain block with a real, awkward rate move: TACoS 8.3% -> 11.1%
   *  and attributed share 41.2% -> 38.4%. Synthetic. */
  const out = extractFigures({
    envelope: { bridgeDomain: 'ops', bridgeRunId: 'run-example-duo-0001', currency: 'USD', metrics: [], insights: [] },
    crossDomain: {
      tacos: { p1: 0.083, p2: 0.111, deltaPts: 0.028 },
      attributedShare: { p1: 0.412, p2: 0.384, deltaPts: -0.028 },
    },
  });
  const figs = byId(out);

  it('labels both delta_pts figures points_fraction, matching how the engine stores them', () => {
    expect(figs.get('duo.tacos.delta_pts')).toMatchObject({ value: 0.028, unit: 'points_fraction' });
    expect(figs.get('duo.attributedShare.delta_pts')).toMatchObject({
      value: -0.028,
      unit: 'points_fraction',
    });
  });

  it('leaves the LEVEL figures on ratio — only the change unit moved', () => {
    expect(figs.get('duo.tacos.p1')?.unit).toBe('ratio');
    expect(figs.get('duo.tacos.p2')?.unit).toBe('ratio');
    expect(figs.get('duo.attributedShare.p1')?.unit).toBe('ratio');
  });
});

// ---------------------------------------------------------------------------
// A RATE metric's DELTA is in POINTS, not in the level's own unit.
//
// The engine declares this itself: `METRIC_DEFINITIONS[k].deltaUnit` is 'pts'
// for EVERY metric whose `display` is 'percent' -- conversion, buy_box,
// gv_conversion, ad_driven_share, acos, ad_ctr, ad_conversion -- and
// 'absolute' for every other metric in the registry. `formatDelta` renders the
// 'pts' branch as `numWithDecimals(abs * 100, dp) + ' pts'`, i.e. a stored
// FRACTION of a point, which is exactly our `points_fraction`; the 'absolute'
// branch renders the delta in the LEVEL's own unit, which is the pass-through.
// Our `ratio` IS the engine's `percent`, so the 'ratio' entries in the two
// maps are precisely the deltaUnit:'pts' set and the mapping is total.
//
// Levels keep 'ratio'. Only the CHANGE moves -- the same `changeUnitOf` rule
// the bridge legs and the crossDomain delta_pts figures already follow, which
// is what puts a leg and the net it foots to in one denomination. Synthetic.
// ---------------------------------------------------------------------------

describe('a rate metric’s delta carries the change unit, not the level unit', () => {
  /** Minimal envelope carrying one totals row per requested metric. Values are
   *  rate-shaped (0.20 -> 0.25) so a fraction delta is the realistic case. */
  function deltaOut(domain: 'ops' | 'ads', keys: string[]) {
    return byId(
      extractFigures({
        bridgeDomain: domain,
        bridgeRunId: 'run-example-delta-0001',
        currency: 'USD',
        caveats: [],
        metrics: keys.map((metricKey) => ({
          metricKey,
          totals: { p1: 0.2, p2: 0.25, delta: 0.05, pctChange: 0.25 },
          topDrivers: [],
        })),
        insights: [],
      }),
    );
  }

  // Every 'ratio' entry in OPS_UNITS / ADS_UNITS, which is exactly the engine's
  // deltaUnit:'pts' set -- checked against METRIC_DEFINITIONS key by key.
  const OPS_RATES = ['conversion', 'buy_box', 'gv_conversion', 'ad_driven_share'];
  const ADS_RATES = ['acos', 'ad_ctr', 'ad_conversion'];

  it('labels EVERY rate metric’s delta points_fraction, in both domain maps', () => {
    const ops = deltaOut('ops', OPS_RATES);
    for (const k of OPS_RATES) {
      expect(ops.get(`ops.${k}.delta`)?.unit, `ops.${k}.delta`).toBe('points_fraction');
    }
    const ads = deltaOut('ads', ADS_RATES);
    for (const k of ADS_RATES) {
      expect(ads.get(`ads.${k}.delta`)?.unit, `ads.${k}.delta`).toBe('points_fraction');
    }
  });

  it('leaves the LEVEL figures on ratio — a rate’s level is still a rate', () => {
    const ops = deltaOut('ops', OPS_RATES);
    for (const k of OPS_RATES) {
      expect(ops.get(`ops.${k}.p1`)?.unit, `ops.${k}.p1`).toBe('ratio');
      expect(ops.get(`ops.${k}.p2`)?.unit, `ops.${k}.p2`).toBe('ratio');
    }
    const ads = deltaOut('ads', ADS_RATES);
    for (const k of ADS_RATES) {
      expect(ads.get(`ads.${k}.p1`)?.unit, `ads.${k}.p1`).toBe('ratio');
    }
  });

  it('changes the unit only — value, basis, caveats and pct_change are untouched', () => {
    expect(deltaOut('ops', ['conversion']).get('ops.conversion.delta')).toMatchObject({
      id: 'ops.conversion.delta',
      value: 0.05,
      unit: 'points_fraction',
      basis: 'engine_default',
      source_path: 'envelope:metrics[0].totals.delta',
      pct_change: 0.25,
    });
  });

  it('is the identity on every NON-rate metric — deltaUnit "absolute" passes through', () => {
    // The whole of both maps, minus the rate set above. Structural rather than
    // enumerated: a delta unit may differ from its level unit ONLY where the
    // engine says deltaUnit is 'pts', i.e. only where the level is a ratio.
    const opsRest = [
      'ops', 'units', 'sessions', 'ops_per_unit', 'sellable_inventory',
      'weeks_of_cover', 'lost_sales', 'glance_views', 'ad_driven_sales', 'ad_driven_halo',
    ];
    const ops = deltaOut('ops', opsRest);
    for (const k of opsRest) {
      const level = ops.get(`ops.${k}.p1`)?.unit;
      expect(level, `ops.${k}.p1`).not.toBe('ratio');
      expect(ops.get(`ops.${k}.delta`)?.unit, `ops.${k}.delta`).toBe(level);
    }
    const adsRest = [
      'ad_spend', 'ad_sales', 'roas', 'ad_impressions', 'ad_clicks', 'ad_orders',
      'ad_cpa', 'ad_aov', 'ad_cpc', 'ad_sales_same_sku', 'ad_sales_other_sku',
      'ad_sales_view_through', 'ad_orders_same_sku', 'ad_orders_other_sku',
      'ad_orders_view_through',
    ];
    const ads = deltaOut('ads', adsRest);
    for (const k of adsRest) {
      const level = ads.get(`ads.${k}.p1`)?.unit;
      expect(level, `ads.${k}.p1`).not.toBe('ratio');
      expect(ads.get(`ads.${k}.delta`)?.unit, `ads.${k}.delta`).toBe(level);
    }
    // ...and an unmapped key keeps the same 'count' fallback on both.
    const odd = deltaOut('ops', ['not_a_real_metric']);
    expect(odd.get('ops.not_a_real_metric.p1')?.unit).toBe('count');
    expect(odd.get('ops.not_a_real_metric.delta')?.unit).toBe('count');
  });

  it('applies the same rule to an entity-scoped envelope’s netChange', () => {
    const entity = byId(
      extractFigures({
        envelope: {
          bridgeDomain: 'ops',
          bridgeRunId: 'run-example-delta-0002',
          entityKey: 'item-group-a',
          insights: [
            { metricKey: 'ops', variantKey: 'primary', p1Value: 20000, p2Value: 25000, netChange: 5000 },
            { metricKey: 'conversion', variantKey: 'primary', p1Value: 0.2, p2Value: 0.25, netChange: 0.05 },
          ],
        },
      }),
    );
    expect(entity.get('ops.entity.item-group-a.conversion.p1')?.unit).toBe('ratio');
    expect(entity.get('ops.entity.item-group-a.conversion.delta')?.unit).toBe('points_fraction');
    // the dollar metric alongside it is untouched
    expect(entity.get('ops.entity.item-group-a.ops.delta')?.unit).toBe('currency');
  });

  it('puts a delta and the legs that foot to it in ONE denomination (the visible contradiction)', () => {
    // Structural over the repo's own envelope fixture: the legs SUM to the
    // anchor's delta, so they are the same quantity and must carry the same
    // unit. Before this fix the conversion bridge printed "3.0 pts / 2.0 pts"
    // under a net that printed "5.0%" -- on the same page.
    const out = extractFigures(loadFixture('envelope-minimal.json'));
    const all = byId(out);
    const legs = out.figures.filter((f) => f.id.startsWith('ops.bridge.'));
    expect(legs.length).toBeGreaterThan(10); // exercised, not vacuous
    for (const leg of legs) {
      const metric = leg.id.split('.')[2];
      const delta = all.get(`ops.${metric}.delta`);
      expect(delta, `no delta figure for anchor ${metric}`).toBeDefined();
      expect(leg.unit, `${leg.id} vs ops.${metric}.delta`).toBe(delta!.unit);
    }
    // and the rate anchors are genuinely in the set being checked
    expect(all.get('ops.conversion.delta')?.unit).toBe('points_fraction');
    expect(all.get('ops.buy_box.delta')?.unit).toBe('points_fraction');
  });
});

// ---------------------------------------------------------------------------
// duo.asp / duo.adAov are ops_per_unit and ad_aov, and carry their units.
//
// The engine builds the block from exactly those two metric pairs:
// `aspVsAdAov: comparable.ok ? { asp, adAov } : null` where
// `asp = pair(ops, 'ops_per_unit')` and `adAov = pair(ads, 'ad_aov')` -- the
// SAME sidecar metric blocks the ops/ads domain figures read. Both declare
// `display: 'currency-2dp', decimals: 2` in METRIC_DEFINITIONS. Hardcoding
// 'currency' (0dp) printed a $59.38 ad AOV as "$59". Synthetic values.
// ---------------------------------------------------------------------------

describe('duo.asp / duo.adAov carry their source metric’s unit, cents included', () => {
  const figs = byId(extractFigures(loadFixture('envelope-minimal.json')));

  it('labels both lanes currency-2dp', () => {
    expect(figs.get('duo.asp.p1')).toMatchObject({ value: 50, unit: 'currency-2dp' });
    expect(figs.get('duo.asp.p2')?.unit).toBe('currency-2dp');
    expect(figs.get('duo.adAov.p1')).toMatchObject({ value: 58.33, unit: 'currency-2dp' });
    expect(figs.get('duo.adAov.p2')).toMatchObject({ value: 59.38, unit: 'currency-2dp' });
  });

  it('agrees with the unit those metrics carry on their own domain figures', () => {
    // Structural: the same number must not change denomination because it was
    // read off the cross-domain block instead of its own metric row.
    const ops = byId(
      extractFigures({
        bridgeDomain: 'ops',
        bridgeRunId: 'run-example-duo-units-0001',
        metrics: [{ metricKey: 'ops_per_unit', totals: { p1: 50, p2: 48, delta: -2 } }],
        insights: [],
      }),
    );
    const ads = byId(
      extractFigures({
        bridgeDomain: 'ads',
        bridgeRunId: 'run-example-duo-units-0002',
        metrics: [{ metricKey: 'ad_aov', totals: { p1: 58.33, p2: 59.38, delta: 1.05 } }],
        insights: [],
      }),
    );
    expect(figs.get('duo.asp.p1')?.unit).toBe(ops.get('ops.ops_per_unit.p1')?.unit);
    expect(figs.get('duo.adAov.p1')?.unit).toBe(ads.get('ads.ad_aov.p1')?.unit);
  });
});

// ---------------------------------------------------------------------------
// duo.paidPressure stays `ratio` -- DECISION PIN, not a fix.
//
// It was reviewed as a suspected unit defect (a >1 reading renders "110.0%"
// though the engine calls it "a pressure index, not a share") and found
// CORRECT as-is. The engine's ONLY renderer of this block prints it as a
// percentage:
//   `Paid clicks per ${noun} went ${(cd.paidPressure.p1 * 100).toFixed(0)}%
//    -> ${(cd.paidPressure.p2 * 100).toFixed(0)}% -- ${read}.`
//   (ops-bridge-evidence/src/performance-summary.ts, crossDomainSentences)
// which is exactly our `ratio` (stored quotient, rendered x100 with '%'). The
// "not a share" note warns that the number may EXCEED 100%, not that it is
// stored or scaled differently -- the engine keeps the percent rendering in
// full knowledge of it. Relabelling would invent a scale the engine does not
// use. This test therefore passes both before and after; it exists so the
// next unit sweep does not re-open a settled question.
// ---------------------------------------------------------------------------

describe('duo.paidPressure keeps the engine’s own percent reading (decision pin)', () => {
  const figs = byId(extractFigures(loadFixture('envelope-minimal.json')));

  it('stays ratio on both sides', () => {
    expect(figs.get('duo.paidPressure.p1')).toMatchObject({ value: 0.55, unit: 'ratio' });
    expect(figs.get('duo.paidPressure.p2')).toMatchObject({ value: 0.48, unit: 'ratio' });
  });
});

// ---------------------------------------------------------------------------
// END TO END: envelope -> extract -> render -> the string a reader sees.
//
// The report contract validates claim/figure RELATIONSHIPS; nothing in it can
// see that a figure's unit is wrong, so both defects fixed here rode a real
// golden-chain lap with every validator green. These tests assert the
// RENDERED text, which is the only place a unit error is visible. Synthetic
// values only.
// ---------------------------------------------------------------------------

describe('rendered output catches a wrong unit that no validator can see', () => {
  /** Quote the named extracted figures in one section and render the page. */
  function renderQuoting(response: unknown, ids: string[]): string {
    const out = extractFigures(response);
    const wanted = new Set(ids);
    const doc: RenderReportDataDocument = {
      currency: 'USD',
      figures: out.figures.filter((f) => wanted.has(f.id)),
      sections: [{ id: 'sec.units', figure_refs: ids }],
      caveat_registry: out.caveat_registry,
    };
    return renderMonthlyReport(doc);
  }

  /** The displayed value of every figure chip on the page, in order. Asserting
   *  these EXACTLY is the point: a unit defect is invisible in the document
   *  and shows up only as the wrong string here. */
  function chipValues(html: string): string[] {
    return [...html.matchAll(/<span class="rr-figure-value[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
  }

  it('renders an OPS bridge leg as the dollars it is, never as a percentage', () => {
    // THE ORIGINAL DEFECT, from the reader's side: this leg's value is
    // $15,000 of the $44,000 revenue move, but it carried the LEVER's unit
    // ('percent'), so the page printed "15000.0%" -- the exact shape of the
    // live "22448.2%" for $22.4K.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'ops.bridge.ops.primary.conversion',
    ]);
    expect(chipValues(html)).toEqual(['$15,000']);
  });

  it('renders a rate bridge’s legs in points instead of rounding them to zero', () => {
    // Anchor: conversion. A three-point contribution stored as 0.03 printed
    // "0" under the lever's 'number' unit -- a real driver rendered as
    // nothing at all.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'ops.bridge.conversion.primary.units',
      'ops.bridge.conversion.primary.sessions',
    ]);
    expect(chipValues(html)).toEqual(['3.0 pts', '2.0 pts']);
  });

  it('renders a 2.8-point TACoS move as 2.8 points, not 0.0', () => {
    // DEFECT 2 from the reader's side. Under `points` this printed "0.0 pts":
    // a materially worse TACoS quarter reported as no change at all.
    const html = renderQuoting(
      {
        envelope: { bridgeDomain: 'ops', bridgeRunId: 'run-example-e2e-0001', metrics: [], insights: [] },
        crossDomain: { tacos: { p1: 0.083, p2: 0.111, deltaPts: 0.028 } },
      },
      ['duo.tacos.delta_pts'],
    );
    expect(chipValues(html)).toEqual(['2.8 pts']);
    expect(html).not.toContain('0.0 pts');
  });

  it('keeps a leg and the net change it foots to in the same denomination on the page', () => {
    // The legs and their net are quoted side by side in real reports; if the
    // legs took the lever's unit they read as different quantities entirely.
    // $20,000 + $15,000 + $9,000 = $44,000, and the page says so in dollars.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'ops.ops.delta',
      'ops.bridge.ops.primary.sessions',
      'ops.bridge.ops.primary.conversion',
      'ops.bridge.ops.primary.ops_per_unit',
    ]);
    expect(chipValues(html)).toEqual(['$44,000', '$20,000', '$15,000', '$9,000']);
  });

  it('renders a 5-POINT conversion move as points, not as a 5% relative rise', () => {
    // Conversion went 20% -> 25%. The delta is stored 0.05, and under the
    // LEVEL unit ('ratio') the page printed "5.0%" for a move that is five
    // POINTS -- the same string a 5% relative rise would print, off a base
    // this figure never mentions.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), ['ops.conversion.delta']);
    expect(chipValues(html)).toEqual(['5.0 pts']);
    expect(html).not.toContain('5.0%');
  });

  it('renders a rate delta and the legs that foot to it in ONE denomination', () => {
    // THE VISIBLE CONTRADICTION, and the reason this fix follows the leg fix:
    // with the legs correct but the net still on the level unit, one page
    // printed "3.0 pts + 2.0 pts" under a net of "5.0%". Now the reader can
    // add the strip up: 3.0 + 2.0 = 5.0 pts.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'ops.conversion.delta',
      'ops.bridge.conversion.primary.units',
      'ops.bridge.conversion.primary.sessions',
    ]);
    expect(chipValues(html)).toEqual(['5.0 pts', '3.0 pts', '2.0 pts']);
    // the levels either side of that move stay percentages -- a rate is still
    // a rate, only its CHANGE is in points
    const levels = renderQuoting(loadFixture('envelope-minimal.json'), [
      'ops.conversion.p1',
      'ops.conversion.p2',
    ]);
    expect(chipValues(levels)).toEqual(['20.0%', '25.0%']);
  });

  it('renders the cross-domain ASP / ad-AOV mirror with the cents that carry the signal', () => {
    // $50.00 ASP against a $59.38 ad AOV is the whole "is the ads mix richer
    // than the account mix" read. At 0dp the page printed "$59" and the
    // comparison lost its precision on the side that moved.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'duo.asp.p2',
      'duo.adAov.p2',
    ]);
    expect(chipValues(html)).toEqual(['$48.00', '$59.38']);
  });

  it('renders paid pressure exactly as the engine’s own summary sentence does (decision pin)', () => {
    // NOT a fix -- a settled decision, pinned. The engine prints this block as
    // `(p * 100).toFixed(0)%` ("Paid clicks per session went 55% -> 48%"), so
    // 'ratio' is the honest label; its "not a share" note warns the number can
    // exceed 100%, not that it is stored differently. Passes before and after.
    const html = renderQuoting(loadFixture('envelope-minimal.json'), [
      'duo.paidPressure.p1',
      'duo.paidPressure.p2',
    ]);
    expect(chipValues(html)).toEqual(['55.0%', '48.0%']);
  });
});
