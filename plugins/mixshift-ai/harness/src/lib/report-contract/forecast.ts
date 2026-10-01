/**
 * Forecast figures for the monthly report, from a FCT-TRACK-01 answer.
 *
 * FCT-TRACK-01 serves the forecast the MixShift forecasting app published,
 * already projected into the report's own figure contract: figures, derived
 * figures, claims, sections and a caveat registry for one report month, plus
 * `forecast_state`. This module turns that answer into a figures document the
 * skill can compose like any other extracted document, with two guarantees:
 *
 *   1. THE GATE. Unless `forecast_state` is `provided_current`, the document
 *      carries NO figure, claim, section or caveat, only the state and the
 *      reason. A report built without a current forecast is therefore exactly
 *      the report it would have been without the forecast step: nothing
 *      forecast-flavoured can leak into it from here.
 *   2. ROLES. A closed month has two expectations that must never be confused
 *      (MixShift ruling, 2026-09-30): the FORECAST, what the model said before
 *      the month closed (the only one a beat or miss is quoted against), and
 *      the PROJECTION, the current model's fit with that month included (what
 *      the forecasting app's Table shows). Every figure, derived figure and
 *      claim is tagged with its role; an id this module cannot place is a
 *      CHECK finding, so a change in the service's ids fails loudly instead of
 *      letting a projection reach a client brief under the forecast's name.
 *
 * Sections are tagged `kind: 'forecast'` (the renderer's forecast gate) and
 * `audience: 'internal'`: their prose leads with the projection, the way the
 * forecasting app reads, which is the analyst's view, not the client's.
 */

import type { CaveatRegistryEntry } from './validate.js';

export type ForecastRole = 'actual' | 'forecast' | 'projection' | 'outlook' | 'basis';
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
    /** The one line the run record and the review packet cite as the forecast's source. */
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

export type ForecastCheckRule = 'FORECAST-ROLE' | 'FORECAST-GATE' | 'FORECAST-TRACE' | 'FORECAST-METRIC' | 'REQUIRED' | 'NUMERIC';

export interface ForecastCheckFinding {
  rule: ForecastCheckRule;
  subject: string;
  detail: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A FCT-TRACK-01 answer (successful), as `mixshift intelligence run` writes it. */
export function isForecastTrackResponse(response: unknown): boolean {
  return isRec(response) && response.ok === true && response.service === 'forecasting' && response.kind === 'track';
}

/**
 * Role of a figure or derived id. Ordered: the first matching rule wins.
 * Exported for the tests; an id matching none is `null` (a CHECK finding).
 */
export function roleOfId(id: string): ForecastRole | null {
  if (!id.startsWith('forecast.')) return null;
  const rules: Array<[RegExp, ForecastRole]> = [
    // The current model, fitted with the month in it: what the app shows.
    [/(^|\.)(fit|projection)(\.|$)|actual_vs_projection|projection_vs_/, 'projection'],
    // What the model said before the month closed, and what it assumed.
    [/\.expected\.|actual_vs_rolling|actual_vs_forecast|actual_vs_year_start|\.assumed_yoy\.|\.range\.(lower|upper)\.[a-z]+\.month$|\.tolerance\./, 'forecast'],
    // Months still to come, each at the spend it stands on.
    [/\.projected\.|\.spend\.\d{4}-\d{2}$|\.range\.(lower|upper)\.[a-z]+\.\d{4}-\d{2}$/, 'outlook'],
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

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function extractForecast(response: unknown): ForecastFiguresDocument {
  if (!isForecastTrackResponse(response)) {
    throw new Error('Not a FCT-TRACK-01 answer (expected ok:true, service "forecasting", kind "track").');
  }
  const r = response as Rec;
  const metric = r.metric === 'units' ? 'units' : 'revenue';
  const month = str(r.month) ?? '';
  const state = (['provided_current', 'stale', 'not_provided'] as const).find((s) => s === r.forecast_state) ?? 'not_provided';
  const pub = isRec(r.published) ? r.published : null;
  const published = pub && num(pub.gateway_revision) !== null
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
  const attestation = published
    ? `FCT-TRACK-01 ${metric} ${month}: published forecast vintage ${published.gateway_revision} (${published.published_run_id}), published ${published.at.slice(0, 10)}`
    : `FCT-TRACK-01 ${metric} ${month}: no forecast served (${str(r.reason) ?? state})`;
  const spendBasis = r.spend_basis === 'ads_plus_dsp' ? 'ads_plus_dsp' : r.spend_basis === 'ads_only' ? 'ads_only' : null;
  const limitations = Array.isArray(r.limitations) ? r.limitations.filter((l): l is string => typeof l === 'string') : [];

  const doc: ForecastFiguresDocument = {
    schema_version: '2.0-draft',
    kind: 'forecast_figures',
    source: {
      insight: 'FCT-TRACK-01',
      metric,
      month,
      scope_id: str(r.scope_id),
      forecast_state: state,
      reason: str(r.reason),
      friendly: str(r.friendly),
      spend_basis: spendBasis,
      published,
      attestation,
    },
    forecast: { state, report_month: month, metric },
    currency: null,
    caveat_registry: {},
    figures: [],
    derived: [],
    claims: [],
    sections: [],
    limitations,
  };

  // THE GATE: nothing forecast-flavoured leaves this module unless current.
  const rd = isRec(r.report_data) ? r.report_data : null;
  if (state !== 'provided_current' || !rd) return doc;

  doc.currency = str(rd.currency);
  doc.caveat_registry = isRec(rd.caveat_registry) ? (rd.caveat_registry as Record<string, CaveatRegistryEntry>) : {};
  for (const f of Array.isArray(rd.figures) ? rd.figures : []) {
    if (!isRec(f)) continue;
    const id = str(f.id) ?? '';
    doc.figures.push({
      id,
      label: str(f.label) ?? '',
      value: f.value as number,
      unit: str(f.unit) ?? '',
      basis: str(f.basis) ?? '',
      source_path: str(f.source_path) ?? '',
      caveats: Array.isArray(f.caveats) ? (f.caveats as string[]) : [],
      confidence: 'published',
      forecast_role: (roleOfId(id) ?? 'unclassified') as ForecastRole,
      ...(num(f.precision) !== null ? { precision: num(f.precision)! } : {}),
      ...(f.population !== undefined ? { population: f.population } : {}),
    });
  }
  for (const d of Array.isArray(rd.derived) ? rd.derived : []) {
    if (!isRec(d)) continue;
    const id = str(d.id) ?? '';
    doc.derived.push({
      id,
      label: str(d.label) ?? '',
      value: d.value as number,
      unit: str(d.unit) ?? '',
      basis: str(d.basis) ?? '',
      inputs: Array.isArray(d.inputs) ? (d.inputs as string[]) : [],
      why_not_published: str(d.why_not_published) ?? '',
      forecast_role: (roleOfId(id) ?? 'unclassified') as ForecastRole,
    });
  }
  for (const c of Array.isArray(rd.claims) ? rd.claims : []) {
    if (!isRec(c)) continue;
    const id = str(c.id) ?? '';
    doc.claims.push({
      id,
      kind: str(c.kind) ?? '',
      text: str(c.text) ?? '',
      figure_refs: Array.isArray(c.figure_refs) ? (c.figure_refs as string[]) : [],
      forecast_role: (roleOfClaim(id) ?? 'unclassified') as ForecastRole,
      ...(str(c.comparison_basis) ? { comparison_basis: str(c.comparison_basis)! } : {}),
    });
  }
  for (const s of Array.isArray(rd.sections) ? rd.sections : []) {
    if (!isRec(s)) continue;
    doc.sections.push({
      id: str(s.id) ?? '',
      kind: 'forecast',
      audience: 'internal',
      figure_refs: Array.isArray(s.figure_refs) ? (s.figure_refs as string[]) : [],
      claim_refs: Array.isArray(s.claim_refs) ? (s.claim_refs as string[]) : [],
      caveats_rendered: Array.isArray(s.caveats_rendered) ? (s.caveats_rendered as string[]) : [],
      display_text: str(s.display_text) ?? '',
    });
  }
  return doc;
}

const ROLES: ReadonlySet<string> = new Set(['actual', 'forecast', 'projection', 'outlook', 'basis']);

/** Invariants. Any finding means nothing downstream should consume the document. */
export function checkForecast(doc: ForecastFiguresDocument): ForecastCheckFinding[] {
  const findings: ForecastCheckFinding[] = [];
  const current = doc.forecast.state === 'provided_current';
  if (!current && (doc.figures.length || doc.derived.length || doc.claims.length || doc.sections.length)) {
    findings.push({ rule: 'FORECAST-GATE', subject: doc.forecast.state, detail: 'a forecast that is not provided_current must carry no figures, claims or sections' });
  }
  if (current && doc.figures.length === 0) {
    findings.push({ rule: 'FORECAST-GATE', subject: 'provided_current', detail: 'a current forecast arrived with no figures' });
  }
  const ids = new Set<string>([...doc.figures.map((f) => f.id), ...doc.derived.map((d) => d.id)]);
  const claimIds = new Set(doc.claims.map((c) => c.id));
  const otherMetric = doc.forecast.metric === 'units' ? '.sales.' : '.units.';
  for (const f of doc.figures) {
    for (const k of ['id', 'label', 'unit', 'basis', 'source_path'] as const) {
      if (!f[k]) findings.push({ rule: 'REQUIRED', subject: f.id || '(no id)', detail: `missing ${k}` });
    }
    if (typeof f.value !== 'number' || !Number.isFinite(f.value)) findings.push({ rule: 'NUMERIC', subject: f.id, detail: 'value is not a finite number' });
    if (!ROLES.has(f.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: f.id, detail: 'id not recognised as actual, forecast, projection, outlook or basis' });
    if (f.id.includes(otherMetric)) findings.push({ rule: 'FORECAST-METRIC', subject: f.id, detail: `a ${doc.forecast.metric} document carries the other metric's figure` });
    for (const c of f.caveats) if (!doc.caveat_registry[c]) findings.push({ rule: 'FORECAST-TRACE', subject: f.id, detail: `caveat ${c} is not in the registry` });
  }
  for (const d of doc.derived) {
    if (!ROLES.has(d.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: d.id, detail: 'derived id not recognised' });
    for (const i of d.inputs) if (!ids.has(i)) findings.push({ rule: 'FORECAST-TRACE', subject: d.id, detail: `input ${i} is not a figure here` });
  }
  for (const c of doc.claims) {
    if (!ROLES.has(c.forecast_role)) findings.push({ rule: 'FORECAST-ROLE', subject: c.id, detail: 'claim id not recognised' });
    for (const ref of c.figure_refs) if (!ids.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: c.id, detail: `figure ${ref} is not here` });
  }
  for (const s of doc.sections) {
    for (const ref of s.figure_refs) if (!ids.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `figure ${ref} is not here` });
    for (const ref of s.claim_refs) if (!claimIds.has(ref)) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `claim ${ref} is not here` });
    for (const c of s.caveats_rendered) if (!doc.caveat_registry[c]) findings.push({ rule: 'FORECAST-TRACE', subject: s.id, detail: `caveat ${c} is not in the registry` });
  }
  return findings;
}
