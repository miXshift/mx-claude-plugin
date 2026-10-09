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

describe('detail tails take their id from parentId (evidence >= 0.6.0)', () => {
  /**
   * PRODUCER SHAPE, copied from the evidence library's
   * `finalizeEvidenceGroups` (evidence 0.17.0): a finding whose questions carry `details` is
   * split in two. The finding keeps its `id`, becomes
   * `presentationKind: 'finding'` and loses the `details`; the list becomes
   * a TAIL group with NO `id`, `head: "<finding head> — details"`, the
   * finding's `tone`/`domain`, `parentId: <finding id>`,
   * `presentationKind: 'details'`, `rank: EVIDENCE_RANK.DETAILS` and one
   * question per detail (`question`, `measured`, `whereToLook`).
   *
   * The bug this pins: the tail used to be slugged from its HEAD, which is
   * the finding's wording plus a suffix, so its id moved on every copy
   * release (0.15.x-0.16.0 reworded most heads). Its identity is its
   * parent's.
   */
  const tail = (parentId: unknown, findingHead: string, over: Record<string, unknown> = {}) => ({
    head: `${findingHead} — details`,
    tone: 'neutral',
    domain: 'advertising',
    ...(parentId !== undefined ? { parentId } : {}),
    presentationKind: 'details',
    rank: 90,
    questions: [
      { question: 'Campaign A: paused on 2026-09-04.', measured: true, whereToLook: 'Ads Bridge run data' },
      { question: 'Campaign B: daily budget raised on 2026-09-11.', measured: true, whereToLook: 'Ads Bridge run data' },
    ],
    ...over,
  });
  const finding = (head: string) => ({
    id: 'ads-campaign-actions',
    head,
    tone: 'neutral',
    domain: 'advertising',
    presentationKind: 'finding',
    rank: 20,
    questions: [{ question: '2 campaigns were paused and 1 budget was raised in Sep 2026.', measured: true }],
  });
  const run = (groups: unknown[], metric = 'ad_spend') =>
    extractFigures(
      {
        ok: true,
        mom: {
          ops: envelope(),
          ads: null,
          crossDomain: null,
          evidence: { scope: { kind: 'total' }, evidenceVersion: '0.17.0', statements: { [metric]: groups }, notes: [], companionAttached: true },
        },
        yoy: null,
        headline: {},
        limitations: [],
        meta: {},
      },
      'mom.ops',
    ) as { evidence?: { id: string; kind?: string; parent_kind?: string; head: string; statements: string[] }[] };

  it('the tail id is the parent kind plus .details, and parent_kind names the finding', () => {
    const doc = run([finding('what changed on campaigns'), tail('ads-campaign-actions', 'what changed on campaigns')]);
    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toEqual(['mom.evidence.ad_spend.ads-campaign-actions', 'mom.evidence.ad_spend.ads-campaign-actions.details']);
    const t = doc.evidence![1]!;
    expect(t.parent_kind).toBe('ads-campaign-actions');
    expect(t.kind).toBeUndefined();
    expect(t.statements).toHaveLength(2);
  });

  it('rewording the finding (and so the tail head) moves neither id', () => {
    const before = run([finding('what changed on campaigns'), tail('ads-campaign-actions', 'what changed on campaigns')]);
    const after = run([finding('campaign changes this period'), tail('ads-campaign-actions', 'campaign changes this period')]);
    expect(after.evidence!.map((e) => e.id)).toEqual(before.evidence!.map((e) => e.id));
  });

  it('a tail whose parent is unstamped keeps the head slug, as before', () => {
    const doc = run([tail(undefined, 'promo pricing detected')], 'ops');
    expect(doc.evidence![0]!.id).toBe('mom.evidence.ops.promo_pricing_detected_details');
    expect(doc.evidence![0]!.parent_kind).toBeUndefined();
  });

  it('a malformed parentId is treated as unstamped (same shape gate as id)', () => {
    for (const bad of ['Ads.Campaign', 'x'.repeat(65), '', 42, 'a\u0000b']) {
      const doc = run([tail(bad, 'what changed on campaigns')]);
      expect(doc.evidence![0]!.id, String(bad)).toBe('mom.evidence.ad_spend.what_changed_on_campaigns_details');
      expect(doc.evidence![0]!.parent_kind).toBeUndefined();
    }
  });

  it('a parentId on a group that is not a details tail is ignored', () => {
    const doc = run([tail('ads-campaign-actions', 'what changed on campaigns', { presentationKind: 'finding' })]);
    expect(doc.evidence![0]!.id).toBe('mom.evidence.ad_spend.what_changed_on_campaigns_details');
    expect(doc.evidence![0]!.parent_kind).toBeUndefined();
  });

  it('a group carrying its own id keeps it; parentId does not override', () => {
    const doc = run([tail('ads-campaign-actions', 'x', { id: 'ads-budget-limited' })]);
    expect(doc.evidence![0]!.id).toBe('mom.evidence.ad_spend.ads-budget-limited');
    expect(doc.evidence![0]!.parent_kind).toBeUndefined();
  });

  it('two tails of one kind under one metric stay distinct', () => {
    const doc = run([tail('ads-campaign-actions', 'a'), tail('ads-campaign-actions', 'b')]);
    const ids = doc.evidence!.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe('mom.evidence.ad_spend.ads-campaign-actions.details');
  });

  it('two findings of one kind: each tail carries ITS finding id (producer order: findings, then tails)', () => {
    const doc = run([
      finding('first'),
      finding('second'),
      tail('ads-campaign-actions', 'first'),
      tail('ads-campaign-actions', 'second'),
    ]);
    const ids = doc.evidence!.map((e) => e.id);
    expect(ids).toEqual([
      'mom.evidence.ad_spend.ads-campaign-actions',
      'mom.evidence.ad_spend.ads-campaign-actions.1',
      'mom.evidence.ad_spend.ads-campaign-actions.details',
      'mom.evidence.ad_spend.ads-campaign-actions.1.details',
    ]);
  });
});

describe('a card repeated word for word across metric roots is listed once', () => {
  /**
   * PRODUCER SHAPE, copied from served evidence 0.17.0 groups (engine 0.5.8),
   * values invented. The engine hangs some cards on every metric root they
   * bear on with byte-identical text:
   *   - window comparability: `id`, `head`, `rank: 15`, NO tone, served on
   *     ops, units, sessions and conversion;
   *   - the spike/step summary (`ops-entity-surges-summary`): same keys, the
   *     same four roots;
   *   - availability: a `presentationKind: 'finding'` card plus its details
   *     tail (`parentId`, `presentationKind: 'details'`, `rank: 50`), on ops
   *     and units.
   * Other cards of one kind carry each root's own number (promo pricing names
   * the OPS share on ops, the units share on units, and flips tone on
   * ops_per_unit). Those must stay separate entries.
   *
   * Every question carries `measured` and `whereToLook` on the wire; the
   * extractor reads `question` only, so they are kept here to prove the
   * collapse keys on what the document carries, not on wire extras.
   */
  const q = (question: string) => ({ question, measured: true, whereToLook: 'Ops Bridge run data' });
  const windowCard = () => ({
    id: 'ops-window-comparability',
    head: 'Period data gap',
    questions: [
      q('Sep 2026 contains a 3-day zero-sales gap (Sep 4 – Sep 6).\nComparisons against Aug 2026 may understate growth.'),
      q('A 2-day revenue surge on Aug 14 – Aug 15 supplied 9% of Aug 2026 revenue, a short burst rather than a sustained step up.'),
    ],
    rank: 15,
  });
  const surgeCard = () => ({
    id: 'ops-entity-surges-summary',
    head: 'short sales spikes',
    questions: [q('There were short sales spikes in one item group, each measured on its own daily sales.\n• Item Group A: $4.2K on Sep 18 – Sep 19 (3.1× normal sales)')],
    rank: 15,
  });
  const promoCard = (line2: string, tone = 'positive') => ({
    head: 'promo pricing detected',
    id: 'ops-promo-pricing',
    tone,
    answers: [],
    answerEntityKeys: [],
    demotesPricingAsks: true,
    questions: [q(`2 Item Groups show discounting in Sep 2026.\n${line2}`)],
    rank: 10,
    presentationKind: 'finding',
  });
  const availabilityFinding = () => ({
    head: 'availability — net headwind',
    id: 'ops-availability-net',
    tone: 'negative',
    domain: 'ops',
    questions: [q('Estimated lost sales rose across the 1 item with a lost-sales change from Aug 2026 to Sep 2026.')],
    rank: 10,
    presentationKind: 'finding',
  });
  const availabilityTail = (line = 'Estimated lost sales by item:\n\nDrove the rise:\n• Item Group B\n   +$1.1k · OOS 2 → 9 days') => ({
    head: 'availability — net headwind — details',
    tone: 'negative',
    domain: 'ops',
    parentId: 'ops-availability-net',
    presentationKind: 'details',
    rank: 50,
    questions: [q(line)],
  });
  const adsCard = (id: string, question: string) => ({
    head: id.replace(/-/g, ' '),
    id,
    domain: 'advertising',
    tone: 'neutral',
    questions: [q(question)],
  });

  type Entry = {
    id: string;
    kind?: string;
    parent_kind?: string;
    metric: string;
    also_metrics?: string[];
    also_ids?: string[];
    head: string;
    tone?: string;
    statements: string[];
    source_path: string;
  };
  const run = (statements: Record<string, unknown[]>, leg: 'mom' | 'yoy' = 'mom') =>
    (
      extractFigures(
        {
          ok: true,
          mom: {
            ops: envelope(),
            ads: null,
            crossDomain: null,
            ...(leg === 'mom'
              ? { evidence: { scope: { kind: 'total' }, evidenceVersion: '0.17.0', statements, notes: [], companionAttached: true } }
              : {}),
          },
          yoy:
            leg === 'yoy'
              ? {
                  ops: envelope(),
                  ads: null,
                  crossDomain: null,
                  evidence: { scope: { kind: 'total' }, evidenceVersion: '0.17.0', statements, notes: [], companionAttached: true },
                }
              : null,
          headline: {},
          limitations: [],
          meta: {},
        },
        `${leg}.ops`,
      ) as { evidence?: Entry[] }
    ).evidence!;
  /** Every id a citation could name: each entry's id plus its aliases. */
  const allIds = (ev: Entry[]) => ev.flatMap((e) => [e.id, ...(e.also_ids ?? [])]);

  it('window comparability on four roots is one entry naming the other three roots and their ids', () => {
    const ev = run({
      ops: [windowCard(), adsCard('ads-paid-demand-vs-revenue', 'Paid demand moved with the total.')],
      units: [windowCard(), adsCard('ads-paid-orders-vs-units', 'Paid orders rose 4%.')],
      sessions: [windowCard()],
      conversion: [windowCard()],
    });
    const w = ev.filter((e) => e.kind === 'ops-window-comparability');
    expect(w).toHaveLength(1);
    expect(w[0]!.id).toBe('mom.evidence.ops.ops-window-comparability');
    expect(w[0]!.metric).toBe('ops');
    expect(w[0]!.also_metrics).toEqual(['units', 'sessions', 'conversion']);
    expect(w[0]!.also_ids).toEqual([
      'mom.evidence.units.ops-window-comparability',
      'mom.evidence.sessions.ops-window-comparability',
      'mom.evidence.conversion.ops-window-comparability',
    ]);
    expect(w[0]!.statements).toHaveLength(2);
    expect(w[0]!.source_path).toBe('mom.evidence.statements.ops[0]');
  });

  it('every id the uncollapsed extraction gave still resolves, each exactly once', () => {
    const ev = run({
      ops: [windowCard(), surgeCard(), adsCard('ads-paid-demand-vs-revenue', 'Paid demand moved with the total.')],
      units: [windowCard(), surgeCard(), adsCard('ads-paid-orders-vs-units', 'Paid orders rose 4%.')],
      sessions: [windowCard(), surgeCard()],
      conversion: [windowCard(), surgeCard()],
    });
    const ids = allIds(ev);
    const expected = ['ops', 'units', 'sessions', 'conversion'].flatMap((m) => [
      `mom.evidence.${m}.ops-window-comparability`,
      `mom.evidence.${m}.ops-entity-surges-summary`,
    ]);
    expected.push('mom.evidence.ops.ads-paid-demand-vs-revenue', 'mom.evidence.units.ads-paid-orders-vs-units');
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(new Set(ids).size).toBe(ids.length);
    // 10 served groups became 4 entries.
    expect(ev).toHaveLength(4);
  });

  it('cards of one kind whose text differs by one number stay separate, each with its own root', () => {
    const ev = run({
      ops: [promoCard('They account for +$9.5k — 56% of the OPS change sits in them.')],
      units: [promoCard('They account for +318 units — 66% of the Units change sits in them.')],
      conversion: [promoCard('They account for +1.6 pts C2C.')],
      ops_per_unit: [promoCard('They account for +1.6 pts C2C.', 'negative')],
    });
    expect(ev).toHaveLength(4);
    expect(ev.map((e) => e.metric)).toEqual(['ops', 'units', 'conversion', 'ops_per_unit']);
    for (const e of ev) {
      expect('also_metrics' in e).toBe(false);
      expect('also_ids' in e).toBe(false);
    }
    // Same lines, opposite tone: not the same card.
    expect(ev[2]!.tone).toBe('positive');
    expect(ev[3]!.tone).toBe('negative');
  });

  it('a one-character difference in a statement line is enough to keep two entries', () => {
    const a = windowCard();
    const b = windowCard();
    b.questions[1] = q('A 2-day revenue surge on Aug 14 – Aug 15 supplied 8% of Aug 2026 revenue, a short burst rather than a sustained step up.');
    const ev = run({ ops: [a], units: [b] });
    expect(ev.map((e) => e.id)).toEqual(['mom.evidence.ops.ops-window-comparability', 'mom.evidence.units.ops-window-comparability']);
  });

  it('a finding and its details tail repeated on two roots collapse separately, tail ids still from the parent', () => {
    const ev = run({
      ops: [availabilityFinding(), adsCard('ads-paid-demand-vs-revenue', 'Paid demand moved with the total.'), availabilityTail()],
      units: [availabilityFinding(), adsCard('ads-paid-orders-vs-units', 'Paid orders rose 4%.'), availabilityTail()],
    });
    expect(ev.map((e) => e.id)).toEqual([
      'mom.evidence.ops.ops-availability-net',
      'mom.evidence.ops.ads-paid-demand-vs-revenue',
      'mom.evidence.ops.ops-availability-net.details',
      'mom.evidence.units.ads-paid-orders-vs-units',
    ]);
    const tail = ev[2]!;
    expect(tail.parent_kind).toBe('ops-availability-net');
    expect(tail.also_metrics).toEqual(['units']);
    expect(tail.also_ids).toEqual(['mom.evidence.units.ops-availability-net.details']);
    expect(ev[0]!.also_ids).toEqual(['mom.evidence.units.ops-availability-net']);
  });

  it('a tail that differs keeps its own entry, and its parent id resolves through the collapsed finding', () => {
    const ev = run({
      ops: [availabilityFinding(), availabilityTail()],
      units: [availabilityFinding(), availabilityTail('Estimated lost sales by item:\n\nDrove the rise:\n• Item Group B\n   +41 units · OOS 2 → 9 days')],
    });
    expect(ev.map((e) => e.id)).toEqual([
      'mom.evidence.ops.ops-availability-net',
      'mom.evidence.ops.ops-availability-net.details',
      'mom.evidence.units.ops-availability-net.details',
    ]);
    // The units tail's parent is the units copy of the finding, now an alias.
    const unitsTail = ev[2]!;
    const parentId = unitsTail.id.replace(/\.details$/, '');
    const parent = ev.find((e) => e.id === parentId || (e.also_ids ?? []).includes(parentId));
    expect(parent?.kind).toBe(unitsTail.parent_kind);
    expect(parent?.also_metrics).toContain('units');
  });

  it('two identical cards under the SAME root are not merged into each other', () => {
    // The engine served two; listing one would read as one. A third root's
    // identical copy joins the first, and also_metrics names other roots only.
    const ev = run({ ops: [windowCard(), windowCard()], units: [windowCard()] });
    expect(ev.map((e) => e.id)).toEqual(['mom.evidence.ops.ops-window-comparability', 'mom.evidence.ops.ops-window-comparability.1']);
    expect(ev[0]!.also_metrics).toEqual(['units']);
    expect(ev[0]!.also_ids).toEqual(['mom.evidence.units.ops-window-comparability']);
    expect('also_metrics' in ev[1]!).toBe(false);
    for (const e of ev) expect(e.also_metrics ?? []).not.toContain(e.metric);
  });

  it('an alias keeps a collision-suffixed id exactly as the uncollapsed extraction gave it', () => {
    // Unstamped cards slug their head; the second "period data gap" on units
    // takes the `.1` suffix because the first one there differs from ops.
    const plain = (line: string) => ({ head: 'Period data gap', questions: [q(line)] });
    const ev = run({ ops: [plain('Gap A.')], units: [plain('Gap B.'), plain('Gap A.')] });
    expect(ev.map((e) => e.id)).toEqual(['mom.evidence.ops.period_data_gap', 'mom.evidence.units.period_data_gap']);
    expect(ev[0]!.also_ids).toEqual(['mom.evidence.units.period_data_gap.1']);
  });

  it('keeps served order with the later copies removed, and puts the alias fields next to metric', () => {
    const ev = run({
      ops: [windowCard(), adsCard('ads-paid-demand-vs-revenue', 'Paid demand moved with the total.')],
      sessions: [adsCard('ads-paid-vs-traffic', 'Paid clicks moved with the decline.'), windowCard()],
      buy_box: [{ id: 'ops-buybox-flat-band', head: 'buy box held', questions: [q('Buy Box stayed between 97% and 99%.')] }],
    });
    expect(ev.map((e) => e.id)).toEqual([
      'mom.evidence.ops.ops-window-comparability',
      'mom.evidence.ops.ads-paid-demand-vs-revenue',
      'mom.evidence.sessions.ads-paid-vs-traffic',
      'mom.evidence.buy_box.ops-buybox-flat-band',
    ]);
    expect(Object.keys(ev[0]!)).toEqual(['id', 'kind', 'metric', 'also_metrics', 'also_ids', 'head', 'statements', 'source_path']);
  });

  it('a card served on one root carries no alias fields at all', () => {
    const ev = run({ ops: [surgeCard()] });
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0]!)).toEqual(['id', 'kind', 'metric', 'head', 'statements', 'source_path']);
  });

  it('collapses within the YoY document the same way, under yoy ids', () => {
    const ev = run({ ops: [windowCard()], units: [windowCard()] }, 'yoy');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.id).toBe('yoy.evidence.ops.ops-window-comparability');
    expect(ev[0]!.also_ids).toEqual(['yoy.evidence.units.ops-window-comparability']);
  });
});
