/**
 * report-contract/extract.ts -- TypeScript port of the report-contract
 * executable spec (`extract_figures.py`, upstream MixShift bridge
 * methodology). Same figure-id namespacing, same fixture semantics -- this
 * is the deterministic envelope-to-figures extractor the smart-tier monthly
 * report skill runs an /api/insights response through so the model never
 * reads raw envelope JSON directly.
 *
 * Input: one /api/insights response ({envelope, crossDomain?, evidence?})
 * or a bare envelope. Works for ops AND ads domains; call once per response.
 *
 * Figure ids are namespaced by domain: ops.<metric>.{p1,p2,delta},
 * ops.bridge.<variant>.<component>, ads.<metric>.*, duo.tacos.*,
 * <domain>.entity.<key>.*, <domain>.entity.<key>.bridge.<metric>.<variant>.<component>.
 * That is the complete, unprefixed shape a single-response (no `selection`)
 * extraction emits -- exactly as the upstream Python extractor does, which
 * is the cross-implementation parity this path must never break.
 *
 * ── UNITS COME FROM THE ENGINE NOW ──────────────────────────────────────
 * The analysis engine SERVES its own unit and severity contract, and those
 * served values are authoritative. Read `envelope.engineVersion` (never
 * `meta.engineSha`, which identifies a build, not a contract) and gate:
 *   >= 0.2.0  `metrics[].format` and `insights[].format`
 *             ({display, decimals, deltaUnit, direction}, lifted verbatim
 *             from the engine's METRIC_DEFINITIONS), and `caveats[].severity`
 *             (blocking | disclosure | context), computed server-side.
 *   >= 0.3.0  `crossDomain.pairFormats` -- the unit contract for every served
 *             crossDomain pair, dotted-keyed ('ops.revenue', 'ads.spend',
 *             'tacos', 'tacosDecomposition', 'aspVsAdAov.asp', ...).
 * Older engines simply omit them, so the local tables below survive as an
 * explicit PRE-0.2.0 FALLBACK and nothing else. Two rules are load-bearing:
 *   - An ABSENT served `format` on a >= 0.2.0 envelope means "this build
 *     cannot format this metric", NEVER "count". The engine states that in
 *     `metricFormatFor`'s own comment, and it is precisely the consumer-side
 *     defect the field exists to kill: our `?? 'count'` fallback is how
 *     ad-attributed DOLLARS rendered as bare numbers. On the served path an
 *     absent format yields `CANNOT_FORMAT`, which the renderer prints WITH a
 *     visible token rather than as a naked figure.
 *   - A served `severity` is used VERBATIM. Severity is the engine's
 *     judgment, and it can be RUN-DEPENDENT -- `lost_sales_regime_guard` is
 *     `blocking` when the guard only DETECTED a suspect reference (the
 *     suspect number is still in the totals, so neither the row nor the
 *     lost-sales total may be quoted bare) and `disclosure` when it was
 *     APPLIED (the number was corrected). No consumer-side kind-to-severity
 *     table can express that, which is the whole argument for retiring ours.
 * If a served unit is ever wrong, file it upstream -- do not patch around it
 * here.
 *
 * ⚠ THAT PARITY IS ABOUT SHAPE -- figure ids, source paths, values, and
 * which figures get emitted -- NOT about every field's contents. Four unit
 * LABELS deliberately diverge from `extract_figures.py` ON THE PRE-0.2.0
 * FALLBACK PATH, because the Python source labels them wrongly and a report
 * that prints "22448.2%" for $22.4K is worse than a temporary fork. All four
 * are the same defect -- a unit that does not describe the value stored --
 * and all four are settled against the engine's own registry
 * (`METRIC_DEFINITIONS`) and formatters, i.e. they are the served contract
 * hand-copied. On a served envelope they are moot: the engine answers
 * directly.
 *   (1) a bridge leg takes its unit from the ANCHOR metric, not from
 *       `component.valueUnit`;
 *   (2) `duo.*.delta_pts` is `points_fraction`, not `points`;
 *   (3) a RATE metric's own delta (`<domain>.<metric>.delta`, and an entity
 *       insight's `netChange`) is `points_fraction`, not the level's `ratio`
 *       -- the engine declares `deltaUnit: 'pts'` for every such metric;
 *   (4) `duo.asp` / `duo.adAov` are `ops_per_unit` / `ad_aov` and carry those
 *       metrics' `currency-2dp`, not a hardcoded 0dp `currency`.
 * All are ported upstream on the next parity pass; until then a diff on those
 * fields is EXPECTED and is not a regression here.
 *
 * A composite selection (`selection` set -- see COMPOSITE_SELECTIONS) instead
 * prepends the selection's period to every id: mom.ops.ops.p1, yoy.ops.ops.p1,
 * mom.ads.ad_spend.p1. It has to: the skill composes every selection's
 * figures document into one report (SKILL.md Step 2), and `mom.ops` /
 * `yoy.ops` otherwise extract the identical `ops.ops.p1` from two different
 * envelopes, so a merged document would silently resolve a MoM figure_ref to
 * the YoY value. See `extractFigures`'s prefixing step and `checkFigures`'s
 * SKU-SPLIT block (the one invariant that has to recover the prefix rather
 * than read it off id shape).
 *
 * The input document is untrusted JSON assembled upstream by a live
 * service, so every field is read defensively (mirrors validate.ts's own
 * `.get(...)`-style permissiveness for the same reason: an extractor that
 * throws on a slightly-off envelope defeats its own purpose). The Python
 * source reads a handful of fields via direct dict indexing (`m['metricKey']`,
 * `comp['key']`) that would raise on a genuinely malformed envelope; those
 * are modeled here as required-but-possibly-`undefined` reads (no throw) --
 * the one deliberate behavioral delta from the Python source, called out
 * because --check will still catch the resulting empty/missing figure.
 */

import type { Figure, Population, PopulationMember, CaveatRegistryEntry } from './validate.js';

const TOL = 0.011; // cent-level float tolerance on currency identities

// ---------------------------------------------------------------------------
// PRE-0.2.0 FALLBACK ONLY. Not the authority any more.
//
// These two tables are a hand-copy of the engine's metric registry, and the
// engine now publishes that registry directly as `metrics[].format` /
// `insights[].format` (>= 0.2.0). On any envelope that serves a format, the
// served value wins and NOTHING below is consulted. They survive solely so a
// pre-0.2.0 envelope still extracts with the units it extracted with before,
// and they are frozen at that job: a NEW metric key does not belong here, it
// belongs in the engine registry, where it is served to every consumer at
// once. See `resolveLevelUnit` / `resolveChangeUnit` for the gate.
//
// The tables' own defect is exactly why they are being retired: a key missing
// here falls back to 'count', so `ad_driven_sales` -- dollars -- rendered as a
// bare number until someone noticed. A served format cannot go stale that way,
// and its ABSENCE means "cannot format", never "count".
//
// Two conventions to keep straight while reading this:
//   - our `ratio` means a stored FRACTION rendered ×100 with a "%" affix,
//     which is exactly the engine's `percent`. These agree; they are not a
//     defect. (Our `percent` means an ALREADY-WHOLE number — never the right
//     mapping for an engine `percent` metric.)
//   - our `count` is a whole bare number, i.e. the engine's `number`.
// ---------------------------------------------------------------------------
const OPS_UNITS: Record<string, string> = {
  ops: 'currency',
  units: 'count',
  sessions: 'count',
  conversion: 'ratio',
  buy_box: 'ratio',
  // engine: display 'currency-2dp', decimals 2. This is ASP ($/unit), where
  // the cents ARE the signal; rendering it at 0dp dropped them.
  ops_per_unit: 'currency-2dp',
  sellable_inventory: 'count',
  weeks_of_cover: 'weeks',
  lost_sales: 'currency',
  glance_views: 'count',
  gv_conversion: 'ratio',
  // The ops-grid ad-attribution fold. Present in the engine's
  // OPS_FAMILY_METRICS but absent here, so all three fell back to 'count' --
  // two dollar metrics and a rate rendering as bare counts.
  ad_driven_sales: 'currency',
  ad_driven_share: 'ratio',
  ad_driven_halo: 'currency',
};
const ADS_UNITS: Record<string, string> = {
  ad_spend: 'currency',
  ad_sales: 'currency',
  acos: 'ratio',
  // engine: display 'currency-2dp' ("ad sales generated per $1 of spend --
  // displayed as currency ($2.06), matching the ASP ($/unit) convention").
  // As 'ratio' a 2.06x ROAS rendered "206.0%", which ROAS never is.
  roas: 'currency-2dp',
  ad_impressions: 'count',
  ad_clicks: 'count',
  ad_ctr: 'ratio',
  ad_orders: 'count',
  // engine: display 'currency-2dp', decimals 2 -- per-click/per-order money,
  // sub-dollar in normal operation, so 0dp rounded it to nothing.
  ad_cpa: 'currency-2dp',
  ad_aov: 'currency-2dp',
  ad_cpc: 'currency-2dp',
  ad_conversion: 'ratio',
  ad_sales_same_sku: 'currency',
  ad_sales_other_sku: 'currency',
  ad_sales_view_through: 'currency',
  ad_orders_same_sku: 'count',
  ad_orders_other_sku: 'count',
  ad_orders_view_through: 'count',
};
// Post SD-fix basis table (documented in the skills; catalog-owned eventually).
const ADS_BASIS: Record<string, string> = {
  ad_sales_same_sku: 'click_attributed',
  ad_orders_same_sku: 'click_attributed',
  ad_sales_other_sku: 'click_attributed',
  ad_orders_other_sku: 'click_attributed',
  ad_sales_view_through: 'view_through',
  ad_orders_view_through: 'view_through',
};
const ADS_BASIS_DEFAULT = 'console_authoritative';

/** The cross-domain ASP ⇄ ad-AOV mirror is not its own pair of measures: the
 *  engine assembles it from two metrics it already publishes --
 *  `aspVsAdAov: { asp: pair(ops, 'ops_per_unit'), adAov: pair(ads, 'ad_aov') }`
 *  -- so each lane is READ THROUGH the same map its own domain figures use and
 *  can never drift from them. Both resolve to 'currency-2dp' today. */
const AV_LANE_UNITS: Record<'asp' | 'adAov', string> = {
  asp: OPS_UNITS.ops_per_unit,
  adAov: ADS_UNITS.ad_aov,
};

// ---------------------------------------------------------------------------
// A CHANGE figure carries the CHANGE unit; a BRIDGE LEG carries the ANCHOR's.
//
// Two applications of one rule, both below. (a) A metric's own delta figure is
// a CHANGE, so for a rate metric it is denominated in POINTS, not in the rate.
// (b) A leg figure stores a contribution to that same change, so it takes the
// anchor's change unit and never the lever's own level unit. They have to
// agree: the legs sum to the delta, so the two can never be read apart.
//
// A leg figure stores `component.impact` -- the leg's contribution to the
// ANCHOR metric's net change -- and NOT the lever's own before/after level.
// So the unit that describes the stored value is the anchor's, not
// `component.valueUnit`. Three independent lines of evidence, all pointing
// the same way:
//
//   1. ENGINE. `component.valueUnit` is typed `HorizontalBridgeValueUnit` and
//      is used by the engine ONLY to format the leg's own levels --
//      `compactMagByUnit(c.p1Value, c.valueUnit)` in bridge-visual-model.ts's
//      `miniForComponent`. The engine formats the leg's IMPACT through the
//      root metric instead: `impactFormatted: compactSigned(rootMetric,
//      c.impact)`, on the very same object ("every edge/impact is in the ROOT
//      metric's native contribution frame"). valueUnit describes the numbers
//      we do not emit.
//   2. OUR OWN CONTRACT. `checkFigures`'s BRIDGE-FOOTING invariant asserts
//      Σ(legs) == net_change, and net_change is the ANCHOR metric's delta.
//      Numbers that sum to each other are in the same unit, so a leg is in
//      the anchor's delta unit by an invariant this file already enforces.
//   3. ARITHMETIC, on this repo's own envelope fixture. The ops bridge's legs
//      are 20000 + 15000 + 9000 = 44000, exactly the ops delta -- DOLLARS --
//      while the conversion leg's `valueUnit` is 'percent'. Passing valueUnit
//      through labeled $15,000 as a percentage, and the renderer printed
//      "15000.0%". The conversion bridge is the mirror case: legs 0.03 + 0.02
//      = 0.05 = the conversion delta, i.e. FRACTIONS of a rate, both labeled
//      'number' -- printed as "0" at 0dp, erasing a three-point contribution.
//
// A rate anchor's delta is NOT its level unit. Every engine metric whose
// `display` is 'percent' also declares `deltaUnit: 'pts'`, and `formatDelta`
// renders that branch as value x 100 with a " pts" affix -- a stored FRACTION
// of a point, which is exactly our `points_fraction`. Every 'ratio' entry in
// the maps above is an engine 'percent' metric (conversion, buy_box,
// gv_conversion, ad_driven_share, acos, ad_ctr, ad_conversion) and no
// non-'ratio' entry is, so the mapping below is total. Every other unit is
// `deltaUnit: 'absolute'` -- delta in the level's own unit -- and passes
// through untouched.
//
// This is not a new convention in this file: the cross-domain TACOS legs
// below have always been labeled from their anchor (`points_fraction`, the
// TACOS rate) while their components' own `valueUnit`s say 'currency-2dp' /
// 'percent'. This makes the envelope bridge legs follow the same rule.
//
// ...and so does the metric's OWN delta figure, at total and entity scope.
// `metrics[].totals.delta` and an entity insight's `netChange` are both the
// change itself, and the engine's `formatDelta` sends a deltaUnit:'pts' metric
// down `numWithDecimals(abs * 100, dp) + ' pts'` -- it never renders a rate
// change as a rate. Labeling those figures with the LEVEL unit made a
// five-POINT conversion move (20% -> 25%, stored 0.05) print "5.0%", which
// reads as a 5% relative rise, and left a net printing "5.0%" directly beneath
// the legs -- correctly labeled by the rule above -- that footed to it as
// "3.0 pts" and "2.0 pts". Numbers that sum to each other now share a unit
// wherever this file emits them.
// ---------------------------------------------------------------------------

/** PRE-0.2.0 FALLBACK. The unit a metric's CHANGE carries, given its level
 *  unit -- for the delta figure itself and for every leg that foots to it.
 *  Identity except for rate metrics, whose change is in points, stored as a
 *  fraction. The served contract states this directly as `deltaUnit`; this is
 *  the inference we had to make before it did. */
function changeUnitOf(levelUnit: string): string {
  return levelUnit === 'ratio' ? 'points_fraction' : levelUnit;
}

// ---------------------------------------------------------------------------
// THE SERVED UNIT CONTRACT (engine >= 0.2.0 / >= 0.3.0) -- the authority.
// ---------------------------------------------------------------------------

/** `metrics[].format` / `insights[].format` / a `crossDomain.pairFormats`
 *  entry. The engine's `EnvelopeMetricFormat` / `CrossDomainPairFormat`, read
 *  defensively: this arrives inside the same untrusted JSON as everything
 *  else, so every field is validated before it is trusted rather than cast. */
interface ServedFormat {
  /** Engine `DisplayUnit`: currency | currency-2dp | number | percent |
   *  percent-points. How a LEVEL renders. */
  display: string;
  /** Digits after the decimal point that display carries. */
  decimals?: number;
  /** How a CHANGE reads: 'absolute' in the metric's own unit, 'pts' in
   *  percentage points (every rate metric). */
  deltaUnit?: string;
}

/** A resolved unit, plus whatever else the served contract determines about
 *  how the figure prints. `served` marks the unit as ENGINE-ASSERTED, which is
 *  what lets the figure carry `served_unit` for UNIT-2 to check against. */
interface UnitSpec {
  unit: string;
  precision?: number;
  served?: boolean;
}

type SemVer = readonly [number, number, number];

/** `metrics[].format`, `insights[].format`, `caveats[].severity`. */
const SERVED_FORMAT_MIN: SemVer = [0, 2, 0];
/** `crossDomain.pairFormats`. */
const SERVED_PAIR_FORMATS_MIN: SemVer = [0, 3, 0];

/** Engine `DisplayUnit` -> our renderer's LEVEL token. The engine's `percent`
 *  stores a FRACTION rendered ×100 with a "%" affix, which is our `ratio`
 *  exactly -- our own `percent` (an already-whole number) is never the right
 *  mapping for it. An unmapped display is NOT coerced: the engine's token is
 *  passed through verbatim, so a DisplayUnit member added upstream renders
 *  through the renderer's unknown-unit fallback (number + visible token) and
 *  is reportable, instead of being quietly rounded into one of ours. */
const DISPLAY_UNIT: Record<string, string> = {
  currency: 'currency',
  'currency-2dp': 'currency-2dp',
  number: 'number',
  percent: 'ratio',
  'percent-points': 'percent-points',
};

/** The unit a figure carries when the engine SERVES a contract but has no
 *  entry for this figure -- version skew, i.e. the sidecar was written by a
 *  newer engine than the one that built the envelope. It is deliberately NOT
 *  a unit: the renderer's unknown-unit fallback prints the number with this
 *  token attached, so a reader sees "we do not know how to label this" rather
 *  than a bare number they will read as a count. Never emitted on the
 *  pre-0.2.0 fallback path, where absence genuinely means "old engine". */
const CANNOT_FORMAT = 'unformattable';

/** `envelope.engineVersion` -> [major, minor, patch], or null when absent or
 *  unparseable (both mean "assume pre-0.2.0" -- the fallback path).
 *
 *  Reads ONLY `envelope.engineVersion`. `meta.engineSha` identifies a build,
 *  not a contract, and is never a version gate.
 *
 *  A prerelease/build suffix ('0.3.0-rc.1') is ignored, so an rc satisfies its
 *  own release's gate. That is the safe direction: an rc of 0.3.0 does serve
 *  pairFormats, and the alternative would fall back on a build that has the
 *  contract. */
function parseEngineVersion(raw: unknown): SemVer | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(raw));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function engineAtLeast(v: SemVer | null, min: SemVer): boolean {
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Which served blocks this envelope actually carries, decided once per
 *  extraction and threaded down rather than re-derived per figure. */
interface ServedContract {
  /** engine >= 0.2.0: metrics[]/insights[] carry `format`. When true, an
   *  ABSENT format means CANNOT_FORMAT and the local tables are not consulted
   *  at all. */
  formats: boolean;
  /** The `crossDomain.pairFormats` block, present only when the engine is
   *  >= 0.3.0 AND the block is actually there. */
  pairFormats: Rec | undefined;
}

function servedContractOf(env: Rec, crossDomain: Rec | undefined): ServedContract {
  const version = parseEngineVersion(env.engineVersion);
  const pf = engineAtLeast(version, SERVED_PAIR_FORMATS_MIN)
    ? asRecord(crossDomain?.pairFormats)
    : undefined;
  return { formats: engineAtLeast(version, SERVED_FORMAT_MIN), pairFormats: pf };
}

/** Validate one served format object. A block missing a usable `display` is
 *  treated as ABSENT rather than partially trusted -- same rule, same reason:
 *  we would otherwise be inventing the half we could not read. */
function readServedFormat(v: unknown): ServedFormat | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  if (typeof r.display !== 'string' || r.display === '') return undefined;
  const out: ServedFormat = { display: r.display };
  // Range-checked, not just sign-checked. `decimals` lands in the renderer's
  // toFixed / toLocaleString calls, both of which THROW a RangeError outside
  // their fraction-digit domain -- and a throw there kills the whole render
  // and writes no HTML at all, which is the one thing a malformed document is
  // never allowed to do. 20 is the domain every JS engine supports (newer V8
  // allows 100); no real served format exceeds 2, so the ceiling only ever
  // catches garbage.
  // Integer-checked BEFORE any truncation, and for the same reason
  // render-report.ts's `sanePrecision` is: `Math.trunc(-0.5)` is `-0`, which
  // passes a `>= 0` gate, so a fractional decimals would silently become 0 and
  // override the unit's own default. That was fixed in the renderer and left
  // standing here -- and THIS copy wins, because it stamps the figure's
  // `precision` in the first place.
  if (typeof r.decimals === 'number' && Number.isInteger(r.decimals)) {
    if (r.decimals >= 0 && r.decimals <= MAX_SERVED_DECIMALS) out.decimals = r.decimals;
  }
  if (typeof r.deltaUnit === 'string') out.deltaUnit = r.deltaUnit;
  return out;
}

/** Max fraction digits we will accept from a served format. See readServedFormat. */
const MAX_SERVED_DECIMALS = 20;

/** Read a `format` off a metric summary or an insight entry. The engine puts
 *  it on both; on an insight it can sit on the entry or on its nested
 *  `insight` object depending on which shape the caller unwrapped. */
function formatOf(...candidates: unknown[]): ServedFormat | undefined {
  for (const c of candidates) {
    const f = readServedFormat(c);
    if (f) return f;
  }
  return undefined;
}

/** `decimals` -> the figure's `precision`. Carried through because the served
 *  contract's precision is part of the same answer as its unit: `weeks_of_cover`
 *  is display 'number' with decimals 1, and dropping the 1 would print "12"
 *  where the fallback path prints "12.4". */
function specOf(unit: string, fmt: ServedFormat): UnitSpec {
  const spec: UnitSpec = { unit, served: true };
  if (fmt.decimals !== undefined) spec.precision = fmt.decimals;
  return spec;
}

/** The LEVEL unit (a p1/p2 figure). Served contract wins; on a served
 *  envelope an absent format is CANNOT_FORMAT, never 'count'. */
function resolveLevelUnit(
  served: ServedContract,
  fmt: ServedFormat | undefined,
  metricKey: string | undefined,
  fallback: Record<string, string>,
): UnitSpec {
  if (served.formats) {
    if (!fmt) return { unit: CANNOT_FORMAT };
    return specOf(DISPLAY_UNIT[fmt.display] ?? fmt.display, fmt);
  }
  return { unit: (metricKey && fallback[metricKey]) ?? 'count' };
}

/** The CHANGE unit -- a metric's own delta, an entity's `netChange`, and
 *  every bridge leg that foots to one of those. The engine states the rule
 *  mechanically: `deltaUnit: 'pts'` means the change reads in percentage
 *  points, stored as a fraction (our `points_fraction`); `absolute` means the
 *  change is in the level's own unit. This is the same rule `changeUnitOf`
 *  encodes for the fallback path -- now read from the engine instead of
 *  inferred from our own level token. */
function resolveChangeUnit(
  served: ServedContract,
  fmt: ServedFormat | undefined,
  metricKey: string | undefined,
  fallback: Record<string, string>,
): UnitSpec {
  if (served.formats) {
    if (!fmt) return { unit: CANNOT_FORMAT };
    return servedSpec(changeTokenOf(fmt), fmt);
  }
  return { unit: changeUnitOf((metricKey && fallback[metricKey]) ?? 'count') };
}

/**
 * `specOf`, except the CANNOT_FORMAT sentinel is never presented as a served
 * contract.
 *
 * ⚠ The sentinel means "the engine did not tell us this unit". Stamping it as
 * `served_unit` says the opposite -- that the engine's answer IS
 * 'unformattable' -- and UNIT-2 arm (a) then fires against any document that
 * labels the figure correctly: `unit 'points_fraction' contradicts the served
 * contract 'unformattable'`, an ERROR, so `report render` refuses the RIGHT
 * answer. Absence of a contract must stay absence.
 */
function servedSpec(unit: string, fmt: ServedFormat): UnitSpec {
  return unit === CANNOT_FORMAT ? { unit: CANNOT_FORMAT } : specOf(unit, fmt);
}

/**
 * The change token for a served format, or CANNOT_FORMAT when `deltaUnit` is
 * unreadable AND the answer actually depends on it.
 *
 * Two things this gets right that a naive reading does not:
 *
 * 1. `deltaUnit: 'pts'` does NOT always mean `points_fraction`. It means the
 *    change reads in percentage POINTS; how that is STORED follows the level.
 *    A fraction-scaled level (`ratio`, from display 'percent') stores the
 *    change as a fraction, so points_fraction is right and the renderer's ×100
 *    lands correctly. An ALREADY-WHOLE level (`percent-points`) stores it
 *    whole -- mapping that to points_fraction multiplies it a second time and
 *    prints a 2.4-point move as "240.0 pts".
 *
 * 2. An unreadable `deltaUnit` is only ambiguous for a RATE. `changeUnitOf`
 *    is the whole truth about the fallback path and it changes exactly one
 *    token: ratio -> points_fraction. For currency, currency-2dp, number and
 *    percent-points the change unit IS the level unit whichever way deltaUnit
 *    reads, so refusing there would trade a correct render for a page full of
 *    "44000 unformattable" beside a p1/p2 that render "$1,044,000" -- a worse
 *    outcome than the defect being guarded against, and a NEW contradiction
 *    between a delta and the levels it sits next to.
 *
 * So: refuse only where the guess would be load-bearing. That is the same
 * principle readServedFormat applies to an unusable `display` -- do not invent
 * the half you could not read -- scoped to where the half actually matters.
 */
function changeTokenOf(fmt: ServedFormat): string {
  const level = DISPLAY_UNIT[fmt.display] ?? fmt.display;
  if (fmt.deltaUnit === 'pts') return level === 'ratio' ? 'points_fraction' : level;
  if (fmt.deltaUnit === 'absolute') return level;
  return level === 'ratio' ? CANNOT_FORMAT : level;
}

/** A crossDomain figure's unit, from `pairFormats[<dotted path>]`. Same two
 *  rules as the metric path: the served contract wins outright, and when the
 *  block IS served but the path is missing (skew against the engine's closed
 *  path union) that is CANNOT_FORMAT, not a guess. `fallback` is the unit
 *  this extractor used before the contract existed. */
function resolvePairUnit(
  served: ServedContract,
  path: string,
  kind: 'level' | 'change',
  fallback: string,
): UnitSpec {
  const pf = served.pairFormats;
  if (!pf) return { unit: fallback };
  const fmt = readServedFormat(pf[path]);
  if (!fmt) return { unit: CANNOT_FORMAT };
  // Same rule as resolveChangeUnit, same reasons -- `duo.tacos.delta_pts` is
  // the case that bites: it would print "2.8%" for a 2.8-POINT move.
  if (kind === 'change') return servedSpec(changeTokenOf(fmt), fmt);
  return specOf(DISPLAY_UNIT[fmt.display] ?? fmt.display, fmt);
}

// ---------------------------------------------------------------------------
// PRE-0.2.0 FALLBACK ONLY -- which envelope caveat kinds bar bare quotation of
// a figure they ride on.
//
// The engine now computes severity server-side and publishes it on every
// caveat (>= 0.2.0), and a served severity is used VERBATIM. This table is
// retained only for older envelopes, and it is retained knowing it is WRONG in
// the general case, in two ways a consumer-side table cannot fix:
//   1. It defaults an unrecognized kind to 'disclosure', so every kind the
//      engine adds lands silently DOWNGRADED until somebody edits this file --
//      `vc_shipped_view` sat at that default from the day it shipped.
//   2. Severity can depend on the RUN, not just the kind. The engine grades
//      `lost_sales_regime_guard` as BLOCKING when the guard only detected a
//      suspect reference (the suspect number is still in the totals) and
//      DISCLOSURE when it was applied (the number was corrected); it grades
//      `vc_shipped_view` the same way against whether the run's basis is the
//      shipped view. No table keyed on `kind` can express either.
// So: never add a kind here. Send it to the engine.
// ---------------------------------------------------------------------------
/**
 * The engine's closed severity union. Both consumers of a registry entry test
 * for `blocking` by exact lowercase equality (validate.ts CAVEAT-1,
 * render-report.ts's caveat block), so a served value has to be canonicalized
 * before it is stored -- retiring CAVEAT_SEVERITY removed the only thing in
 * the path that could only ever produce a canonical token.
 */
const SERVED_SEVERITIES = new Set(['blocking', 'disclosure', 'context']);

/**
 * Canonicalize a served severity, failing CLOSED on anything we do not know.
 *
 * Trim and lowercase first: `"Blocking"` or `" blocking"` -- a TitleCase enum,
 * a padding serializer -- would otherwise be stored verbatim and then fail
 * every `=== 'blocking'` test, silently downgrading the exact caveat class
 * that must never be downgraded.
 *
 * An UNRECOGNIZED value becomes `blocking` rather than passing through. The
 * asymmetry is the point: over-binding renders a caveat the reader did not
 * strictly need and is visible; under-binding ships a suspect number quoted
 * bare and is silent. A new severity token upstream should make us render more
 * caveats until we teach this set about it, not fewer.
 */
function normalizeSeverity(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  if (t === '') return undefined;
  return SERVED_SEVERITIES.has(t) ? t : 'blocking';
}

const CAVEAT_SEVERITY: Record<string, string> = {
  filtered_scope: 'blocking',
  decomposition_degraded: 'blocking',
  surge_window: 'disclosure',
  dark_run: 'disclosure',
  restatement: 'disclosure',
  matched_window: 'context',
};

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** Python's `x or default` on a dict value is falsy for `None` AND `{}`
 *  (an empty dict). Mirrored here so `entry.get('insight') or entry`
 *  behaves identically -- including the case where the envelope carries an
 *  empty `insight: {}` sub-object, which must still fall back to `entry`. */
function truthyRecord(v: unknown): Rec | undefined {
  const r = asRecord(v);
  return r && Object.keys(r).length > 0 ? r : undefined;
}

function hasValue(v: unknown): v is number | string | boolean {
  return v !== undefined && v !== null;
}

export interface ExtractedFigure extends Figure {
  value: number;
  unit: string;
  basis: string;
  source_path: string;
  confidence: 'published';
  caveats: string[];
  pct_change?: number | null;
  footing_ok?: boolean | null;
  net_change?: number | null;
}

export interface ExtractSource {
  bridgeRunId: string | null;
  bridgeDomain: string;
  engineVersion: string | number | null;
  schemaVersion: string | number | null;
  period: unknown;
  tenant: unknown;
  currency: string | null;
  channel: string | null;
  companionRunId: string | null;
  /** Which composite selection (mom.ops | mom.ads | yoy.ops) produced this
   *  document, or null for a single-response (non-composite) extraction --
   *  lets a reader tell which period a document describes. Also how
   *  checkFigures recovers the id prefix for its one hardcoded-id rule
   *  (SKU-SPLIT); every other invariant reads id SHAPE, not a fixed string,
   *  so it needs no lookup here. */
  selection: CompositeSelection | null;
  entityKey?: unknown;
}

/**
 * One engine-authored "What we know" statement group, as data.
 *
 * Deliberately NOT a figure: a figure is a number with a unit that a claim
 * quotes, and these are prose. They exist so a causal claim's `mechanism`
 * (CAUSE-1) can cite the engine's own account of a move instead of the model
 * authoring an unfalsifiable explanation.
 */
export interface EvidenceStatement {
  /** Period-namespaced on a composite (`mom.evidence.ops.ops-promo-pricing`),
   *  bare otherwise. Same discipline as figure ids, for the same reason. The
   *  last segment is `kind` when the engine stamped one, else a local slug of
   *  the head. */
  id: string;
  /** The engine's stable semantic slug of the card KIND (evidence >= 0.5.0,
   *  e.g. `ops-promo-pricing`): wording-independent, stamped as cards are
   *  touched, served verbatim. Key any routing on THIS, never on head or
   *  statement text, which reword across evidence releases. Optional:
   *  unstamped cards are contract-valid, not an error. */
  kind?: string;
  /** The metric root the group hangs off (ops, units, gv_conversion, ...). */
  metric: string;
  /** The group's one-line head, e.g. "promo pricing detected". */
  head: string;
  /** positive | negative | neutral, when the engine assigned one. */
  tone?: string;
  /** The group's statement lines, in the engine's own words. */
  statements: string[];
  /** Where in the response this came from, so a reader can go check it. */
  source_path: string;
}

export interface ExtractDocument {
  schema_version: '2.0-draft';
  source: ExtractSource;
  caveat_registry: Record<string, CaveatRegistryEntry>;
  figures: ExtractedFigure[];
  /** Present only when the run carried evidence. Absent, never empty: an empty
   *  array would read as "the engine had nothing to say", which is a different
   *  claim from "evidence was not requested". */
  evidence?: EvidenceStatement[];
  /** Which wording build phrased the evidence statements (the evidence
   *  block's own `evidenceVersion` stamp, served from evidence >= 0.2.0).
   *  Present only alongside `evidence`. Independent of
   *  `source.engineVersion` (engine 0.4.0 ships with evidence 0.5.0) —
   *  never gate an evidence-shape decision on the engine's version stream. */
  evidence_version?: string;
}

export type CheckRuleId =
  | 'REQUIRED'
  | 'SOURCE-PATH'
  | 'NUMERIC'
  | 'DELTA-IDENTITY'
  | 'SKU-SPLIT'
  | 'BRIDGE-FOOTING';

export interface CheckFinding {
  rule: CheckRuleId;
  subject: string;
  detail: string;
}

interface FigOpts {
  caveats?: string[];
  population?: Population;
  extra?: Partial<
    Pick<ExtractedFigure, 'pct_change' | 'footing_ok' | 'net_change'>
  >;
}

/** `unit` takes either a bare token (the pre-0.2.0 fallback path, where there
 *  is nothing else to say about it) or a resolved `UnitSpec`. A spec marked
 *  `served` also stamps `served_unit`, which is the SAME value as `unit` here
 *  by construction -- deliberately, and it is not redundant: `unit` is what a
 *  downstream assembly pass may rewrite by hand, `served_unit` is what the
 *  engine asserted, and UNIT-2 exists to notice when the two stop agreeing. */
function fig(
  id: string,
  label: string,
  value: number,
  unit: string | UnitSpec,
  basis: string,
  sourcePath: string,
  opts: FigOpts = {},
): ExtractedFigure {
  const spec: UnitSpec = typeof unit === 'string' ? { unit } : unit;
  const f: ExtractedFigure = {
    id,
    label,
    value,
    unit: spec.unit,
    basis,
    source_path: sourcePath,
    confidence: 'published',
    caveats: opts.caveats ? [...opts.caveats] : [],
  };
  if (spec.precision !== undefined) f.precision = spec.precision;
  if (spec.served) f.served_unit = spec.unit;
  if (opts.population !== undefined) f.population = opts.population;
  if (opts.extra) Object.assign(f, opts.extra);
  return f;
}

/** Ops metrics: carry the envelope's own declared basis, per lane. */
function opsBasis(env: Rec, metric: string | undefined): string {
  const b = asRecord(env.basis) ?? {};
  if (metric === 'ops' || metric === 'ops_per_unit' || metric === 'lost_sales') {
    return (b.revenue as string) ?? 'engine_default';
  }
  if (metric === 'units') {
    return (b.units as string) ?? 'engine_default';
  }
  if (
    metric === 'sessions' ||
    metric === 'conversion' ||
    metric === 'glance_views' ||
    metric === 'gv_conversion'
  ) {
    return (b.traffic as string) ?? 'engine_default';
  }
  return 'engine_default';
}

const SIDE_FIELDS: readonly (readonly [string, string])[] = [
  ['p1', 'p1Value'],
  ['p2', 'p2Value'],
];

function buildSource(
  env: Rec,
  doc: Rec,
  domain: string,
  entityKey?: unknown,
  selection?: CompositeSelection,
): ExtractSource {
  const src: ExtractSource = {
    bridgeRunId: (env.bridgeRunId as string) ?? null,
    bridgeDomain: domain,
    // None = pre-T1 engine, say so downstream
    engineVersion: (env.engineVersion as string | number) ?? null,
    schemaVersion: (env.schemaVersion as string | number) ?? null,
    period: env.period ?? null,
    tenant: env.tenant ?? null,
    currency: (env.currency as string) ?? null,
    channel: (env.channel as string) ?? null,
    companionRunId: (doc.companionRunId as string) ?? null,
    selection: selection ?? null,
  };
  if (entityKey !== undefined) src.entityKey = entityKey;
  return src;
}

/** Entity-scoped envelope (?scope=entity&entityKey=...): the insights ARE
 *  the entity's metric rows (p1Value/p2Value/netChange per metric), and the
 *  components are that entity's own decomposition legs. Emitted namespaced
 *  under <domain>.entity.<entityKey>.* so a document can carry the account
 *  totals and any number of entity envelopes side by side. */
function extractEntity(
  doc: Rec,
  env: Rec,
  domain: string,
  unitsMap: Record<string, string>,
  served: ServedContract,
  registry: Record<string, CaveatRegistryEntry>,
  deltaCaveats: string[],
  levelCaveats: string[],
  selection: CompositeSelection | undefined,
): ExtractDocument {
  const ekey = env.entityKey;
  const slug = String(ekey);
  const figures: ExtractedFigure[] = [];
  const seen = new Set<string>();

  const insights = asArray(env.insights) ?? [];
  insights.forEach((entryRaw, ii) => {
    const entry = asRecord(entryRaw) ?? {};
    const ins = truthyRecord(entry.insight) ?? entry;
    const mkey = ((entry.metricKey as string) || (ins.metricKey as string)) as string | undefined;
    const variant = ((entry.variantKey as string) || (ins.variantKey as string) || 'primary') as string;
    const identKey = `${mkey}\u0000${variant}`;
    if (seen.has(identKey)) return; // same duplicate hazard as total scope
    seen.add(identKey);
    if (variant !== 'primary' && mkey !== 'lost_sales') return; // secondary variants restate the same move; keep primary

    // The engine puts `format` on insights precisely so an entity-scoped
    // envelope -- whose insights are harvested from topDrivers -- is
    // self-describing without a join back to metrics[].
    const fmt = formatOf(entry.format, ins.format);
    const levelSpec = resolveLevelUnit(served, fmt, mkey, unitsMap);
    const changeSpec = resolveChangeUnit(served, fmt, mkey, unitsMap);
    const basis = domain === 'ads' ? (ADS_BASIS[mkey ?? ''] ?? ADS_BASIS_DEFAULT) : opsBasis(env, mkey);
    const base = `envelope:insights[${ii}]`;
    const stem = `${domain}.entity.${slug}.${mkey}`;
    const label = `${mkey} — ${ekey}`;

    for (const [side, field] of SIDE_FIELDS) {
      const v = entry[field];
      if (hasValue(v)) {
        figures.push(
          fig(`${stem}.${side}`, label, v as number, levelSpec, basis, `${base}.${field}`, {
            // Blocking caveats ride the levels here for the same reason they
            // do at total scope -- and this path needs it MORE, not less: the
            // regime guard flags a specific ASIN, so the entity row IS the
            // suspect number the caveat names. Leaving it bound only at total
            // scope would have fixed the summary and left the row it points at
            // quotable bare.
            caveats: levelCaveats.length > 0 ? levelCaveats : undefined,
          }),
        );
      }
    }
    const netChange = entry.netChange;
    if (hasValue(netChange)) {
      figures.push(
        // The CHANGE unit, not the LEVEL that p1/p2 above correctly carry --
        // served `deltaUnit` when the engine publishes one, else
        // `changeUnitOf`. Same rule the legs below use, so an entity's rate
        // delta and its own legs agree.
        fig(`${stem}.delta`, label, netChange as number, changeSpec, basis, `${base}.netChange`, {
          caveats: deltaCaveats,
          extra: { pct_change: (entry.pctChange as number | null | undefined) ?? null },
        }),
      );
    }
    const components = asArray(entry.components) ?? [];
    components.forEach((compRaw, ci) => {
      const comp = asRecord(compRaw) ?? {};
      if (!hasValue(comp.impact)) return;
      figures.push(
        fig(
          `${domain}.entity.${slug}.bridge.${mkey}.${variant}.${comp.key as string}`,
          `${mkey} ${comp.key as string} leg (${variant}) — ${ekey}`,
          comp.impact as number,
          // ANCHOR metric's CHANGE unit -- the same `changeSpec` this
          // insight's own delta carries, so a leg and the net it foots to can
          // never disagree. NOT comp.valueUnit; see `resolveChangeUnit`.
          changeSpec,
          basis,
          `${base}.components[${ci}].impact`,
          {
            extra: {
              footing_ok: (asRecord(entry.footing)?.ok as boolean | null | undefined) ?? null,
              net_change: (entry.netChange as number | null | undefined) ?? null,
            },
          },
        ),
      );
    });
  });

  return {
    schema_version: '2.0-draft',
    source: buildSource(env, doc, domain, ekey, selection),
    caveat_registry: registry,
    figures,
  };
}

/** The composite entries (INS-MONTHLY-01) do not return a single response:
 *  they return a BUNDLE whose real envelopes nest one level down --
 *  `{ ok, mom: { ops, ads, crossDomain },
 *     yoy: { ops, ads: null, crossDomain: null } | null,
 *  headline, limitations, meta }`. Handed that bundle unselected, the extractor used
 *  to see no `envelope` key, treat the whole composite as a bare envelope,
 *  find no metrics or insights, and emit ZERO figures -- which then passed
 *  every --check invariant vacuously. That is the silent-empty failure the
 *  contract exists to kill, so a composite now REFUSES unless the caller
 *  names which envelope it wants.
 *
 *  One selection per figures document, one call per envelope -- but the
 *  skill composes every selection's document into a single report (SKILL.md
 *  Step 2), so ids cannot merely be collision-free WITHIN one document; they
 *  have to stay disjoint ACROSS the mom.ops / mom.ads / yoy.ops documents
 *  once merged. `${domain}.${key}.${side}` alone repeats identically across
 *  periods -- mom.ops and yoy.ops each extract their own envelope's
 *  `ops.ops.p1`, so a merge would let a MoM figure_ref silently resolve to
 *  the YoY value through a last-wins id index. Every id a composite
 *  selection emits is therefore period-prefixed -- `mom.*` / `yoy.*`, see
 *  `extractFigures` below -- while the single-response path (no
 *  `selection`) keeps the bare ids above, unchanged, matching the upstream
 *  Python extractor.
 *
 *  ⚠ THERE IS NO `yoy.ads`, AND ITS ABSENCE IS NOT AN OVERSIGHT. A unit audit
 *  flagged the missing selection; the server says otherwise. INS-MONTHLY-01
 *  runs exactly ONE ads bridge per request, against the MoM window, and pins
 *  the YoY leg as `{ ops: InsightEnvelope; ads: null; crossDomain: null }` --
 *  `ads` typed as the LITERAL `null`, not `InsightEnvelope | null`, with the
 *  producer's own comment saying these "are not 'null for now' -- the YoY leg
 *  runs no ads bridge at all, so anything else here would be a lie the
 *  compiler should refuse", and a served limitation string telling the reader
 *  the same ("no advertising bridge is run for the year-ago window, so
 *  yoy.ads and yoy.crossDomain are always null. That is the scope of this
 *  comparison, not missing data"). Listing `yoy.ads` here would advertise a
 *  choice -- in `--select`'s own help text and in the unselected-composite
 *  error -- that can only ever fail. It becomes real the day the server widens
 *  that type, which is the same day that limitation string comes off, and not
 *  before. Note `yoy.ads` IS a present KEY on the bundle (holding null), so
 *  its presence is not evidence of an envelope; only a non-null value is. */

/**
 * The "What we know" statements, extracted as typed, referenceable entries.
 *
 * WHY THESE ARE NOT FIGURES. A figure is a number with a unit that a claim
 * quotes. A statement is engine-authored PROSE explaining why something moved.
 * Forcing prose through the figure shape would hand every one of them a unit
 * they do not have, and UNIT-2 would then police a contract that cannot apply.
 * They land in their own `evidence[]` collection instead.
 *
 * WHAT THEY ARE FOR. `CAUSE-1` requires a causal claim to carry a `mechanism`.
 * Until now the model had to author that prose unsupported, which is exactly
 * the kind of unfalsifiable text this contract exists to eliminate. A served
 * statement gives the mechanism a SOURCE: the model can quote the engine's own
 * account of the move and cite the id, rather than inventing one.
 *
 * IDS ARE PERIOD-NAMESPACED, like figures. Evidence rides the leg
 * (`mom.evidence` / `yoy.evidence`), the skill composes every selection's
 * document into one report, and a MoM and a YoY statement about the same
 * metric would otherwise be indistinguishable — the identical-ids failure this
 * composite already shipped once at the figure layer.
 *
 * EMITTED ON THE OPS SELECTION ONLY for a composite. `mom.ops` and `mom.ads`
 * both resolve to the SAME `mom.evidence` block, so emitting on each would
 * duplicate every id across two documents the model merges. The ops leg is the
 * one that carries it.
 */
function extractEvidence(
  whole: Rec,
  selection?: CompositeSelection,
): { statements: EvidenceStatement[]; evidenceVersion: string | null } {
  const none = { statements: [], evidenceVersion: null };
  // For a composite, evidence is a sibling of the leg's envelope; for a single
  // response it sits at the top level next to `envelope`.
  let block: Rec | undefined;
  if (selection) {
    if (!selection.endsWith('.ops')) return none;
    const period = selection.split('.')[0]!;
    block = asRecord(asRecord(whole[period])?.evidence);
  } else {
    block = asRecord(whole.evidence);
  }
  const statements = asRecord(block?.statements);
  if (!statements) return none;

  // evidence >= 0.2.0 stamps which wording build phrased the statements.
  // Carried through so a statement-string question is triaged against the
  // wording build, never against `engineVersion` (independent streams).
  const evidenceVersion =
    typeof block?.evidenceVersion === 'string' && block.evidenceVersion.trim().length > 0
      ? block.evidenceVersion
      : null;

  const prefix = selection ? `${selection.split('.')[0]}.evidence` : 'evidence';
  const out: EvidenceStatement[] = [];
  const used = new Set<string>();

  for (const [metric, groupsRaw] of Object.entries(statements)) {
    const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
    groups.forEach((groupRaw, i) => {
      const g = asRecord(groupRaw);
      if (!g) return;
      const head = typeof g.head === 'string' ? g.head : '';
      // Prefer the engine's served stable id for the slug leg (evidence
      // 0.5.0: `DriverQuestionGroup.id`, a wording-independent semantic slug
      // of the card kind, stamped as cards are touched). Served VERBATIM so
      // the id survives upstream wording releases; unstamped cards are
      // contract-valid and keep the pre-0.5.0 derivation (slug of the head),
      // so their historical ids do not move. The metric segment stays in the
      // id either way: one kind legitimately rides several metric roots
      // (promo pricing appears under ops, units and conversion in the same
      // run), and the position prefix is what keeps those distinct,
      // addressable citations.
      //
      // Verbatim is gated on the id LOOKING like the contract's slugs: this
      // extractor also runs over user-supplied JSON files, and a kind can be
      // quoted into a customer-facing citation, so a degenerate id (control
      // bytes, dots that mimic our id segments, unbounded length) must not
      // ride through. An id that fails the shape check is treated as
      // unstamped, which degrades to the head slug rather than erroring —
      // the same posture the contract prescribes for absence.
      const rawKind = typeof g.id === 'string' ? g.id.trim() : '';
      const kind = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawKind) ? rawKind : null;
      const slug =
        kind ??
        (head
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 48) || `group_${i}`);
      let id = `${prefix}.${metric}.${slug}`;
      if (used.has(id)) id = `${id}.${i}`;
      used.add(id);

      const questions = Array.isArray(g.questions) ? g.questions : [];
      const lines = questions
        .map((q) => asRecord(q)?.question)
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0);

      out.push({
        id,
        ...(kind ? { kind } : {}),
        metric,
        head,
        ...(typeof g.tone === 'string' ? { tone: g.tone } : {}),
        statements: lines,
        source_path: selection
          ? `${selection.split('.')[0]}.evidence.statements.${metric}[${i}]`
          : `evidence.statements.${metric}[${i}]`,
      });
    });
  }
  return { statements: out, evidenceVersion };
}

export const COMPOSITE_SELECTIONS = ['mom.ops', 'mom.ads', 'yoy.ops'] as const;
export type CompositeSelection = (typeof COMPOSITE_SELECTIONS)[number];

export function isCompositeResponse(response: unknown): boolean {
  const doc = asRecord(response) ?? {};
  if (Object.prototype.hasOwnProperty.call(doc, 'envelope')) return false;
  const mom = asRecord(doc.mom);
  // A composite is identified by its nested run bundle, not by the reporting
  // furniture around it (headline/limitations/meta), so a future composite
  // that drops those still trips this.
  return !!mom && (hasValue(mom.ops) || hasValue(mom.ads));
}

export class CompositeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeSelectionError';
  }
}

/** Resolve a composite bundle down to the single response the extractor
 *  understands: the selected envelope, plus the cross-domain block that
 *  belongs with it. crossDomain is delivered attached to the ops leg of the
 *  MoM pair only -- mirrors the pre-composite response shape below, where
 *  crossDomain rides the ops response and the ads companion never carries
 *  one -- so it accompanies `mom.ops` alone, never `mom.ads` or `yoy.ops`. */
function selectFromComposite(doc: Rec, selection: CompositeSelection): Rec {
  const [periodKey, domainKey] = selection.split('.') as ['mom' | 'yoy', 'ops' | 'ads'];
  const period = asRecord(doc[periodKey]);
  if (!period) {
    throw new CompositeSelectionError(
      `This composite has no '${periodKey}' block (an INS-MONTHLY-01 run without YoY returns yoy: null). ` +
        `Available: ${COMPOSITE_SELECTIONS.filter((s) => !!asRecord(doc[s.split('.')[0]])).join(', ') || 'none'}.`,
    );
  }
  const envelope = asRecord(period[domainKey]);
  if (!envelope) {
    throw new CompositeSelectionError(
      `This composite's '${periodKey}' block has no '${domainKey}' envelope.`,
    );
  }
  const out: Rec = { envelope };
  const crossDomain = periodKey === 'mom' && domainKey === 'ops' ? asRecord(period.crossDomain) : undefined;
  if (crossDomain) out.crossDomain = crossDomain;
  return out;
}

/** Deterministic envelope -> figures. The model never reads raw envelope
 *  JSON: this function does, and its output is checked by invariants
 *  (checkFigures), not attention.
 *
 *  `selection` is required for a composite bundle and rejected for a plain
 *  response, so neither shape can be fed in by accident. Renamed internal:
 *  builds the ids exactly as documented at the top of this file, unprefixed
 *  regardless of `selection`. The exported `extractFigures` below applies
 *  the period prefix as a single post-extraction step. */
function extractFiguresUnprefixed(response: unknown, selection?: CompositeSelection): ExtractDocument {
  let rawDoc = asRecord(response) ?? {};
  // Kept before the composite narrowing below, because evidence rides the LEG
  // (`mom.evidence`, `yoy.evidence`) and is a SIBLING of the envelope that
  // `selectFromComposite` selects — narrowing first would throw it away.
  const wholeResponse = rawDoc;
  const composite = isCompositeResponse(rawDoc);
  if (composite) {
    if (!selection) {
      throw new CompositeSelectionError(
        'This is a composite run bundle (INS-MONTHLY-01), not a single insights response: ' +
          'its envelopes nest inside mom/yoy. Extract one envelope at a time by naming it, ' +
          `e.g. --select mom.ops (choices: ${COMPOSITE_SELECTIONS.join(', ')}). ` +
          'Extracting the bundle itself would yield zero figures and pass --check vacuously.',
      );
    }
    rawDoc = selectFromComposite(rawDoc, selection);
  } else if (selection) {
    throw new CompositeSelectionError(
      `--select ${selection} was given, but this response is a single insights response, not a composite bundle. ` +
        'Drop the selection.',
    );
  }
  const env: Rec = Object.prototype.hasOwnProperty.call(rawDoc, 'envelope')
    ? (asRecord(rawDoc.envelope) ?? {})
    : rawDoc;
  const domain = (env.bridgeDomain as string) ?? 'ops';
  const unitsMap = domain === 'ads' ? ADS_UNITS : OPS_UNITS;
  const cd = asRecord(rawDoc.crossDomain);
  // Decided ONCE, off `envelope.engineVersion` -- never `meta.engineSha`.
  const served = servedContractOf(env, cd);

  // Envelope-level caveats become the registry; their ids ride every DELTA
  // figure (a comparison-period caveat qualifies the comparison, not either
  // period's own level).
  const registry: Record<string, CaveatRegistryEntry> = {};
  const deltaCaveats: string[] = [];
  // BLOCKING caveats ride the LEVEL figures too -- see levelCaveats below.
  const levelCaveats: string[] = [];
  const caveatsArr = asArray(env.caveats) ?? [];
  caveatsArr.forEach((cRaw, i) => {
    const c = asRecord(cRaw) ?? {};
    const kind = (c.kind as string) ?? 'unknown';
    const cid = `env.${kind}.${i}`;
    // SERVED SEVERITY, VERBATIM. Presence is the gate here, not the version:
    // severity is only ever written by an engine that computed it, and unlike
    // `format` an ABSENT severity carries no meaning to interpret -- so there
    // is nothing for a version gate to disambiguate. An unrecognized served
    // value passes through unchanged rather than being folded back into our
    // table's `disclosure` default: downgrading the engine's judgment to ours
    // is the exact failure this field was published to end. If a served
    // severity is ever wrong, file it upstream.
    const servedSeverity = normalizeSeverity(c.severity);
    const severity = servedSeverity ?? CAVEAT_SEVERITY[kind] ?? 'disclosure';
    registry[cid] = {
      text: (c.message as string) ?? '',
      severity,
    };
    deltaCaveats.push(cid);
    // ⚠ A BLOCKING caveat also rides the LEVEL figures. The delta-only rule
    // above is right for a caveat that qualifies the COMPARISON, but blocking
    // means "this number is not safe to quote bare", and the number it names
    // is usually a level: `lost_sales_regime_guard` on a detected-but-not-
    // applied run says outright "do not quote this row or the lost-sales
    // TOTAL bare", and the total is p2. Binding it to the delta alone left
    // `ops.lost_sales.p1` / `.p2` carrying `caveats: []`, so a section quoting
    // the suspect total validated clean and rendered no caveat block.
    //
    // That is not a corner: detection always runs, substitution is opt-in, and
    // our surface does not set it -- so BLOCKING is our default posture on
    // every run where the guard fires, not an edge case.
    if (severity === 'blocking') levelCaveats.push(cid);
  });

  // Entity-scoped envelope: a different shape entirely (metric rows live in
  // the insights, totals block is the RUN's account totals, not the entity).
  if (hasValue(env.entityKey)) {
    return extractEntity(rawDoc, env, domain, unitsMap, served, registry, deltaCaveats, levelCaveats, selection);
  }

  const figures: ExtractedFigure[] = [];

  // metricKey -> the format served on metrics[]. The bridge legs below foot to
  // one of these metrics' deltas, so when a leg carries no format of its own
  // this is the one it must inherit. See the leg resolution for why.
  const metricFormats = new Map<string, ServedFormat>();

  const metricsArr = asArray(env.metrics) ?? [];
  metricsArr.forEach((mRaw, mi) => {
    const m = asRecord(mRaw) ?? {};
    const key = m.metricKey as string | undefined;
    const fmt = formatOf(m.format);
    if (key !== undefined && fmt !== undefined) metricFormats.set(key, fmt);
    const levelSpec = resolveLevelUnit(served, fmt, key, unitsMap);
    const changeSpec = resolveChangeUnit(served, fmt, key, unitsMap);
    const basis = domain === 'ads' ? (ADS_BASIS[key ?? ''] ?? ADS_BASIS_DEFAULT) : opsBasis(env, key);
    const t = asRecord(m.totals) ?? {};
    const base = `envelope:metrics[${mi}].totals`;

    for (const side of ['p1', 'p2'] as const) {
      const v = t[side];
      if (hasValue(v)) {
        figures.push(
          fig(`${domain}.${key}.${side}`, key ?? '', v as number, levelSpec, basis, `${base}.${side}`, {
            // Blocking only -- a level is not qualified by a comparison caveat.
            caveats: levelCaveats.length > 0 ? levelCaveats : undefined,
          }),
        );
      }
    }
    const delta = t.delta;
    if (hasValue(delta)) {
      let pop: Population | undefined;
      const drivers = asArray(m.topDrivers) ?? [];
      if (drivers.length > 0) {
        pop = {
          complete: false, // topDrivers is a ranked SHORTLIST, never the census
          members: drivers.map((dRaw): PopulationMember => {
            const d = asRecord(dRaw) ?? {};
            return { key: d.entityKey as string, delta: d.delta };
          }),
        };
      }
      figures.push(
        // The CHANGE unit, not the LEVEL kept by p1/p2 above: a rate metric's
        // delta is in POINTS. On a served envelope that comes from the
        // engine's own `deltaUnit`; otherwise from `changeUnitOf`. Either way
        // every leg that foots to this figure resolves through the SAME call,
        // so the two cannot disagree.
        fig(`${domain}.${key}.delta`, key ?? '', delta as number, changeSpec, basis, `${base}.delta`, {
          caveats: deltaCaveats,
          population: pop,
          extra: { pct_change: (t.pctChange as number | null | undefined) ?? null },
        }),
      );
    }

    // Per-driver CHANGE figures, capped -- the template's driver tables
    // (item-group highlights, top movers) need typed figures per entity, and
    // until these existed the only presentable numbers were account totals.
    //
    // RANKED rows only. Upstream appends drill-signal-flagged entities beyond
    // the display cap precisely so a consumer cannot read a tail row as a top
    // mover, and stamps `includedBy` to tell them apart; an ABSENT marker
    // means ranked (pre-marker sidecars never had appendees, per the engine
    // author 2026-08-20). Filtering here means a driver FIGURE can never
    // quietly be a drill appendee wearing a top-mover id.
    //
    // Capped at 5 per metric: the template rule is that the reader wants the
    // finding, not the ranking -- the full 11-18 list is evidence, and the
    // capped-out remainder is still countable through the delta figure's
    // population above. Values are the driver's CHANGE in the metric's change
    // unit (same changeSpec as the delta figure they decompose), and ids use
    // RANK, not entity names: names are display labels, unbounded and
    // collision-prone; rank is stable within a run and meaningless across
    // runs, which is honest.
    const DRIVER_FIGURE_CAP = 5;
    const ranked = (asArray(m.topDrivers) ?? [])
      .map((dRaw) => asRecord(dRaw) ?? {})
      .filter((d2) => d2.includedBy === undefined || d2.includedBy === 'rank')
      ;
    ranked.slice(0, DRIVER_FIGURE_CAP).forEach((d2, rank) => {
      const dv = d2.delta;
      if (!hasValue(dv)) return;
      const name = typeof d2.displayName === 'string' && d2.displayName.trim().length > 0
        ? d2.displayName
        : String(d2.entityKey ?? `entity ${rank + 1}`);
      figures.push(
        fig(
          `${domain}.${key}.driver.${rank + 1}`,
          name,
          dv as number,
          changeSpec,
          basis,
          `${base}.topDrivers[${rank}].delta`,
          { caveats: deltaCaveats },
        ),
      );
    });
  });

  // Bridge legs -- published decomposition; never re-derive (the revenue-
  // bridge trap). One set per insight variant at total scope.
  //
  // Dedupe by (metricKey, variant, scope): the live envelope has served the
  // SAME total-scope insight twice, which double-counted the legs and
  // tripped the footing check. Identical identity -> identical figure ids,
  // so the second entry can only ever be a duplicate or a collision; keep
  // the first and let the engine-side duplicate be reported upstream.
  const seenInsights = new Set<string>();
  const insightsArr = asArray(env.insights) ?? [];
  insightsArr.forEach((entryRaw, ii) => {
    const entry = asRecord(entryRaw) ?? {};
    const ins = truthyRecord(entry.insight) ?? entry;
    if (ins.scope !== 'total') return;
    const variant = ((entry.variantKey as string) || (ins.variantKey as string) || 'primary') as string;
    const mkey = ins.metricKey as string | undefined;
    const identKey = `${mkey}\u0000${variant}`;
    if (seenInsights.has(identKey)) return;
    seenInsights.add(identKey);

    // The insight's own served format IS the anchor metric's -- the engine
    // lifts both from the same METRIC_DEFINITIONS entry -- so a leg and the
    // anchor's delta resolve identically without a join back to metrics[].
    // ⚠ Inherit the ANCHOR metric's format when the insight carries none.
    // `bridgeLegUnit` used to guarantee a leg and the net it foots to agreed,
    // structurally: both were changeUnitOf(unitsMap[mkey]) -- same map, same
    // key. Resolving the leg from `insights[].format` and the delta from
    // `metrics[].format` splits that source, so PRESENCE SKEW between the two
    // arrays breaks the agreement: with a format on the metric and none on the
    // insight, the delta renders "$44,000" while its own legs render
    // "20000 unformattable". BRIDGE-FOOTING compares values, not units, so
    // nothing catches it. The engine lifts both from the same
    // METRIC_DEFINITIONS entry, so falling back to the metric's format is not
    // a guess -- it is the same answer by a second route.
    const legFmt =
      formatOf(ins.format, entry.format) ?? (mkey !== undefined ? metricFormats.get(mkey) : undefined);
    const legSpec = resolveChangeUnit(served, legFmt, mkey, unitsMap);
    const components = asArray(ins.components) ?? [];
    components.forEach((compRaw, ci) => {
      const comp = asRecord(compRaw) ?? {};
      if (!hasValue(comp.impact)) return;
      figures.push(
        fig(
          `${domain}.bridge.${mkey}.${variant}.${comp.key as string}`,
          `${mkey} ${comp.key as string} leg (${variant})`,
          comp.impact as number,
          // ANCHOR metric's change unit, NOT comp.valueUnit (which describes
          // the lever's own level, a number this figure does not carry) --
          // see `resolveChangeUnit`.
          legSpec,
          domain === 'ops' ? opsBasis(env, mkey) : ADS_BASIS_DEFAULT,
          `envelope:insights[${ii}].insight.components[${ci}].impact`,
          {
            extra: {
              footing_ok: (asRecord(entry.footing)?.ok as boolean | null | undefined) ?? null,
              net_change: (ins.netChange as number | null | undefined) ?? null,
            },
          },
        ),
      );
    });
  });

  // Cross-domain block (present only on the ops response with a companion).
  //
  // Every unit below now resolves through `crossDomain.pairFormats` when the
  // engine serves one (>= 0.3.0), keyed by the engine's own dotted path. The
  // hardcoded token passed alongside each call is the PRE-0.3.0 FALLBACK --
  // what this extractor used before the contract existed -- and is consulted
  // only when no pairFormats block is served.
  if (cd) {
    const soloBlocks: readonly (readonly [string, string, string])[] = [
      ['tacos', 'ratio', 'deltaPts'],
      ['attributedShare', 'ratio', 'deltaPts'],
    ];
    for (const [name, unit, ptsField] of soloBlocks) {
      const blk = asRecord(cd[name]);
      if (!blk) continue;
      const levelSpec = resolvePairUnit(served, name, 'level', unit);
      for (const side of ['p1', 'p2'] as const) {
        const v = blk[side];
        if (hasValue(v)) {
          figures.push(
            fig(`duo.${name}.${side}`, name, v as number, levelSpec, 'cross_domain_joined', `crossDomain.${name}.${side}`),
          );
        }
      }
      const ptsVal = blk[ptsField];
      if (hasValue(ptsVal)) {
        figures.push(
          fig(
            `duo.${name}.delta_pts`,
            name,
            ptsVal as number,
            // `deltaPts` is NAMED points but is not stored in points: the
            // engine computes it as `p.p2 - p.p1` over a RATIO pair (TACOS
            // and attributed share are both `ratioPair(...)`, "in RATE units
            // (0.083 = 8.3%)"), so a 2.8-point move arrives as 0.028. Under
            // our `points` unit -- an already-whole number -- that rendered
            // "0.0 pts" and erased the move. The served contract says exactly
            // this mechanically: display 'percent' + deltaUnit 'pts', i.e.
            // our `points_fraction` (x100 -> pts). The fallback derives the
            // same answer from the block's own level unit.
            resolvePairUnit(served, name, 'change', changeUnitOf(unit)),
            'cross_domain_joined',
            `crossDomain.${name}.${ptsField}`,
          ),
        );
      }
    }

    const td = asRecord(cd.tacosDecomposition);
    if (td) {
      // The engine keeps the decomposition's LEGS out of pairFormats (each
      // HorizontalBridgeComponent carries its own valueUnit) but puts its
      // ENDPOINTS in, under `tacosDecomposition`. A leg stores an impact on
      // those endpoints -- "in TACOS rate units (0.01 = 1 pt)" -- so the leg
      // takes the ENDPOINTS' CHANGE unit, the same anchor rule the envelope
      // bridges use. Served and fallback agree on `points_fraction` here.
      const legSpec = resolvePairUnit(served, 'tacosDecomposition', 'change', 'points_fraction');
      const comps = asArray(td.components) ?? [];
      comps.forEach((compRaw, ci) => {
        const comp = asRecord(compRaw) ?? {};
        if (!hasValue(comp.impact)) return;
        figures.push(
          fig(
            `duo.bridge.tacos.primary.${comp.key as string}`,
            `tacos ${comp.key as string} leg (cross-domain)`,
            comp.impact as number,
            legSpec,
            'cross_domain_joined',
            `crossDomain.tacosDecomposition.components[${ci}].impact`,
            { extra: { net_change: (td.delta as number | null | undefined) ?? null } },
          ),
        );
      });
    }

    const pp = asRecord(cd.paidPressure);
    if (pp) {
      // A pressure INDEX served in rate units: >1 (>100% displayed) is a legal
      // reading, not an error. The served contract says display 'percent',
      // which is our 'ratio' -- the same token the fallback used.
      const ppSpec = resolvePairUnit(served, 'paidPressure', 'level', 'ratio');
      for (const side of ['p1', 'p2'] as const) {
        const v = pp[side];
        if (hasValue(v)) {
          figures.push(
            fig(
              `duo.paidPressure.${side}`,
              'paid pressure',
              v as number,
              ppSpec,
              'cross_domain_joined',
              `crossDomain.paidPressure.${side}`,
            ),
          );
        }
      }
    }

    const av = asRecord(cd.aspVsAdAov);
    if (av) {
      for (const lane of ['asp', 'adAov'] as const) {
        const laneBlk = asRecord(av[lane]) ?? {};
        // NOT a hardcoded 'currency'. The engine builds this block from two
        // metric pairs it reads straight off the sidecars --
        // `aspVsAdAov: { asp: pair(ops, 'ops_per_unit'),
        // adAov: pair(ads, 'ad_aov') }` -- and serves each lane's contract
        // under its own dotted path. The fallback reads the same two metrics
        // out of our own maps, which is the hand-copy of that. Both are
        // 'currency-2dp' (engine: display 'currency-2dp', decimals 2); at 0dp
        // a $59.38 ad AOV printed "$59", and the ASP-vs-ad-AOV comparison is
        // precisely a cents-level read.
        const laneSpec = resolvePairUnit(served, `aspVsAdAov.${lane}`, 'level', AV_LANE_UNITS[lane]);
        for (const side of ['p1', 'p2'] as const) {
          const v = laneBlk[side];
          if (hasValue(v)) {
            figures.push(
              fig(
                `duo.${lane}.${side}`,
                lane,
                v as number,
                laneSpec,
                'cross_domain_joined',
                `crossDomain.aspVsAdAov.${lane}.${side}`,
              ),
            );
          }
        }
      }
    }
  }

  const evidence = extractEvidence(wholeResponse, selection);

  return {
    schema_version: '2.0-draft',
    source: buildSource(env, rawDoc, domain, undefined, selection),
    caveat_registry: registry,
    figures,
    ...(evidence.statements.length
      ? {
          evidence: evidence.statements,
          ...(evidence.evidenceVersion ? { evidence_version: evidence.evidenceVersion } : {}),
        }
      : {}),
  };
}

/** mom./yoy. -- the period half of a composite `selection`, with the
 *  trailing dot; '' for a non-composite (undefined selection) extraction.
 *  `selection` is `<period>.<domain>` (e.g. 'mom.ops'); only the period
 *  distinguishes two documents that could otherwise collide -- the domain
 *  segment is already disjoint via each id's own `${domain}.` prefix, so
 *  `mom.ops` and `mom.ads` sharing the same period prefix is correct, not a
 *  gap: their ids diverge one segment later (ops.* vs ads.*). */
function periodPrefixOf(selection: CompositeSelection | null | undefined): string {
  return selection ? `${selection.split('.')[0]}.` : '';
}

/** Prepend the period prefix to every DOCUMENT-SCOPED identifier, once, after
 *  extraction -- never threaded through each individual fig() call site, so no
 *  emission branch (entity or total-scope, metrics or bridge legs or
 *  crossDomain) can forget it. Two id spaces need it, and both collide the
 *  same way when the skill merges a mom document and a yoy document into the
 *  one report-data it composes:
 *    - figure ids (`ops.ops.p1` in both periods), and
 *    - caveat registry keys (`env.surge_window.0` in both periods), which
 *      figures reference by id in their `caveats` array. Missing these was a
 *      real gap in the first cut of this fix: a merged registry is last-wins,
 *      so a figure could have rendered the OTHER period's caveat text -- and
 *      blocking caveats are exactly the ones that must never be wrong.
 *  Because the prefix is identical across every figure in one document, every
 *  id-SHAPE invariant in checkFigures below (DELTA-IDENTITY's p1/p2/delta stem
 *  match, BRIDGE-FOOTING's leg grouping) keeps working unmodified: those rules
 *  slice and compare relative to each figure's own id and never hardcode a
 *  domain root. Only SKU-SPLIT hardcodes absolute ids and has to be told the
 *  prefix explicitly (via source.selection). source_path (an envelope pointer,
 *  never an id) and population members (business entity keys, never ids) are
 *  left untouched. */
function prefixSelectionIds(
  doc: ExtractDocument,
  selection: CompositeSelection | undefined,
): ExtractDocument {
  const prefix = periodPrefixOf(selection);
  if (!prefix) return doc;
  const caveatRegistry: Record<string, CaveatRegistryEntry> = {};
  for (const [cid, entry] of Object.entries(doc.caveat_registry)) {
    caveatRegistry[`${prefix}${cid}`] = entry;
  }
  return {
    ...doc,
    caveat_registry: caveatRegistry,
    figures: doc.figures.map((f) => ({
      ...f,
      id: `${prefix}${f.id}`,
      caveats: f.caveats.map((cid) => `${prefix}${cid}`),
    })),
  };
}

/** Public entry point. Delegates the actual extraction to
 *  `extractFiguresUnprefixed` (unchanged ids, matching the doc comment at
 *  the top of this file) and then applies the period prefix for a composite
 *  selection. When `selection` is undefined this is a no-op wrapper: the
 *  returned document is byte-identical to what the unprefixed extraction
 *  produced, so the single-response path's parity with the upstream Python
 *  extractor is untouched. */
export function extractFigures(response: unknown, selection?: CompositeSelection): ExtractDocument {
  const doc = extractFiguresUnprefixed(response, selection);
  return prefixSelectionIds(doc, selection);
}

/** Invariants. A failed invariant is a defect in extraction or the envelope
 *  -- either way nothing downstream should consume the output. Mirrors
 *  extract_figures.py's check(out). */
export function checkFigures(out: ExtractDocument): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const figs = new Map<string, ExtractedFigure>(out.figures.map((f) => [f.id, f]));

  const REQUIRED_FIELDS = ['id', 'label', 'value', 'unit', 'basis', 'source_path'] as const;
  for (const f of out.figures) {
    for (const req of REQUIRED_FIELDS) {
      const v = f[req as keyof ExtractedFigure];
      if (v === undefined || v === null || v === '') {
        findings.push({ rule: 'REQUIRED', subject: f.id, detail: `missing ${req}` });
      }
    }
    if (!(String(f.source_path).startsWith('envelope:') || String(f.source_path).startsWith('crossDomain.'))) {
      findings.push({ rule: 'SOURCE-PATH', subject: f.id, detail: 'source_path outside the envelope' });
    }
  }

  // NUMERIC -- every figure's value must actually be a finite number.
  // Math.abs(NaN) > TOL is always false, so a non-numeric value (a string
  // like "n/a" or "20000", an object, a boolean, or a genuine NaN/Infinity)
  // silently PASSES every arithmetic invariant below instead of failing
  // them -- the exact defect this rule closes. Numeric-looking strings are
  // reported too, never coerced: a figure's value is either a number or a
  // defect, there is no third "close enough" state. REQUIRED above already
  // reports an undefined/null/'' value as "missing"; this rule only adds
  // new coverage for a value that IS present but is the wrong type/shape,
  // so the two rules never double-report the same figure.
  const invalidIds = new Set<string>();
  for (const f of out.figures) {
    const v: unknown = f.value;
    if (v === undefined || v === null || v === '') continue; // REQUIRED's concern
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      invalidIds.add(f.id);
      findings.push({
        rule: 'NUMERIC',
        subject: f.id,
        detail: `value must be a finite number, got ${JSON.stringify(v)}`,
      });
    }
  }

  // delta == p2 - p1 wherever all three exist and are all numeric. A figure
  // already flagged NUMERIC is excluded so this can never NaN-compare (which
  // silently passes) or throw.
  for (const f of out.figures) {
    if (f.id.endsWith('.delta') && !f.id.includes('.bridge.')) {
      const stem = f.id.slice(0, -'.delta'.length);
      const p1 = figs.get(`${stem}.p1`);
      const p2 = figs.get(`${stem}.p2`);
      if (
        p1 &&
        p2 &&
        !invalidIds.has(f.id) &&
        !invalidIds.has(p1.id) &&
        !invalidIds.has(p2.id) &&
        Math.abs(p2.value - p1.value - f.value) > TOL
      ) {
        findings.push({ rule: 'DELTA-IDENTITY', subject: f.id, detail: 'delta != p2 - p1' });
      }
    }
  }

  if (out.source.bridgeDomain === 'ads') {
    // same + other + view_through === total, per period (the SKU-split
    // identity). The only hardcoded-id rule in this function: every other
    // invariant here derives its lookups from an id's own SHAPE (a suffix, a
    // substring, a stem slice), so prefixing never touches them. This one
    // has to be told the prefix explicitly -- a composite selection's ids
    // carry it (mom.ads.ad_sales.p1, not ads.ad_sales.p1) -- or the lookups
    // below miss every figure and the whole rule silently stops firing.
    const prefix = periodPrefixOf(out.source.selection);
    for (const side of ['p1', 'p2'] as const) {
      const parts = [
        `${prefix}ads.ad_sales_same_sku.`,
        `${prefix}ads.ad_sales_other_sku.`,
        `${prefix}ads.ad_sales_view_through.`,
      ];
      const totId = `${prefix}ads.ad_sales.${side}`;
      const tot = figs.get(totId);
      const comps = parts.map((p) => figs.get(p + side));
      if (
        tot &&
        comps.every((c): c is ExtractedFigure => c !== undefined) &&
        !invalidIds.has(tot.id) &&
        comps.every((c) => !invalidIds.has(c.id))
      ) {
        const s = comps.reduce((acc, c) => acc + c.value, 0);
        if (Math.abs(s - tot.value) > TOL) {
          findings.push({
            rule: 'SKU-SPLIT',
            subject: totId,
            detail: `ad_sales SKU-split identity broken on ${side}: ${s} != ${tot.value}`,
          });
        }
      }
    }
  }

  // bridge legs foot to the net change whenever the engine said footing ok.
  // A group containing any leg already flagged NUMERIC is skipped entirely
  // (a string-concatenated reduce here is exactly how earlier findings used
  // to get lost mid-check -- see BRIDGE-FOOTING test coverage for the
  // numeric-string-leg regression this guards).
  const legs = new Map<string, ExtractedFigure[]>();
  for (const f of out.figures) {
    if (f.id.includes('.bridge.') && f.footing_ok) {
      const stem = f.id.slice(0, f.id.lastIndexOf('.'));
      const arr = legs.get(stem) ?? [];
      arr.push(f);
      legs.set(stem, arr);
    }
  }
  for (const [stem, group] of legs) {
    const net = group[0].net_change;
    if (net === undefined || net === null) continue;
    if (typeof net !== 'number' || !Number.isFinite(net)) continue; // malformed metadata; nothing safe to compare
    if (group.some((g) => invalidIds.has(g.id))) continue;
    const s = group.reduce((acc, g) => acc + g.value, 0);
    if (Math.abs(s - net) > Math.max(Math.abs(net) * 0.001, TOL)) {
      findings.push({
        rule: 'BRIDGE-FOOTING',
        subject: stem,
        detail: `legs sum ${s.toFixed(4)} != net ${net.toFixed(4)}`,
      });
    }
  }

  return findings;
}
