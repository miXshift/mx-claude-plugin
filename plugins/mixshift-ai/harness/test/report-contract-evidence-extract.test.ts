import { describe, it, expect } from 'vitest';
import { extractFigures } from '../src/lib/report-contract/extract';

/**
 * Extracting the "What we know" statements into typed, referenceable entries.
 *
 * The gap this closes, named by the engine author: the `evidence` block was
 * never extracted, so the statements were unreachable from Report Max even
 * once the service served them.
 *
 * They are NOT figures. A figure is a number with a unit that a claim quotes;
 * a statement is engine-authored prose. Their purpose is `CAUSE-1`: a causal
 * claim must carry a `mechanism`, and until now the model authored that prose
 * unsupported. A served statement lets the mechanism cite the engine's own
 * account of the move.
 */

const STATEMENTS = {
  ops: [
    {
      head: 'promo pricing detected',
      tone: 'positive',
      questions: [
        { question: 'Deals ran on 3 ASINs during the period.', measured: true },
        { question: 'Realized price fell 12% against the in-stock baseline.', measured: true },
      ],
    },
    { head: 'availability - net tailwind', tone: 'positive', questions: [{ question: 'Estimated lost sales fell.' }] },
  ],
  units: [{ head: 'promo pricing detected', tone: 'positive', questions: [{ question: 'Units rose 8%.' }] }],
};

const envelope = () => ({ bridgeDomain: 'ops', currency: 'USD', metrics: [], insights: [] });
const single = () => ({ envelope: envelope(), evidence: { scope: { kind: 'total' }, statements: STATEMENTS, notes: [], companionAttached: false } });
const composite = (leg: 'mom' | 'yoy' = 'mom') => ({
  ok: true,
  mom: {
    ops: envelope(),
    ads: null,
    crossDomain: null,
    ...(leg === 'mom' ? { evidence: { scope: { kind: 'total' }, statements: STATEMENTS, notes: [], companionAttached: false } } : {}),
  },
  yoy:
    leg === 'yoy'
      ? { ops: envelope(), ads: null, crossDomain: null, evidence: { scope: { kind: 'total' }, statements: STATEMENTS, notes: [], companionAttached: false } }
      : null,
  headline: {},
  limitations: [],
  meta: {},
});

describe('evidence extraction', () => {
  it('extracts a statement group per metric root, with its lines', () => {
    const doc = extractFigures(single()) as { evidence?: { id: string; statements: string[] }[] };
    expect(doc.evidence).toBeDefined();
    expect(doc.evidence!.length).toBe(3); // 2 ops groups + 1 units group
    const first = doc.evidence!.find((e) => e.id.includes('promo_pricing'))!;
    expect(first.statements.length).toBe(2);
    expect(first.statements[0]).toContain('Deals ran on 3 ASINs');
  });

  it('is ABSENT, not empty, when the run carried no evidence', () => {
    // An empty array would read as "the engine had nothing to say", which is a
    // different claim from "evidence was not requested".
    const doc = extractFigures({ envelope: envelope() }) as { evidence?: unknown };
    expect(doc.evidence).toBeUndefined();
  });

  it('carries a source_path so a reader can go check the statement', () => {
    const doc = extractFigures(single()) as { evidence?: { source_path: string }[] };
    expect(doc.evidence![0]!.source_path).toMatch(/^evidence\.statements\./);
  });
});

describe('ids are period-namespaced on a composite', () => {
  /**
   * The identical-ids failure this composite already shipped at the figure
   * layer: `mom.ops` and `yoy.ops` emitted the same ids, so a MoM reference
   * silently resolved to the YoY value while every validator reported clean.
   * The skill composes every selection's document into ONE report, so
   * statements carry the same hazard in prose.
   */
  it('prefixes mom evidence ids with the period', () => {
    const doc = extractFigures(composite('mom'), 'mom.ops') as { evidence?: { id: string }[] };
    expect(doc.evidence!.length).toBeGreaterThan(0);
    for (const e of doc.evidence!) expect(e.id.startsWith('mom.evidence.')).toBe(true);
  });

  it('prefixes yoy evidence ids with the period', () => {
    const doc = extractFigures(composite('yoy'), 'yoy.ops') as { evidence?: { id: string }[] };
    expect(doc.evidence!.length).toBeGreaterThan(0);
    for (const e of doc.evidence!) expect(e.id.startsWith('yoy.evidence.')).toBe(true);
  });

  it('a MoM id and a YoY id for the SAME statement never collide', () => {
    const mom = extractFigures(composite('mom'), 'mom.ops') as { evidence?: { id: string }[] };
    const yoy = extractFigures(composite('yoy'), 'yoy.ops') as { evidence?: { id: string }[] };
    const momIds = new Set(mom.evidence!.map((e) => e.id));
    for (const e of yoy.evidence!) expect(momIds.has(e.id)).toBe(false);
  });
});

describe('emitted on the ops selection only', () => {
  it('mom.ads yields NO evidence, because it resolves to the same mom.evidence block', () => {
    // Both selections read one block. Emitting on each would duplicate every id
    // across two documents the model merges into one report.
    //
    // The ads leg needs a real envelope here: with `ads: null` the selection
    // legitimately throws before reaching the evidence path, which would have
    // made this test pass for the wrong reason.
    const withAds = composite('mom') as unknown as Record<string, Record<string, unknown>>;
    withAds.mom!.ads = { bridgeDomain: 'ads', currency: 'USD', metrics: [], insights: [] };
    const doc = extractFigures(withAds, 'mom.ads') as { evidence?: unknown };
    expect(doc.evidence).toBeUndefined();
  });
});

describe('id shape', () => {
  it('slugs the head into a readable, stable id', () => {
    const doc = extractFigures(single()) as { evidence?: { id: string }[] };
    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toContain('evidence.ops.promo_pricing_detected');
    // Same head on a DIFFERENT metric is a different id, not a collision.
    expect(ids).toContain('evidence.units.promo_pricing_detected');
  });

  it('every id is unique within a document', () => {
    const doc = extractFigures(single()) as { evidence?: { id: string }[] };
    const ids = doc.evidence!.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
