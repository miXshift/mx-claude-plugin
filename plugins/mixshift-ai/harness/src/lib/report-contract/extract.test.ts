import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFigures, checkFigures, CompositeSelectionError, COMPOSITE_SELECTIONS } from './extract.js';
import type { ExtractDocument, ExtractedFigure, CompositeSelection } from './extract.js';

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
    expect(figs.get('ops.conversion.delta')).toMatchObject({ value: 0.05, unit: 'ratio', basis: 'sessions' });
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
    expect(figs.get('duo.tacos.delta_pts')).toMatchObject({ value: -0.03, unit: 'points' });
    expect(figs.get('duo.attributedShare.delta_pts')).toMatchObject({ value: 0.02 });
    expect(figs.get('duo.paidPressure.p1')).toMatchObject({ value: 0.55 });
    expect(figs.get('duo.asp.p1')).toMatchObject({ value: 50, unit: 'currency' });
    expect(figs.get('duo.adAov.p2')).toMatchObject({ value: 59.38 });
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
