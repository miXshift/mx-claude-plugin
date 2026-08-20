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
 *   UNIT-2    a figure's unit must not contradict the served unit contract its
 *             source_path resolved to, and a percent-family figure may not
 *             claim an implausible magnitude
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

/**
 * UNIT-2's percent family, mapped to the factor that turns a STORED value into
 * the percentage the reader sees. `ratio` and `points_fraction` store a
 * fraction and are displayed ×100; `percent` / `points` / `percent-points` /
 * `pts` are already whole. Every one of these tokens is handled by
 * render-report.ts's `formatFigureValue`; the scales here mirror it exactly,
 * because the backstop below is a statement about the DISPLAYED number.
 */
const PERCENT_FAMILY_SCALE: Record<string, number> = {
  ratio: 100,
  points_fraction: 100,
  percent: 1,
  points: 1,
  'percent-points': 1,
  pts: 1,
};

/**
 * The percent-family plausibility ceiling, in DISPLAYED percent.
 *
 * Deliberately loose. This is not a business rule about what a rate may be --
 * it is a scale-error detector, and the error it detects is an order of
 * magnitude off, not a few points: a fraction-scaled value (0.35) mislabeled
 * as an already-whole `percent`, or the far more common inverse, a whole
 * number (35) labeled `ratio` and therefore displayed as 3500%. Anything that
 * survives 1000% is a number nobody could mistake for a rate.
 *
 * ⚠ It is not free of false positives, and the real classes are worth naming:
 * ACOS and TACoS are genuine rates that pass 1000% on an account with
 * near-zero sales against live spend (spend 12× sales is ACOS 1200%), entity
 * rows hit it far more often than totals do (one SD campaign type at 1200%
 * ACOS stores 12.0 under `ratio`), and a hand-authored period-over-period
 * CHANGE above 1000% is ordinary on a relaunched line or a brand's first ad
 * month. Those are real readings, not scale errors.
 *
 * So this backstop is a WARNING, never an error. An earlier draft of this
 * comment claimed such a figure "surfaces as a finding to be dismissed by a
 * human"; that was false. `report render` refuses on ANY finding and the only
 * override is a document-wide `--force`, which also waives BASIS-1 / TRACE-1 /
 * CAVEAT-1 -- so a false positive on a correct figure was a choice between not
 * shipping and shipping past the blocking-caveat gate. There is no
 * per-finding waiver to reach for, which is exactly why this one must not
 * block on its own.
 *
 * It is also why this is the ONLY warning-severity check in UNIT-2: it is the
 * one arm that fires with no served contract behind it, which the engine
 * author asked us not to fail on ("never fail on an absent served contract --
 * only on present-and-disagreeing"). Arm (a), where the engine has actually
 * told us the unit and the document disagrees, stays an error.
 */
const PERCENT_IMPLAUSIBLE_LIMIT = 1000;

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
  | 'UNIT-1'
  | 'UNIT-2';

/**
 * `error` bars the render door; `warning` is reported and does not. Absent
 * means `error`, so every rule that predates this field keeps blocking exactly
 * as it did -- only a check that explicitly opts into `warning` is advisory.
 *
 * Reach for `warning` only where a finding can be RIGHT about the document and
 * still be wrong about the world: a heuristic with a real false-positive class
 * and no served contract behind it. Anything the engine or the contract can
 * actually settle is an error.
 */
export type FindingSeverity = 'error' | 'warning';

export interface Finding {
  rule: RuleId;
  subject: string;
  detail: string;
  severity?: FindingSeverity;
}

/** Findings that bar the render door. */
export function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => (f.severity ?? 'error') === 'error');
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
  /** The unit the ANALYSIS ENGINE's served contract assigns to the envelope
   *  path this figure was extracted from -- `metrics[].format` /
   *  `insights[].format` (engine >= 0.2.0) or `crossDomain.pairFormats`
   *  (>= 0.3.0), resolved in extract.ts where the envelope is in hand and
   *  stamped onto the figure so it survives document assembly. Absent
   *  whenever no contract was served (a pre-0.2.0 envelope, a hand-authored
   *  figure, a Derived), and UNIT-2 never fires on an absent one.
   *
   *  It duplicates `unit` at the moment of extraction, which is the point:
   *  `unit` is the mutable field a downstream assembly pass may rewrite,
   *  `served_unit` is what the engine asserted, and UNIT-2 is the check that
   *  the two still agree by the time the document reaches the render seam. */
  served_unit?: string;
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
): { count: number; nonNumeric?: PopulationMember; nonNumericThreshold?: boolean } {
  const { member_key: memberKey, op, value } = pred;
  const numericOp = NUMERIC_OPS.has(op);
  // The predicate's own threshold gets the same fail-closed discipline as
  // member values: a formatted-string threshold ('1,200') coerces to NaN in
  // JS, making EVERY comparison false and certifying a false none/count
  // claim clean, where the Python source raises TypeError.
  if (numericOp && !isFiniteNumber(value)) {
    return { count: 0, nonNumericThreshold: true };
  }
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
    const { count: n, nonNumeric, nonNumericThreshold } = countPred(members, chk.predicate);
    if (nonNumericThreshold) {
      return {
        ok: false,
        why: `predicate value for '${chk.predicate.member_key}' (${chk.predicate.op}) is non-numeric`,
      };
    }
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
    const { count: n, nonNumeric, nonNumericThreshold } = countPred(members, chk.predicate);
    if (nonNumericThreshold) {
      return {
        ok: false,
        why: `predicate value for '${chk.predicate.member_key}' (${chk.predicate.op}) is non-numeric`,
      };
    }
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
/**
 * The served unit contract, keyed by FIGURE ID, as `report extract` resolved it
 * off the envelope.
 *
 * ⚠ Why this is a parameter and not just read off the figure. `report extract`
 * stamps `served_unit` on each figure it emits, but the document that reaches
 * `validateReportData` is not that file: SKILL.md Step 5 has the MODEL compose
 * report-data.json by hand from the extracted figures, and the worked examples
 * it copies from carry no `served_unit`. So in the real pipeline the field
 * simply never arrives, and a UNIT-2 arm that only reads the figure is a no-op
 * exactly where a hand-written unit is most likely to be wrong -- which is the
 * whole reason the rule exists.
 *
 * Passing the extractor's own output alongside the document closes that: the
 * check no longer depends on a model copying a field it was never shown.
 * Keyed by figure ID rather than `source_path` deliberately -- ids ARE
 * period-prefixed (`mom.` / `yoy.`) and source paths are not, so a
 * source_path-keyed map collides last-wins across a merged document.
 */
export interface ServedContractIndex {
  /** figure id -> the unit the engine served for it */
  units?: Record<string, string>;
  /** figure id -> which file that unit came from, so a finding can name it.
   *  Without this the refusal points the operator at report-data.json, which
   *  does not contain the contradicting value anywhere they can see it. */
  origin?: Record<string, string>;
  /**
   * Figures whose served contract was RETIRED as untrustworthy (two sources
   * disagreed about them). Arm (a) must go fully silent for these.
   *
   * ⚠ Retiring the index entry alone does not do that: the check falls back to
   * the figure's OWN `served_unit`, which the model copied, so the run prints
   * "the served-unit check is skipped for it" and then blocks the render on
   * exactly that figure anyway. Silence has to be explicit.
   */
  suppressed?: string[];
  /** `--no-figures`: skip the served-contract arm outright, including any
   *  stamp carried on the figure itself. The flag says skip; it must skip. */
  suppressAll?: boolean;
}

export function validateReportData(
  doc: ReportDataDocument,
  served?: ServedContractIndex,
): Finding[] {
  const findings: Finding[] = [];
  const servedUnits = served?.units ?? {};
  const servedOrigin = served?.origin ?? {};
  const servedSuppressed = new Set(served?.suppressed ?? []);
  const servedSuppressAll = served?.suppressAll === true;

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

  // UNIT-2 -- a unit must describe the value it labels.
  //
  // THE HOLE THIS CLOSES. Every rule above checks a RELATIONSHIP: claims
  // against figures, bases against each other, caveats against quotation
  // sites. Not one of them ever asked whether a figure's `unit` is the right
  // unit for that figure's `value`, so a dollar amount labeled 'percent'
  // satisfied all of them and shipped -- twice, in the same quarter. A unit
  // error is only visible in rendered output, and by then nothing is checking.
  //
  // Two independent predicates, both scoped to what can be decided from the
  // document alone:
  //
  //  (a) CONTRADICTS THE SERVED CONTRACT. When `served_unit` is present, the
  //      analysis engine asserted this figure's unit (see `served_unit`), and
  //      `unit` disagreeing means something rewrote it after extraction. This
  //      NEVER fires when no contract was served -- a pre-0.2.0 envelope, a
  //      hand-authored figure, a Derived. Version skew must not manufacture
  //      findings: the rule fails only where a contract EXISTS and disagrees.
  //
  //  (b) IMPLAUSIBLE PERCENT MAGNITUDE. A cheap backstop that needs no served
  //      contract at all, so it still covers the unserved figures (a) cannot
  //      reach. See PERCENT_IMPLAUSIBLE_LIMIT.
  //
  // Per FIGURE, not per quotation site (unlike UNIT-1): this is a property of
  // the figure itself, wrong whether or not anyone quotes it. Derived objects
  // are walked too -- they carry units and are exactly where a recompute can
  // change scale without changing the label.
  for (const f of allFigs.values()) {
    const unit = f.unit;
    // ⚠ The INDEX wins over the figure's own stamp. Both claim to be the
    // engine speaking, but only one of them is: the index is `report extract`
    // output read off disk, while `served_unit` on the figure was copied there
    // by the model composing report-data.json. A model that relabels a unit
    // and "helpfully" makes served_unit agree with it produces a figure that
    // is self-consistent and silently wrong -- which is the failure this rule
    // exists to catch, so the copy cannot be allowed to shadow the original.
    // ⚠ `suppressAll` retires the INDEX, not the document's own stamp.
    // `--no-figures` says to ignore figures FILES; a `served_unit` sitting on
    // the figure is not a file, it is a self-contradiction inside the document
    // (`unit: 'count'` against its own `served_unit: 'currency'`), and no
    // sidecar has to exist for it to be wrong. Waiving that too made the
    // render refusal's own advice self-defeating: it offers "remove it or pass
    // --no-figures" as equivalents, and they returned OPPOSITE verdicts on the
    // same document -- with the safer-sounding branch being the one that
    // shipped the mislabeled figure.
    //
    // `suppressed` is different and does cover both: there the evidence was
    // judged untrustworthy for that specific figure, and the run has already
    // printed "the check is skipped for it", so blocking on it anyway would
    // contradict the line it just wrote.
    const indexUnit = servedSuppressAll ? undefined : servedUnits[f.id];
    const servedUnit = servedSuppressed.has(f.id) ? undefined : (indexUnit ?? f.served_unit);
    if (servedUnit !== undefined && servedUnit !== '' && unit !== servedUnit) {
      const from = servedOrigin[f.id];
      findings.push({
        rule: 'UNIT-2',
        subject: f.id,
        detail:
          `unit '${unit ?? ''}' contradicts the served contract '${servedUnit}'` +
          (from ? ` (served by ${from})` : ''),
      });
    }
    const scale = unit !== undefined ? PERCENT_FAMILY_SCALE[unit] : undefined;
    if (scale !== undefined && isFiniteNumber(f.value)) {
      const displayed = Math.abs(f.value) * scale;
      if (displayed > PERCENT_IMPLAUSIBLE_LIMIT) {
        findings.push({
          rule: 'UNIT-2',
          subject: f.id,
          // WARNING, not error -- see PERCENT_IMPLAUSIBLE_LIMIT. A 1200% ACOS
          // on a near-zero-sales entity row is a real reading, and this arm
          // has no served contract behind it to settle the question.
          severity: 'warning',
          detail: `unit '${unit}' renders ${f.value} as ${displayed.toFixed(1)}%, past the ${PERCENT_IMPLAUSIBLE_LIMIT}% plausibility ceiling — check for a ratio/percent scale error`,
        });
      }
    }
  }

  return findings;
}
