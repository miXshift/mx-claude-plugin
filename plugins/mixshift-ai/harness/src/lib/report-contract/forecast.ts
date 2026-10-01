/**
 * Forecast figures for the monthly report, from a FCT-TRACK-01 answer.
 *
 * FCT-TRACK-01 serves the forecast the MixShift forecasting app published,
 * already projected into the report's own figure contract: figures, derived
 * figures, claims, sections and a caveat registry for one report month, plus
 * `forecast_state`. This module turns that answer into a figures document the
 * skill can compose like any other extracted document, with these guarantees:
 *
 *   1. THE GATE. Unless `forecast_state` is `provided_current`, the document
 *      carries NO figure, claim, section, caveat or limitation, only the state
 *      and the reason. A report built without a current forecast is therefore
 *      the report it would have been without the forecast step: nothing
 *      forecast-flavoured can leak into it from here.
 *   2. ROLES. A closed month has two expectations that must never be confused:
 *      the FORECAST, what the model said before the month closed (the only one
 *      a beat or miss is quoted against), and the PROJECTION, the current
 *      model's fit with that month included (what the forecasting app shows).
 *      Every figure, derived figure and claim is tagged with its role. The
 *      year-start forecast, which stands in for a plan nobody has recorded,
 *      has a role of its own and is internal only.
 *   3. FAIL CLOSED. An id this module cannot place withholds the WHOLE
 *      forecast (state `not_provided`, reason `unrecognised_figures`), so a
 *      change in the service's ids can never let a projection reach a client
 *      brief under the forecast's name.
 *   4. CLIENT-SAFE. `client_safe` is true only for an actual, forecast or
 *      outlook figure that carries no blocking caveat (and, for a derived
 *      figure, whose inputs are all client-safe). The client brief quotes
 *      nothing else.
 *
 * Sections are tagged `kind: 'forecast'` (the renderer's forecast gate) and
 * `audience: 'internal'`. They are the map of which figures belong together;
 * the report writes its own sentences under its vocabulary rules.
 */

import { validateReportData, type CaveatRegistryEntry, type ReportDataDocument } from './validate.js';

export type ForecastRole = 'actual' | 'forecast' | 'year_start' | 'projection' | 'outlook' | 'basis';
export type ForecastState = 'provided_current' | 'stale' | 'not_provided';

export interface ForecastFigure {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: string;
  source_path: string;
  caveats: string[];
  confidence: 'published';
  forecast_role: ForecastRole;
  client_safe: boolean;
  precision?: number;
  population?: unknown;
}

export interface ForecastDerived {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: string;
  inputs: string[];
  why_not_published: string;
  forecast_role: ForecastRole;
  client_safe: boolean;
}

export interface ForecastClaim {
  id: string;
  kind: string;
  text: string;
  figure_refs: string[];
  forecast_role: ForecastRole;
  comparison_basis?: string;
}

export interface ForecastSection {
  id: string;
  kind: 'forecast';
  audience: 'internal';
  figure_refs: string[];
  claim_refs: string[];
  caveats_rendered: string[];
  display_text: string;
}

export interface ForecastFiguresDocument {
  schema_version: '2.0-draft';
  kind: 'forecast_figures';
  source: {
    insight: 'FCT-TRACK-01';
    metric: 'revenue' | 'units';
    month: string;
    scope_id: string | null;
    forecast_state: ForecastState;
    reason: string | null;
    friendly: string | null;
    spend_basis: 'ads_only' | 'ads_plus_dsp' | null;
    /** True when the published forecast closed months after the report month,
     *  so its year-to-date figures run past it (they carry a blocking caveat). */
    ytd_runs_past_report_month: boolean;
    /** Ids this build could not place; non-empty means the forecast was withheld. */
    unrecognised: string[];
    published: {
      at: string;
      by: string;
      producer: string;
      gateway_revision: number;
      published_run_id: string;
      age_days: number;
      document_version: number | null;
      overlay_revisions: number | null;
    } | null;
    /** The line the run record and the review packet cite: names the served copy
     *  only when its figures were used, and says none were otherwise. */
    attestation: string;
  };
  /** What a report document sets `forecast` to: the renderer gates its forecast sections on `state`. */
  forecast: { state: ForecastState; report_month: string; metric: 'revenue' | 'units' };
  currency: string | null;
  caveat_registry: Record<string, CaveatRegistryEntry>;
  figures: ForecastFigure[];
  derived: ForecastDerived[];
  claims: ForecastClaim[];
  sections: ForecastSection[];
  limitations: string[];
}

export type ForecastCheckRule =
  | 'FORECAST-ROLE'
  | 'FORECAST-GATE'
  | 'FORECAST-TRACE'
  | 'FORECAST-METRIC'
  | 'FORECAST-DUPLICATE'
  | 'FORECAST-CLAIM-BASIS'
  | 'FORECAST-CONTRACT'
  | 'REQUIRED'
  | 'NUMERIC';

export interface ForecastCheckFinding {
  rule: ForecastCheckRule;
  subject: string;
  detail: string;
}

export interface ExtractForecastOptions {
  /** 'YYYY-MM': refuse an answer about any other month (a stale file from an earlier run). */
  expectMonth?: string;
}

export class ForecastMonthMismatchError extends Error {
  constructor(readonly expected: string, readonly got: string) {
    super(
      `The forecast answer is for ${got || 'no month'}, not the report month ${expected}. It is an earlier run's file: ` +
        'treat the forecast as absent for this report.',
    );
    this.name = 'ForecastMonthMismatchError';
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A FCT-TRACK-01 answer (successful), as `mixshift intelligence run` writes it. */
export function isForecastTrackResponse(response: unknown): boolean {
  return isRec(response) && response.ok === true && response.service === 'forecasting' && response.kind === 'track';
}

/**
 * Role of a figure or derived id. Ordered: the first matching rule wins.
 * Exported for the tests; an id matching none is `null`.
 */
export function roleOfId(id: string): ForecastRole | null {
  if (!id.startsWith('forecast.')) return null;
  const MONTH = String.raw`\d{4}-\d{2}$`;
  const rules: Array<[RegExp, ForecastRole]> = [
    // The year-start forecast stands in for a plan nobody has recorded: internal only.
    [/\.expected\.year_start\.|actual_vs_year_start/, 'year_start'],
    // The current model, fitted with the month in it: what the app shows.
    [/(^|\.)(fit|projection)(\.|$)|actual_vs_projection|projection_vs_/, 'projection'],
    // Months still to come, each at the spend it stands on (incl. what each assumes about last year).
    [new RegExp(String.raw`\.projected\.|\.spend\.${MONTH}|\.range\.(lower|upper)\.[a-z]+\.${MONTH}|\.assumed_yoy\.[a-z]+\.${MONTH}`), 'outlook'],
    // What the model said before the report month closed, and what it assumed.
    [/\.expected\.|actual_vs_rolling|actual_vs_forecast|\.assumed_yoy\.[a-z]+\.month$|\.range\.(lower|upper)\.[a-z]+\.month$|\.tolerance\./, 'forecast'],
    // What the model is, how it moved, and the corrections it stands on.
    [/\.model\.|\.overlay\./, 'basis'],
    // What happened.
    [/\.actual\.|\.last_year\./, 'actual'],
  ];
  for (const [re, role] of rules) if (re.test(id)) return role;
  return null;
}

/** Role of a claim, by its id. */
export function roleOfClaim(id: string): ForecastRole | null {
  if (/projection_line$/.test(id)) return 'projection';
  if (/(operator_line|month_line)$/.test(id)) return 'forecast';
  if (/outlook$/.test(id)) return 'outlook';
  if (/basis$/.test(id)) return 'basis';
  return null;
}

const CLIENT_ROLES: ReadonlySet<ForecastRole> = new Set(['actual', 'forecast', 'outlook']);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function extractForecast(response: unknown, opts: ExtractForecastOptions = {}): ForecastFiguresDocument {
  if (!isForecastTrackResponse(response)) {
    throw new Error('Not a FCT-TRACK-01 answer (expected ok:true, service "forecasting", kind "track").');
  }
  const r = response as Rec;
  const metric = r.metric === 'units' ? 'units' : 'revenue';
  const month = str(r.month) ?? '';
  if (opts.expectMonth !== undefined && opts.expectMonth !== month) {
    throw new ForecastMonthMismatchError(opts.expectMonth, month);
  }
  let state: ForecastState = (['provided_current', 'stale', 'not_provided'] as const).find((s) => s === r.forecast_state) ?? 'not_provided';
  let reason = str(r.reason);
  const pub = isRec(r.published) ? r.published : null;
  const published =
    pub && num(pub.gateway_revision) !== null
      ? {
          at: str(pub.at) ?? '',
          by: str(pub.by) ?? '',
          producer: str(pub.producer) ?? 'app',
          gateway_revision: num(pub.gateway_revision)!,
          published_run_id: str(pub.published_run_id) ?? '',
          age_days: num(pub.age_days) ?? 0,
          document_version: num(pub.document_version),
          overlay_revisions: num(pub.overlay_revisions),
        }
      : null;
  const spendBasis = r.spend_basis === 'ads_plus_dsp' ? 'ads_plus_dsp' : r.spend_basis === 'ads_only' ? 'ads_only' : null;

  const doc: ForecastFiguresDocument = {
    schema_version: '2.0-draft',
    kind: 'forecast_figures',
    source: {
      insight: 'FCT-TRACK-01',
      metric,
      month,
      scope_id: str(r.scope_id),
      forecast_state: state,
      reason,
      friendly: str(r.friendly),
      spend_basis: spendBasis,
      ytd_runs_past_report_month: r.ytd_runs_past_report_month === true,
      unrecognised: [],
      published,
      attestation: '',
    },
    forecast: { state, report_month: month, metric },
    currency: null,
    caveat_registry: {},
    figures: [],
    derived: [],
    claims: [],
    sections: [],
    limitations: [],
  };

  const rd = isRec(r.report_data) ? r.report_data : null;
  if (state === 'provided_current' && rd) {
    const registry = isRec(rd.caveat_registry) ? (rd.caveat_registry as Record<string, CaveatRegistryEntry>) : {};
    const blocking = (keys: string[]) => keys.some((k) => registry[k]?.severity === 'blocking');
    const figures: ForecastFigure[] = [];
    for (const f of Array.isArray(rd.figures) ? rd.figures : []) {
      if (!isRec(f)) continue;
      const id = str(f.id) ?? '';
      const role = roleOfId(id);
      const caveats = strs(f.caveats);
      figures.push({
        id,
        label: str(f.label) ?? '',
        value: f.value as number,
        unit: str(f.unit) ?? '',
        basis: str(f.basis) ?? '',
        source_path: str(f.source_path) ?? '',
        caveats,
        confidence: 'published',
        forecast_role: (role ?? 'unclassified') as ForecastRole,
        client_safe: role !== null && CLIENT_ROLES.has(role) && !blocking(caveats),
        ...(num(f.precision) !== null ? { precision: num(f.precision)! } : {}),
        ...(f.population !== undefined ? { population: f.population } : {}),
      });
    }
    const safe = new Map(figures.map((f) => [f.id, f.client_safe]));
    const derived: ForecastDerived[] = [];
    for (const d of Array.isArray(rd.derived) ? rd.derived : []) {
      if (!isRec(d)) continue;
      const id = str(d.id) ?? '';
      const role = roleOfId(id);
      const inputs = strs(d.inputs);
      derived.push({
        id,
        label: str(d.label) ?? '',
        value: d.value as number,
        unit: str(d.unit) ?? '',
        basis: str(d.basis) ?? '',
        inputs,
        why_not_published: str(d.why_not_published) ?? '',
        forecast_role: (role ?? 'unclassified') as ForecastRole,
        client_safe: role !== null && CLIENT_ROLES.has(role) && inputs.length > 0 && inputs.every((i) => safe.get(i) === true),
      });
    }
    const claims: ForecastClaim[] = [];
    for (const c of Array.isArray(rd.claims) ? rd.claims : []) {
      if (!isRec(c)) continue;
      const id = str(c.id) ?? '';
      claims.push({
        id,
        kind: str(c.kind) ?? '',
        text: str(c.text) ?? '',
        figure_refs: strs(c.figure_refs),
        forecast_role: (roleOfClaim(id) ?? 'unclassified') as ForecastRole,
        ...(str(c.comparison_basis) ? { comparison_basis: str(c.comparison_basis)! } : {}),
      });
    }
    const unrecognised = [...figures, ...derived, ...claims]
      .filter((x) => (x.forecast_role as string) === 'unclassified')
      .map((x) => x.id);
    if (unrecognised.length > 0) {
      // FAIL CLOSED: an id we cannot place withholds the whole forecast.
      state = 'not_provided';
      reason = 'unrecognised_figures';
      doc.source.unrecognised = unrecognised;
    } else {
      doc.currency = str(rd.currency);
      doc.caveat_registry = registry;
      doc.figures = figures;
      doc.derived = derived;
      doc.claims = claims;
      for (const s of Array.isArray(rd.sections) ? rd.sections : []) {
        if (!isRec(s)) continue;
        doc.sections.push({
          id: str(s.id) ?? '',
          kind: 'forecast',
          audience: 'internal',
          figure_refs: strs(s.figure_refs),
          claim_refs: strs(s.claim_refs),
          caveats_rendered: strs(s.caveats_rendered),
          display_text: str(s.display_text) ?? '',
        });
      }
      doc.limitations = strs(r.limitations);
    }
  } else if (state === 'provided_current') {
    state = 'not_provided';
    reason = reason ?? 'no_report_data';
  }

  doc.forecast.state = state;
  doc.source.forecast_state = state;
  doc.source.reason = reason;
  doc.source.attestation =
    state === 'provided_current' && published
      ? `FCT-TRACK-01 ${metric} ${month}: published forecast vintage ${published.gateway_revision} (${published.published_run_id}), published ${published.at.slice(0, 10)}`
      : `FCT-TRACK-01 ${metric} ${month}: no forecast figures used (${reason ?? state})`;
  return doc;
}

const ROLES: ReadonlySet<string> = new Set(['actual', 'forecast', 'year_start', 'projection', 'outlook', 'basis']);

/** Invariants. Any finding means: treat the forecast as absent for this report. */
export function checkForecast(doc: ForecastFiguresDocument): ForecastCheckFinding[] {
  const findings: ForecastCheckFinding[] = [];
  const current = doc.forecast.state === 'provided_current';
  if (!current && (doc.figures.length || doc.derived.length || doc.claims.length || doc.sections.length || doc.limitations.length)) {
    findings.push({ rule: 'FORECAST-GATE', subject: doc.forecast.state, detail: 'a forecast that is not provided_current must carry no content' });
  }
  if (current && doc.figures.length === 0) {
    findings.push({ rule: 'FORECAST-GATE', subject: 'provided_current', detail: 'a current forecast arrived with no figures' });
  }
  for (const id of doc.source.unrecognised) {
    findings.push({ rule: 'FORECAST-ROLE', subject: id, detail: 'id not recognised; the forecast was withheld' });
  }
  const seen = new Set<string>();
  for (const x of [...doc.figures, ...doc.derived]) {
    if (seen.has(x.id)) findings.push({ rule: 'FORECAST-DUPLICATE', subject: x.id, detail: 'id appears twice' });
    seen.add(x.id);
  }
  const role = new Map<string, ForecastRole>([...doc.figures, ...doc.derived].map((x) => [x.id, x.forecast_role]));
  const claimIds = new Set(doc.claims.map((c) => c.id));
  const otherMetric = doc.forecast.metric === 'units' ? '.sales.' : '.units.';
  for (const f of doc.figures) {
    for (const k of ['id', 'label', 'unit', 'basis', 'source_path'] as const) {
      if (!f[k]) findings.push({ rule: 'REQUIRED', subject: f.id || '(no id)', detail: `missing ${k}` });
    }
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) findings.push({ rule: 'NUMERIC', subject: f.id, detail: 'value is not a finite number' });
    if (!ROLES.has(f.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: f.id, detail: 'id not recognised' });
    if (f.id.includes(otherMetric)) findings.push({ rule: 'FORECAST-METRIC', subject: f.id, detail: `a ${doc.forecast.metric} document carries the other metric's figure` });
    for (const c of f.caveats) if (!doc.caveat_registry[c]) findings.push({ rule: 'FORECAST-TRACE', subject: f.id, detail: `caveat ${c} is not in the registry` });
  }
  for (const d of doc.derived) {
    if (typeof d.value !== 'number' || !Number.isFinite(d.value)) findings.push({ rule: 'NUMERIC', subject: d.id, detail: 'value is not a finite number' });
    if (!d.why_not_published) findings.push({ rule: 'REQUIRED', subject: d.id, detail: 'missing why_not_published' });
    if (!ROLES.has(d.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: d.id, detail: 'derived id not recognised' });
    for (const i of d.inputs) if (!role.has(i)) findings.push({ rule: 'FORECAST-TRACE', subject: d.id, detail: `input ${i} is not a figure here` });
  }
  for (const c of doc.claims) {
    if (!ROLES.has(c.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: c.id, detail: 'claim id not recognised' });
    for (const ref of c.figure_refs) {
      if (!role.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: c.id, detail: `figure ${ref} is not here` });
      // A forecast claim that cites the current model's fit is the confusion the roles exist to stop.
      else if (c.forecast_role === 'forecast' && role.get(ref) === 'projection') {
        findings.push({ rule: 'FORECAST-CLAIM-BASIS', subject: c.id, detail: `a forecast claim cites the projection figure ${ref}` });
      }
    }
  }
  for (const s of doc.sections) {
    for (const ref of s.figure_refs) if (!role.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `figure ${ref} is not here` });
    for (const ref of s.claim_refs) if (!claimIds.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `claim ${ref} is not here` });
    for (const c of s.caveats_rendered) if (!doc.caveat_registry[c]) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `caveat ${c} is not in the registry` });
  }
  // The report contract's own rules (blocking caveats rendered where quoted,
  // no causal wording in non-causal claims, derived figures traced) over the
  // document as a report-data fragment.
  if (current && doc.figures.length > 0) {
    const asReport: ReportDataDocument = {
      schema_version: '2.0-draft',
      currency: doc.currency ?? undefined,
      figures: doc.figures as unknown as ReportDataDocument['figures'],
      derived: doc.derived as unknown as ReportDataDocument['derived'],
      caveat_registry: doc.caveat_registry,
      claims: doc.claims as unknown as ReportDataDocument['claims'],
      sections: doc.sections as unknown as ReportDataDocument['sections'],
    };
    for (const f of validateReportData(asReport)) {
      if ((f.severity ?? 'error') === 'error') {
        findings.push({ rule: 'FORECAST-CONTRACT', subject: f.subject, detail: `${f.rule}: ${f.detail}` });
      }
    }
  }
  return findings;
}
