/**
 * report-contract/validate.ts — TypeScript port of the report-contract
 * executable spec (`validate_report_data.py`, upstream MixShift bridge
 * methodology). Same stable rule IDs, same fixture semantics — this is the
 * render-seam validator the smart-tier monthly report skill runs its
 * assembled report-data document through before it renders prose.
 *
 * The document is a typed composition (never loose numbers in prose):
 *   Figure   — a number the engine published (source_path resolves into the
 *              envelope or a shared-library query; carries a basis and any
 *              blocking caveats).
 *   Derived  — a number the report computed itself (inputs[] + a
 *              why_not_published sentence explaining why the published
 *              figure would not do).
 *   Claim    — a sentence the report intends to make; `kind` drives what the
 *              validator demands (superlative/quantifier claims need a
 *              re-evaluatable population; causal claims need a mechanism).
 *   Caveat   — a registry entry; `severity: blocking` bars bare quotation of
 *              its figure anywhere, per quotation site.
 *   Section  — a quotation site; caveats travel here, per site.
 *
 * Rules:
 *   BASIS-1   one basis per label per document
 *   TRACE-1   every Figure carries a source_path; every ref resolves
 *   TRACE-2   Derived requires non-empty inputs[] AND why_not_published
 *   TRACE-3   a Derived that shadows a published Figure's label must name
 *             that figure's id inside why_not_published
 *   CAVEAT-1  a figure's blocking caveats render in EVERY section quoting it
 *   POP-1     superlative/quantifier claims need a population with
 *             complete: true
 *   POP-2     superlative/quantifier claims re-evaluate TRUE against the
 *             members
 *   CAUSE-1   causal claims require mechanism + tested_alternatives
 *   CAUSE-2   non-causal claims may not use causal language
 *   COMP-1    a claim's comparison_basis must match its figures' basis; a
 *             comparison claim may not mix bases
 *   UNIT-1    an item_days figure never renders as plain "days"
 *
 * The input document is untrusted JSON (it is assembled by a report-writing
 * pass and may be malformed), so every field the Python source reads via
 * `.get(...)` with a default is optional here too, and every access mirrors
 * that same permissiveness — a validator that crashes on a malformed
 * document defeats its own purpose. The handful of fields the Python source
 * reads via direct `dict[...]` indexing (an object's own `id`/`label`) are
 * modeled as required, matching the object contract in the handover README.
 */

const BLOCKING = 'blocking';
const POP_KINDS = new Set(['superlative', 'quantifier']);

// Semantically identical to the Python source's CAUSAL_LANG / DAYS_TEXT.
const CAUSAL_LANG =
  /\b(caused?|causes|causing|drove|drives?|driving|due to|led to|leads to|because)\b/i;
const DAYS_TEXT = /\b\d[\d,]*\s*days?\b/i;

export type RuleId =
  | 'BASIS-1'
  | 'TRACE-1'
  | 'TRACE-2'
  | 'TRACE-3'
  | 'CAVEAT-1'
  | 'POP-1'
  | 'POP-2'
  | 'CAUSE-1'
  | 'CAUSE-2'
  | 'COMP-1'
  | 'UNIT-1';

export interface Finding {
  rule: RuleId;
  subject: string;
  detail: string;
}

export interface PopulationMember {
  key: string;
  [field: string]: unknown;
}

export interface Population {
  complete?: boolean;
  members?: PopulationMember[];
}

/** Fields shared by Figure and Derived that CAVEAT-1 / UNIT-1 / BASIS-1 /
 *  COMP-1 read off whichever object a ref resolves to (a Figure or a
 *  Derived), the same way the Python source treats its merged `all_figs`
 *  dict as one shape regardless of which list an entry came from. */
export interface FigureCommon {
  id: string;
  label: string;
  value?: number;
  unit?: string;
  basis?: string;
  /** Only meaningful on a Figure, but read defensively off any resolved
   *  object (matches the Python source's `f.get("caveats", [])`). */
  caveats?: string[];
  /** Only meaningful on a Figure, but read defensively off any resolved
   *  object (matches the Python source's `f.get("population")`). */
  population?: Population;
}

export interface Figure extends FigureCommon {
  source_path?: string;
  precision?: number;
  confidence?: unknown;
}

export interface Derived extends FigureCommon {
  inputs?: string[];
  why_not_published?: string;
}

export interface CaveatRegistryEntry {
  text?: string;
  severity?: string;
}

export interface EvalCheckPredicate {
  member_key: string;
  op: 'lt' | 'gt' | 'le' | 'ge' | 'eq';
  value: unknown;
}

export interface ExtremumCheck {
  type: 'extremum';
  member_key: string;
  direction: 'max' | 'min';
  claimed_member: string;
}

export interface ExtremumSetCheck {
  type: 'extremum_set';
  member_key: string;
  direction: 'max' | 'min';
  n: number;
  claimed_members: string[];
}

export interface CountCheck {
  type: 'count';
  predicate: EvalCheckPredicate;
  claimed_count: number;
}

export interface NoneCheck {
  type: 'none';
  predicate: EvalCheckPredicate;
}

export interface ShareOfTotalCheck {
  type: 'share_of_total';
  numerator: string;
  denominator: string;
  claimed_band: [number, number];
}

export type Check =
  | ExtremumCheck
  | ExtremumSetCheck
  | CountCheck
  | NoneCheck
  | ShareOfTotalCheck;

export type ClaimKind =
  | 'observation'
  | 'comparison'
  | 'quantifier'
  | 'superlative'
  | 'tracking'
  | 'causal';

export interface Claim {
  id: string;
  kind?: ClaimKind | string;
  text?: string;
  figure_refs?: string[];
  population_ref?: string;
  check?: Check;
  mechanism?: string;
  tested_alternatives?: unknown[];
  comparison_basis?: string;
}

export interface Section {
  id: string;
  figure_refs?: string[];
  claim_refs?: string[];
  caveats_rendered?: string[];
  display_text?: string;
  /** When set, this section is a thin pointer at `doc.shared_blocks[ref]`
   *  (see render-report.ts's `SectionDisplay`); the section's own
   *  `figure_refs` / `caveats_rendered` / `display_text` are ignored at
   *  render time in favor of the resolved block's. The validator only needs
   *  to know the ref resolves (TRACE-1) -- the block itself is validated as
   *  its own quotation site, see `shared_blocks` below. */
  shared_block_ref?: string;
}

/** A shared block (render-report.ts's `doc.shared_blocks[ref]`) is content
 *  authored once and injected at every section pointing to it via
 *  `shared_block_ref`, rendered byte-identically at each site. It is a
 *  quotation site in its own right -- it carries the figure_refs and
 *  caveats_rendered that actually reach the page, not whatever a pointer
 *  section happens to declare -- so TRACE-1 / CAVEAT-1 / UNIT-1 walk it the
 *  same way they walk an ordinary Section. */
export interface SharedBlock {
  display_text?: string;
  figure_refs?: string[];
  claim_refs?: string[];
  caveats_rendered?: string[];
}

export interface ReportDataDocument {
  schema_version?: string;
  brand_slug?: string;
  currency?: string;
  figures?: Figure[];
  derived?: Derived[];
  caveat_registry?: Record<string, CaveatRegistryEntry>;
  claims?: Claim[];
  sections?: Section[];
  shared_blocks?: Record<string, SharedBlock>;
}

/** The figures a quotation site (Section or SharedBlock) quotes: its own
 *  `figure_refs` plus the `figure_refs` of every claim it references via
 *  `claim_refs`. Mirrors render-report.ts's `quotedFigureIds` -- the
 *  renderer already expands claim_refs this way, so the validator must too
 *  (a claim-only reference to a blocking-caveat figure, an item_days figure,
 *  or an unresolved claim id must not bypass CAVEAT-1 / UNIT-1 / TRACE-1). */
function quotedIds(
  figureRefs: readonly string[] | undefined,
  claimRefs: readonly string[] | undefined,
  claims: Map<string, Claim>,
): Set<string> {
  const quoted = new Set<string>(figureRefs ?? []);
  for (const cid of claimRefs ?? []) {
    for (const rid of claims.get(cid)?.figure_refs ?? []) quoted.add(rid);
  }
  return quoted;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function formatList(values: readonly string[]): string {
  return `[${[...values].sort().map((v) => `'${v}'`).join(', ')}]`;
}

function compareOp(op: EvalCheckPredicate['op'], a: unknown, b: unknown): boolean {
  switch (op) {
    case 'lt':
      return (a as never) < (b as never);
    case 'gt':
      return (a as never) > (b as never);
    case 'le':
      return (a as never) <= (b as never);
    case 'ge':
      return (a as never) >= (b as never);
    case 'eq':
      return a === b;
    default:
      return false;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Ops whose comparator is only meaningful between numbers. `eq` is exempt
 *  by design — comparing two strings for equality is legitimate and the
 *  Python source never rejects it. */
const NUMERIC_OPS = new Set<EvalCheckPredicate['op']>(['lt', 'gt', 'le', 'ge']);

/** Count members matching a predicate. Fails closed rather than coercing: a
 *  present-but-non-numeric member value under a numeric op (lt/gt/le/ge) is
 *  reported via `nonNumeric` instead of being silently excluded from the
 *  count, mirroring the Python source's hard TypeError on the same input. */
function countPred(
  members: readonly PopulationMember[],
  pred: EvalCheckPredicate,
): { count: number; nonNumeric?: PopulationMember } {
  const { member_key: memberKey, op, value } = pred;
  const numericOp = NUMERIC_OPS.has(op);
  let n = 0;
  for (const m of members) {
    if (!(memberKey in m)) continue;
    if (numericOp && !isFiniteNumber(m[memberKey])) {
      return { count: n, nonNumeric: m };
    }
    if (compareOp(op, m[memberKey], value)) n++;
  }
  return { count: n };
}

/** Re-evaluate a machine-checkable claim against its population.
 *  Mirrors validate_report_data.py's eval_check(chk, members, all_figs). */
function evalCheck(
  chk: Check,
  members: readonly PopulationMember[],
  allFigs: Map<string, FigureCommon>,
): { ok: boolean; why: string } {
  const t = chk.type;

  if (t === 'extremum' || t === 'extremum_set') {
    const key = chk.member_key;
    const rev = chk.direction === 'max';
    const present = members.filter((m) => key in m);
    // Fail closed rather than coercing: the sort comparator below returns 0
    // on a NaN comparison, which would silently rank a formatted-string
    // value as tied-for-extremum and let a false superlative validate
    // CLEAN. Refuse to rank at all if any checked value isn't numeric.
    const nonNumeric = present.find((m) => !isFiniteNumber(m[key]));
    if (nonNumeric) {
      return {
        ok: false,
        why: `member '${nonNumeric.key}' has non-numeric '${key}'`,
      };
    }
    const ranked = present.slice().sort((a, b) => {
      const av = a[key] as number;
      const bv = b[key] as number;
      if (av < bv) return rev ? 1 : -1;
      if (av > bv) return rev ? -1 : 1;
      return 0;
    });

    if (t === 'extremum') {
      const actual = ranked[0]?.key;
      if (actual !== chk.claimed_member) {
        return {
          ok: false,
          why: `claimed '${chk.claimed_member}' is the ${chk.direction} of '${key}' but '${actual}' is (${ranked[0]?.[key]})`,
        };
      }
      return { ok: true, why: '' };
    }

    const n = chk.n;
    const actual = new Set(ranked.slice(0, n).map((m) => m.key));
    const claimed = new Set(chk.claimed_members);
    if (!setsEqual(actual, claimed)) {
      return {
        ok: false,
        why: `claimed ${chk.direction}-${n} set ${formatList(chk.claimed_members)}; actual ${formatList([...actual])}`,
      };
    }
    return { ok: true, why: '' };
  }

  if (t === 'count') {
    const { count: n, nonNumeric } = countPred(members, chk.predicate);
    if (nonNumeric) {
      return {
        ok: false,
        why: `member '${nonNumeric.key}' has non-numeric '${chk.predicate.member_key}'`,
      };
    }
    if (n !== chk.claimed_count) {
      return {
        ok: false,
        why: `claimed ${chk.claimed_count} of ${members.length} members match; ${n} do`,
      };
    }
    return { ok: true, why: '' };
  }

  if (t === 'none') {
    const { count: n, nonNumeric } = countPred(members, chk.predicate);
    if (nonNumeric) {
      return {
        ok: false,
        why: `member '${nonNumeric.key}' has non-numeric '${chk.predicate.member_key}'`,
      };
    }
    if (n) {
      return { ok: false, why: `claimed none match; ${n} member(s) do` };
    }
    return { ok: true, why: '' };
  }

  if (t === 'share_of_total') {
    const numVal = allFigs.get(chk.numerator)?.value;
    const denVal = allFigs.get(chk.denominator)?.value;
    if (!isFiniteNumber(numVal)) {
      return { ok: false, why: `numerator '${chk.numerator}' has a non-numeric value` };
    }
    if (!isFiniteNumber(denVal)) {
      return { ok: false, why: `denominator '${chk.denominator}' has a non-numeric value` };
    }
    if (denVal === 0) {
      return { ok: false, why: `denominator '${chk.denominator}' is zero` };
    }
    const ratio = numVal / denVal;
    const [lo, hi] = chk.claimed_band;
    if (!(lo <= ratio && ratio <= hi)) {
      return {
        ok: false,
        why: `share is ${ratio.toFixed(2)}, outside the claimed band [${lo}, ${hi}]`,
      };
    }
    return { ok: true, why: '' };
  }

  return { ok: false, why: `unknown check type '${String((chk as { type?: unknown }).type)}'` };
}

/** Validate an assembled report-data document against the render-seam
 *  contract. Pure function, never throws on a malformed-but-well-typed
 *  document (mirrors the Python source's `.get(...)` permissiveness) —
 *  returns the list of findings, empty when clean. */
export function validateReportData(doc: ReportDataDocument): Finding[] {
  const findings: Finding[] = [];

  const figures = new Map<string, Figure>();
  for (const f of doc.figures ?? []) figures.set(f.id, f);

  const derived = new Map<string, Derived>();
  for (const d of doc.derived ?? []) derived.set(d.id, d);

  const allFigs = new Map<string, FigureCommon>();
  for (const [id, f] of figures) allFigs.set(id, f);
  for (const [id, d] of derived) allFigs.set(id, d);

  const claims = new Map<string, Claim>();
  for (const c of doc.claims ?? []) claims.set(c.id, c);

  const registry = doc.caveat_registry ?? {};
  const sections = doc.sections ?? [];
  const sharedBlocks = doc.shared_blocks ?? {};

  // BASIS-1 -- one basis per label
  const byLabel = new Map<string, Set<string | undefined>>();
  for (const f of [...figures.values(), ...derived.values()]) {
    const key = f.label.trim().toLowerCase();
    const set = byLabel.get(key) ?? new Set<string | undefined>();
    set.add(f.basis);
    byLabel.set(key, set);
  }
  for (const label of [...byLabel.keys()].sort()) {
    const bases = byLabel.get(label)!;
    if (bases.size > 1) {
      const sortedBases = [...bases].map((b) => String(b)).sort();
      findings.push({
        rule: 'BASIS-1',
        subject: label,
        detail: `label carries ${bases.size} bases: ${sortedBases.join(', ')}`,
      });
    }
  }

  // TRACE-1 -- source paths and reference resolution
  for (const f of figures.values()) {
    if (!f.source_path) {
      findings.push({ rule: 'TRACE-1', subject: f.id, detail: 'figure has no source_path' });
    }
  }
  for (const c of claims.values()) {
    for (const rid of c.figure_refs ?? []) {
      if (!allFigs.has(rid)) {
        findings.push({
          rule: 'TRACE-1',
          subject: c.id,
          detail: `figure_ref '${rid}' does not resolve`,
        });
      }
    }
    const pr = c.population_ref;
    if (pr && !allFigs.has(pr)) {
      findings.push({
        rule: 'TRACE-1',
        subject: c.id,
        detail: `population_ref '${pr}' does not resolve`,
      });
    }
  }
  for (const s of sections) {
    for (const rid of s.figure_refs ?? []) {
      if (!allFigs.has(rid)) {
        findings.push({
          rule: 'TRACE-1',
          subject: s.id,
          detail: `figure_ref '${rid}' does not resolve`,
        });
      }
    }
    for (const cid of s.claim_refs ?? []) {
      if (!claims.has(cid)) {
        findings.push({
          rule: 'TRACE-1',
          subject: s.id,
          detail: `claim_ref '${cid}' does not resolve`,
        });
      }
    }
    if (s.shared_block_ref && !Object.prototype.hasOwnProperty.call(sharedBlocks, s.shared_block_ref)) {
      findings.push({
        rule: 'TRACE-1',
        subject: s.id,
        detail: `shared_block_ref '${s.shared_block_ref}' does not resolve`,
      });
    }
  }
  for (const [ref, block] of Object.entries(sharedBlocks)) {
    for (const rid of block.figure_refs ?? []) {
      if (!allFigs.has(rid)) {
        findings.push({
          rule: 'TRACE-1',
          subject: `shared_blocks.${ref}`,
          detail: `figure_ref '${rid}' does not resolve`,
        });
      }
    }
    for (const cid of block.claim_refs ?? []) {
      if (!claims.has(cid)) {
        findings.push({
          rule: 'TRACE-1',
          subject: `shared_blocks.${ref}`,
          detail: `claim_ref '${cid}' does not resolve`,
        });
      }
    }
  }
  for (const d of derived.values()) {
    for (const rid of d.inputs ?? []) {
      if (!allFigs.has(rid) && !(rid.startsWith('sql:') || rid.startsWith('envelope:'))) {
        findings.push({
          rule: 'TRACE-1',
          subject: d.id,
          detail: `input '${rid}' does not resolve`,
        });
      }
    }
  }

  // TRACE-2 -- derived discipline
  for (const d of derived.values()) {
    if (!d.inputs || d.inputs.length === 0) {
      findings.push({
        rule: 'TRACE-2',
        subject: d.id,
        detail: 'derived figure without inputs[]',
      });
    }
    if (!(d.why_not_published ?? '').trim()) {
      findings.push({
        rule: 'TRACE-2',
        subject: d.id,
        detail: 'derived figure without why_not_published',
      });
    }
  }

  // TRACE-3 -- derived shadowing a published label
  const figLabels = new Map<string, string>();
  for (const f of figures.values()) {
    figLabels.set(f.label.trim().toLowerCase(), f.id);
  }
  for (const d of derived.values()) {
    const key = d.label.trim().toLowerCase();
    const figId = figLabels.get(key);
    if (figId !== undefined && !(d.why_not_published ?? '').includes(figId)) {
      findings.push({
        rule: 'TRACE-3',
        subject: d.id,
        detail: `shadows published figure ${figId} without naming it in why_not_published`,
      });
    }
  }

  // CAVEAT-1 -- blocking caveats travel to every quotation site, and a
  // blocking caveat that IS declared rendered must actually carry text to
  // render (an empty/missing registry entry passes the "is it declared"
  // check but vanishes silently at render -- see render-report.ts's
  // renderCaveats, which now renders a visible marker for exactly this
  // case). Shared blocks are quotation sites in their own right (see
  // `SharedBlock` above), checked the same way as an ordinary Section.
  const checkCaveatSite = (subjectId: string, quoted: Iterable<string>, rendered: Set<string>): void => {
    for (const rid of [...quoted].sort()) {
      const f = allFigs.get(rid);
      if (!f) continue;
      for (const cav of f.caveats ?? []) {
        const entry = registry[cav];
        if (entry?.severity !== BLOCKING) continue;
        if (!rendered.has(cav)) {
          findings.push({
            rule: 'CAVEAT-1',
            subject: subjectId,
            detail: `quotes ${rid} without its blocking caveat '${cav}'`,
          });
        } else if (!(entry.text ?? '').trim()) {
          findings.push({
            rule: 'CAVEAT-1',
            subject: subjectId,
            detail: `quotes ${rid} whose blocking caveat '${cav}' has no text to render`,
          });
        }
      }
    }
  };
  for (const s of sections) {
    checkCaveatSite(s.id, quotedIds(s.figure_refs, s.claim_refs, claims), new Set<string>(s.caveats_rendered ?? []));
  }
  for (const [ref, block] of Object.entries(sharedBlocks)) {
    checkCaveatSite(
      `shared_blocks.${ref}`,
      quotedIds(block.figure_refs, block.claim_refs, claims),
      new Set<string>(block.caveats_rendered ?? []),
    );
  }

  // Per-claim rules
  for (const c of claims.values()) {
    const kind = c.kind;

    if (kind && POP_KINDS.has(kind)) {
      const pr = c.population_ref;
      const pop = pr ? allFigs.get(pr)?.population : undefined;
      if (!pop) {
        findings.push({
          rule: 'POP-1',
          subject: c.id,
          detail: `${kind} claim without a resolvable population`,
        });
      } else if (!pop.complete) {
        findings.push({ rule: 'POP-1', subject: c.id, detail: 'population is not complete' });
      } else {
        const chk = c.check;
        if (!chk) {
          findings.push({
            rule: 'POP-2',
            subject: c.id,
            detail: `no machine-checkable check on a ${kind} claim`,
          });
        } else {
          const { ok, why } = evalCheck(chk, pop.members ?? [], allFigs);
          if (!ok) findings.push({ rule: 'POP-2', subject: c.id, detail: why });
        }
      }
    }

    if (kind === 'causal') {
      if (!(c.mechanism ?? '').trim()) {
        findings.push({
          rule: 'CAUSE-1',
          subject: c.id,
          detail: 'causal claim without a mechanism',
        });
      }
      if (!c.tested_alternatives || c.tested_alternatives.length === 0) {
        findings.push({
          rule: 'CAUSE-1',
          subject: c.id,
          detail: 'causal claim without tested_alternatives',
        });
      }
    } else {
      const m = CAUSAL_LANG.exec(c.text ?? '');
      if (m) {
        findings.push({
          rule: 'CAUSE-2',
          subject: c.id,
          detail: `non-causal claim uses causal language: '${m[0]}'`,
        });
      }
    }

    const refs = (c.figure_refs ?? [])
      .map((r) => allFigs.get(r))
      .filter((f): f is FigureCommon => f !== undefined);
    const cb = c.comparison_basis;
    if (cb) {
      for (const f of refs) {
        if (f.basis !== cb) {
          findings.push({
            rule: 'COMP-1',
            subject: c.id,
            detail: `claim compares on basis '${cb}' but ${f.id} carries basis '${f.basis}'`,
          });
        }
      }
    } else if (kind === 'comparison') {
      const bases = new Set(refs.map((f) => f.basis));
      if (bases.size > 1) {
        const sortedBases = [...bases].map((b) => String(b)).sort();
        findings.push({
          rule: 'COMP-1',
          subject: c.id,
          detail: `comparison mixes bases: [${sortedBases.map((b) => `'${b}'`).join(', ')}]`,
        });
      }
    }
  }

  // UNIT-1 -- item_days never renders as plain days. Shared blocks own
  // their own display_text (a pointer section's is ignored at render), so
  // they get the same check.
  const checkUnitSite = (subjectId: string, quoted: Iterable<string>, text: string | undefined): void => {
    if (!text) return;
    const quotedArr = [...quoted];
    const hasItemDays = quotedArr.some((r) => allFigs.get(r)?.unit === 'item_days');
    if (hasItemDays && DAYS_TEXT.test(text) && !text.toLowerCase().includes('item-day')) {
      findings.push({
        rule: 'UNIT-1',
        subject: subjectId,
        detail: 'renders an item_days figure as plain days',
      });
    }
  };
  for (const s of sections) {
    checkUnitSite(s.id, quotedIds(s.figure_refs, s.claim_refs, claims), s.display_text);
  }
  for (const [ref, block] of Object.entries(sharedBlocks)) {
    checkUnitSite(
      `shared_blocks.${ref}`,
      quotedIds(block.figure_refs, block.claim_refs, claims),
      block.display_text,
    );
  }

  return findings;
}
