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
// INTERIM-UNTIL-CATALOG metadata (the service catalog owns this eventually).
//
// Every entry below is now reconciled against the ENGINE's own metric
// registry (`METRIC_DEFINITIONS[key].display`), which is the authority on how
// a metric's LEVEL renders. Where our token and the engine's disagreed, the
// engine won. Two conventions to keep straight while reading this:
//   - our `ratio` means a stored FRACTION rendered ×100 with a "%" affix,
//     which is exactly the engine's `percent`. These agree; they are not a
//     defect. (Our `percent` means an ALREADY-WHOLE number — never the right
//     mapping for an engine `percent` metric.)
//   - our `count` is a whole bare number, i.e. the engine's `number`.
// The key sets themselves are pinned to the engine's `OPS_FAMILY_METRICS` and
// `ADS_METRIC_KEYS`: a key missing here silently falls back to 'count' below,
// which is how dollar metrics ended up rendering as bare counts.
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

// Which envelope caveat kinds bar bare quotation of a figure they ride on.
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

export interface ExtractDocument {
  schema_version: '2.0-draft';
  source: ExtractSource;
  caveat_registry: Record<string, CaveatRegistryEntry>;
  figures: ExtractedFigure[];
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

function fig(
  id: string,
  label: string,
  value: number,
  unit: string,
  basis: string,
  sourcePath: string,
  opts: FigOpts = {},
): ExtractedFigure {
  const f: ExtractedFigure = {
    id,
    label,
    value,
    unit,
    basis,
    source_path: sourcePath,
    confidence: 'published',
    caveats: opts.caveats ? [...opts.caveats] : [],
  };
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
  registry: Record<string, CaveatRegistryEntry>,
  deltaCaveats: string[],
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

    const unit = (mkey && unitsMap[mkey]) ?? 'count';
    const basis = domain === 'ads' ? (ADS_BASIS[mkey ?? ''] ?? ADS_BASIS_DEFAULT) : opsBasis(env, mkey);
    const base = `envelope:insights[${ii}]`;
    const stem = `${domain}.entity.${slug}.${mkey}`;
    const label = `${mkey} — ${ekey}`;

    for (const [side, field] of SIDE_FIELDS) {
      const v = entry[field];
      if (hasValue(v)) {
        figures.push(fig(`${stem}.${side}`, label, v as number, unit, basis, `${base}.${field}`));
      }
    }
    const netChange = entry.netChange;
    if (hasValue(netChange)) {
      figures.push(
        fig(`${stem}.delta`, label, netChange as number, unit, basis, `${base}.netChange`, {
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
          (comp.valueUnit as string) ?? 'currency',
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
 *  `{ ok, mom: { ops, ads, crossDomain }, yoy: { ops } | null, headline,
 *  limitations, meta }`. Handed that bundle unselected, the extractor used
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
 *  Python extractor. */
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

  // Envelope-level caveats become the registry; their ids ride every DELTA
  // figure (a comparison-period caveat qualifies the comparison, not either
  // period's own level).
  const registry: Record<string, CaveatRegistryEntry> = {};
  const deltaCaveats: string[] = [];
  const caveatsArr = asArray(env.caveats) ?? [];
  caveatsArr.forEach((cRaw, i) => {
    const c = asRecord(cRaw) ?? {};
    const kind = (c.kind as string) ?? 'unknown';
    const cid = `env.${kind}.${i}`;
    registry[cid] = { text: (c.message as string) ?? '', severity: CAVEAT_SEVERITY[kind] ?? 'disclosure' };
    deltaCaveats.push(cid);
  });

  // Entity-scoped envelope: a different shape entirely (metric rows live in
  // the insights, totals block is the RUN's account totals, not the entity).
  if (hasValue(env.entityKey)) {
    return extractEntity(rawDoc, env, domain, unitsMap, registry, deltaCaveats, selection);
  }

  const figures: ExtractedFigure[] = [];

  const metricsArr = asArray(env.metrics) ?? [];
  metricsArr.forEach((mRaw, mi) => {
    const m = asRecord(mRaw) ?? {};
    const key = m.metricKey as string | undefined;
    const unit = (key && unitsMap[key]) ?? 'count';
    const basis = domain === 'ads' ? (ADS_BASIS[key ?? ''] ?? ADS_BASIS_DEFAULT) : opsBasis(env, key);
    const t = asRecord(m.totals) ?? {};
    const base = `envelope:metrics[${mi}].totals`;

    for (const side of ['p1', 'p2'] as const) {
      const v = t[side];
      if (hasValue(v)) {
        figures.push(fig(`${domain}.${key}.${side}`, key ?? '', v as number, unit, basis, `${base}.${side}`));
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
        fig(`${domain}.${key}.delta`, key ?? '', delta as number, unit, basis, `${base}.delta`, {
          caveats: deltaCaveats,
          population: pop,
          extra: { pct_change: (t.pctChange as number | null | undefined) ?? null },
        }),
      );
    }
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

    const components = asArray(ins.components) ?? [];
    components.forEach((compRaw, ci) => {
      const comp = asRecord(compRaw) ?? {};
      if (!hasValue(comp.impact)) return;
      figures.push(
        fig(
          `${domain}.bridge.${mkey}.${variant}.${comp.key as string}`,
          `${mkey} ${comp.key as string} leg (${variant})`,
          comp.impact as number,
          (comp.valueUnit as string) ?? 'currency',
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
  const cd = asRecord(rawDoc.crossDomain);
  if (cd) {
    const soloBlocks: readonly (readonly [string, string, string])[] = [
      ['tacos', 'ratio', 'deltaPts'],
      ['attributedShare', 'ratio', 'deltaPts'],
    ];
    for (const [name, unit, ptsField] of soloBlocks) {
      const blk = asRecord(cd[name]);
      if (!blk) continue;
      for (const side of ['p1', 'p2'] as const) {
        const v = blk[side];
        if (hasValue(v)) {
          figures.push(
            fig(`duo.${name}.${side}`, name, v as number, unit, 'cross_domain_joined', `crossDomain.${name}.${side}`),
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
            'points',
            'cross_domain_joined',
            `crossDomain.${name}.${ptsField}`,
          ),
        );
      }
    }

    const td = asRecord(cd.tacosDecomposition);
    if (td) {
      const comps = asArray(td.components) ?? [];
      comps.forEach((compRaw, ci) => {
        const comp = asRecord(compRaw) ?? {};
        if (!hasValue(comp.impact)) return;
        figures.push(
          fig(
            `duo.bridge.tacos.primary.${comp.key as string}`,
            `tacos ${comp.key as string} leg (cross-domain)`,
            comp.impact as number,
            'points_fraction',
            'cross_domain_joined',
            `crossDomain.tacosDecomposition.components[${ci}].impact`,
            { extra: { net_change: (td.delta as number | null | undefined) ?? null } },
          ),
        );
      });
    }

    const pp = asRecord(cd.paidPressure);
    if (pp) {
      for (const side of ['p1', 'p2'] as const) {
        const v = pp[side];
        if (hasValue(v)) {
          figures.push(
            fig(
              `duo.paidPressure.${side}`,
              'paid pressure',
              v as number,
              'ratio',
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
        for (const side of ['p1', 'p2'] as const) {
          const v = laneBlk[side];
          if (hasValue(v)) {
            figures.push(
              fig(
                `duo.${lane}.${side}`,
                lane,
                v as number,
                'currency',
                'cross_domain_joined',
                `crossDomain.aspVsAdAov.${lane}.${side}`,
              ),
            );
          }
        }
      }
    }
  }

  return {
    schema_version: '2.0-draft',
    source: buildSource(env, rawDoc, domain, undefined, selection),
    caveat_registry: registry,
    figures,
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
