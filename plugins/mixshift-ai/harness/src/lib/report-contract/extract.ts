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
// ---------------------------------------------------------------------------
const OPS_UNITS: Record<string, string> = {
  ops: 'currency',
  units: 'count',
  sessions: 'count',
  conversion: 'ratio',
  buy_box: 'ratio',
  ops_per_unit: 'currency',
  sellable_inventory: 'count',
  weeks_of_cover: 'weeks',
  lost_sales: 'currency',
  glance_views: 'count',
  gv_conversion: 'ratio',
};
const ADS_UNITS: Record<string, string> = {
  ad_spend: 'currency',
  ad_sales: 'currency',
  acos: 'ratio',
  roas: 'ratio',
  ad_impressions: 'count',
  ad_clicks: 'count',
  ad_ctr: 'ratio',
  ad_orders: 'count',
  ad_cpa: 'currency',
  ad_aov: 'currency',
  ad_cpc: 'currency',
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

function buildSource(env: Rec, doc: Rec, domain: string, entityKey?: unknown): ExtractSource {
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
    source: buildSource(env, doc, domain, ekey),
    caveat_registry: registry,
    figures,
  };
}

/** Deterministic envelope -> figures. The model never reads raw envelope
 *  JSON: this function does, and its output is checked by invariants
 *  (checkFigures), not attention. */
export function extractFigures(response: unknown): ExtractDocument {
  const rawDoc = asRecord(response) ?? {};
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
    return extractEntity(rawDoc, env, domain, unitsMap, registry, deltaCaveats);
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
    source: buildSource(env, rawDoc, domain),
    caveat_registry: registry,
    figures,
  };
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
    // same + other + view_through === total, per period (the SKU-split identity)
    for (const side of ['p1', 'p2'] as const) {
      const parts = ['ads.ad_sales_same_sku.', 'ads.ad_sales_other_sku.', 'ads.ad_sales_view_through.'];
      const tot = figs.get(`ads.ad_sales.${side}`);
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
            subject: `ads.ad_sales.${side}`,
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
