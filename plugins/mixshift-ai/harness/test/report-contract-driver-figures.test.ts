import { describe, it, expect } from 'vitest';
import { extractFigures } from '../src/lib/report-contract/extract';

/**
 * Per-driver change figures, capped and ranked-only.
 *
 * These exist for the template's driver tables (item-group highlights, top
 * movers): until they did, the only presentable numbers were account totals,
 * so a "which lines moved" table could not be composed from typed figures at
 * all. Two rules carry the safety:
 *
 * 1. RANKED ONLY. Upstream appends drill-signal entities beyond the display
 *    cap and stamps `includedBy` so a consumer cannot read a tail row as a
 *    top mover. A driver FIGURE must never be a drill appendee wearing a
 *    top-mover id. Absent marker = ranked (pre-marker sidecars).
 * 2. CAPPED at 5. The template rule: the reader wants the finding, not the
 *    ranking. The full list stays countable via the delta figure's
 *    population.
 */

const driver = (key: string, name: string, delta: number, includedBy?: string) => ({
  entityKey: key,
  displayName: name,
  delta,
  ...(includedBy ? { includedBy } : {}),
});

const envelope = (drivers: unknown[]) => ({
  envelope: {
    bridgeDomain: 'ops',
    currency: 'USD',
    metrics: [
      {
        metricKey: 'ops',
        totals: { p1: 100, p2: 200, delta: 100, pctChange: 100 },
        topDrivers: drivers,
      },
    ],
    insights: [],
  },
});

const driverFigs = (doc: unknown) =>
  (extractFigures(doc) as { figures: { id: string; label: string; value: unknown }[] }).figures.filter(
    (f) => f.id.includes('.driver.'),
  );

describe('driver figures', () => {
  it('emits one figure per ranked driver, capped at 5', () => {
    const drivers = Array.from({ length: 9 }, (_, i) => driver(`E${i}`, `Line ${i}`, 100 - i));
    const figs = driverFigs(envelope(drivers));
    expect(figs.length).toBe(5);
    expect(figs[0]!.id).toBe('ops.ops.driver.1');
    expect(figs[0]!.label).toBe('Line 0');
    expect(figs[0]!.value).toBe(100);
  });

  it('EXCLUDES drill-signal appendees, the rule the marker exists for', () => {
    const drivers = [
      driver('E1', 'Real mover', 500, 'rank'),
      driver('E2', 'Drill appendee', 499, 'drill_signal'),
      driver('E3', 'Unmarked (pre-marker = ranked)', 400),
    ];
    const figs = driverFigs(envelope(drivers));
    const labels = figs.map((f) => f.label);
    expect(labels).toContain('Real mover');
    expect(labels).toContain('Unmarked (pre-marker = ranked)');
    expect(labels).not.toContain('Drill appendee');
  });

  it('ids use RANK, never entity names', () => {
    // Names are unbounded display labels; rank is stable within a run. A
    // name-derived id would also collide when two entities share a label.
    const figs = driverFigs(envelope([driver('E1', 'Same Name', 10), driver('E2', 'Same Name', 9)]));
    expect(figs.map((f) => f.id)).toEqual(['ops.ops.driver.1', 'ops.ops.driver.2']);
  });

  it('skips a driver with no delta rather than emitting a valueless figure', () => {
    const figs = driverFigs(envelope([{ entityKey: 'E1', displayName: 'No delta' }, driver('E2', 'Has delta', 5)]));
    expect(figs.map((f) => f.label)).toEqual(['Has delta']);
  });

  it('emits nothing when there are no topDrivers', () => {
    expect(driverFigs(envelope([]))).toEqual([]);
  });

  it('period-prefixes on a composite selection like every other figure', () => {
    const comp = {
      ok: true,
      mom: { ops: envelope([driver('E1', 'Line', 10)]).envelope, ads: null, crossDomain: null },
      yoy: null,
      headline: {},
      limitations: [],
      meta: {},
    };
    const figs = (extractFigures(comp, 'mom.ops') as { figures: { id: string }[] }).figures.filter((f) =>
      f.id.includes('.driver.'),
    );
    expect(figs[0]!.id).toBe('mom.ops.ops.driver.1');
  });
});
