import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFigures, checkFigures } from './extract.js';
import type { ExtractDocument, ExtractedFigure } from './extract.js';

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
    expect(figs.get('ops.ops_per_unit.delta')).toMatchObject({ value: -2, unit: 'currency', basis: 'ordered_revenue' });
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
  function adsOut(totalP1: number, sameP1: number, otherP1: number, vtP1: number) {
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
      },
      figures: [
        f({ id: 'ads.ad_sales.p1', value: totalP1 }),
        f({ id: 'ads.ad_sales_same_sku.p1', value: sameP1 }),
        f({ id: 'ads.ad_sales_other_sku.p1', value: otherP1 }),
        f({ id: 'ads.ad_sales_view_through.p1', value: vtP1 }),
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
});
