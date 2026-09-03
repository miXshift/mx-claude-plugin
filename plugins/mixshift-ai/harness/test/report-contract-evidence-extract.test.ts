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

describe('served stable ids (evidence 0.5.0)', () => {
  // DriverQuestionGroup.id: a wording-independent semantic slug of the card
  // KIND, stamped as cards are touched. The contract's own rule: key on it
  // where present, keep a content fallback, absence is not an error.
  const stamped = () => ({
    envelope: envelope(),
    evidence: {
      scope: { kind: 'total' },
      evidenceVersion: '0.5.0',
      statements: {
        ops: [
          {
            id: 'ops-promo-pricing',
            head: 'promo pricing detected',
            tone: 'positive',
            questions: [{ question: '9 ASINs were discounted in Mar 2026.' }],
          },
          // Unstamped sibling in the same run: the details sub-card ships
          // without an id on the wire today. Must keep the head-slug id and
          // carry no kind, not error and not collide.
          { head: 'promo pricing detected — details', questions: [{ question: 'detail line' }] },
        ],
        units: [
          {
            id: 'ops-promo-pricing',
            head: 'promo pricing detected',
            questions: [{ question: 'Units rose.' }],
          },
        ],
      },
      notes: [],
      companionAttached: false,
    },
  });

  it('prefers the served id for the slug leg, verbatim, and surfaces it as kind', () => {
    const doc = extractFigures(stamped()) as { evidence?: { id: string; kind?: string }[] };
    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toContain('evidence.ops.ops-promo-pricing');
    const stampedEntry = doc.evidence!.find((e) => e.id === 'evidence.ops.ops-promo-pricing')!;
    expect(stampedEntry.kind).toBe('ops-promo-pricing');
  });

  it('one kind under two metric roots stays two distinct, addressable ids', () => {
    const doc = extractFigures(stamped()) as { evidence?: { id: string }[] };
    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toContain('evidence.ops.ops-promo-pricing');
    expect(ids).toContain('evidence.units.ops-promo-pricing');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a degenerate served id is treated as unstamped, not served verbatim (red team 2026-09-01, P2)', () => {
    // The extractor also runs over user-supplied JSON, and a kind can be
    // quoted into a customer-facing citation. Ids that do not look like the
    // contract's slugs (length-capped lowercase kebab) degrade to the head
    // slug — the absence posture — never flow through.
    const degenerate = (id: unknown) =>
      extractFigures({
        envelope: envelope(),
        evidence: {
          scope: { kind: 'total' },
          statements: { ops: [{ id, head: 'promo pricing detected', questions: [{ question: 'x' }] }] },
          notes: [],
          companionAttached: false,
        },
      }) as { evidence?: { id: string; kind?: string }[] };

    for (const bad of [
      'a'.repeat(65), // over the 64-char cap, alphabet otherwise valid
      'ops.promo.pricing', // dots mimic our id segments
      'Ops-Promo', // wrong case — not the contract's alphabet
      '-leading-dash',
      'has space',
      'ctrl\u0000byte', // control byte, written as an escape so the source stays text
    ]) {
      const doc = degenerate(bad);
      expect(doc.evidence![0]!.id).toBe('evidence.ops.promo_pricing_detected');
      expect('kind' in doc.evidence![0]!).toBe(false);
    }
  });

  it('an unstamped card keeps its pre-0.5.0 head-slug id and carries no kind', () => {
    const doc = extractFigures(stamped()) as { evidence?: { id: string; kind?: string }[] };
    const fallback = doc.evidence!.find((e) => e.id.includes('details'))!;
    expect(fallback.id).toBe('evidence.ops.promo_pricing_detected_details');
    expect('kind' in fallback).toBe(false);
  });

  it('surfaces the block-level evidenceVersion as evidence_version, only when stamped', () => {
    const withStamp = extractFigures(stamped()) as { evidence_version?: string };
    expect(withStamp.evidence_version).toBe('0.5.0');
    // Pre-0.2.0 block (the existing fixture has no stamp): field absent, not null.
    const withoutStamp = extractFigures(single()) as Record<string, unknown>;
    expect('evidence_version' in withoutStamp).toBe(false);
  });
});

describe('newly served statement groups flow through unmodified', () => {
  it('extracts groups under metric roots this code has never seen (append-only tolerance)', () => {
    // Evidence 0.3.0 began serving two previously popup-only groups, one
    // under a metric root (`sessions`) that never carried statements before.
    // The extractor iterates metric keys generically, so these must flow
    // through with zero code awareness — this pins that no allowlist creeps
    // in later.
    const doc = extractFigures({
      envelope: envelope(),
      evidence: {
        scope: { kind: 'total' },
        evidenceVersion: '0.5.0',
        statements: {
          ops: [
            {
              id: 'ads-paid-demand-vs-revenue',
              head: 'revenue vs paid demand',
              questions: [{ question: 'Paid demand moved with the total and likely contributed.' }],
            },
          ],
          sessions: [
            {
              id: 'ads-paid-vs-traffic',
              head: 'traffic vs paid clicks',
              questions: [{ question: 'Paid clicks moved with the decline, but much less sharply than total traffic.' }],
            },
          ],
        },
        notes: [],
        companionAttached: true,
      },
    }) as { evidence?: { id: string; kind?: string; metric: string }[] };

    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toContain('evidence.ops.ads-paid-demand-vs-revenue');
    expect(ids).toContain('evidence.sessions.ads-paid-vs-traffic');
    expect(doc.evidence!.find((e) => e.metric === 'sessions')!.kind).toBe('ads-paid-vs-traffic');
  });
});
