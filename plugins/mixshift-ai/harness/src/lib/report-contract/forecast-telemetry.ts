/**
 * Telemetry for the Report Max forecast path: what `mixshift report extract`
 * made of a FCT-TRACK-01 answer, and whether the forecast was withheld for a
 * defect. Pure: these functions build the events, `commands/report.ts` emits
 * them through track().
 *
 *   report.forecast_extracted  once per extraction of a FCT-TRACK-01 answer,
 *                              whatever its state: a stale or not-provided
 *                              forecast is the expected quiet path, NOT a failure.
 *   report.forecast_failed     the forecast was withheld for a defect (an id the
 *                              extractor could not place, --check findings) or the
 *                              forecast path errored (month mismatch, not a
 *                              TRACK answer where one was expected, anything else).
 *
 * PRIVACY: payloads carry the state and reason labels, metric, report month,
 * scope id, served vintage, COUNTS of what was extracted, check rule ids, and
 * (when the forecast was withheld for ids it could not place) up to 10 of those
 * ids: they are the figure contract's own ids, the evidence of contract drift.
 * Never a figure value, label, claim or section text, nor the service's free
 * text (`friendly`, limitations, error messages).
 */

import { boundedLabel, boundedMonth, boundedScopeId } from '../intelligence/forecast-answer.js';
import { UserFacingError } from '../errors.js';
import { EventName, type TrackInput } from '../telemetry/events.js';
import {
  ForecastMonthMismatchError,
  type ForecastCheckFinding,
  type ForecastFiguresDocument,
} from './forecast.js';

export type ForecastFailureClass =
  | 'forecast_month_mismatch'
  | 'unrecognised_figures'
  | 'check_findings'
  | 'not_a_forecast_answer'
  | 'extract_error';

export interface ForecastExtractTelemetryContext {
  /** `--check` ran. */
  checkRan: boolean;
  /** `--expect-month` as given; undefined when it was not. */
  expectMonth?: string;
  durationMs?: number;
}

const MAX_RULES = 20;
const MAX_UNRECOGNISED = 10;
const RULE_RE = /^[A-Z0-9][A-Z0-9:-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function compact(o: Rec): Rec {
  const out: Rec = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

function vintageOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : undefined;
}

/** Which forecast this was about, from the extracted document. */
function docIdentity(doc: ForecastFiguresDocument): Rec {
  return compact({
    state: boundedLabel(doc.forecast.state),
    reason: boundedLabel(doc.source.reason),
    metric: boundedLabel(doc.forecast.metric),
    month: boundedMonth(doc.forecast.report_month),
    scope_id: boundedScopeId(doc.source.scope_id),
    vintage: vintageOf(doc.source.published?.gateway_revision),
  });
}

/** Which forecast this was about, from the raw answer (when no document was made). */
function answerIdentity(response: unknown): Rec {
  if (!isRec(response)) return {};
  const pub = isRec(response.published) ? response.published : undefined;
  return compact({
    state: boundedLabel(response.forecast_state),
    reason: boundedLabel(response.reason),
    metric: boundedLabel(response.metric),
    month: boundedMonth(response.month),
    scope_id: boundedScopeId(response.scope_id),
    vintage: vintageOf(pub?.gateway_revision),
  });
}

/** Unique rule ids of the findings (a report-contract break as `FORECAST-CONTRACT:<rule>`), max 20. */
export function findingRules(findings: readonly ForecastCheckFinding[]): string[] {
  const rules = new Set<string>();
  for (const f of findings) {
    let rule: string = f.rule;
    if (f.rule === 'FORECAST-CONTRACT') {
      const sub = /^([A-Z][A-Z0-9-]{0,30}):/.exec(f.detail)?.[1];
      if (sub) rule = `${f.rule}:${sub}`;
    }
    if (RULE_RE.test(rule)) rules.add(rule);
    if (rules.size >= MAX_RULES) break;
  }
  return [...rules];
}

/** Payload of `report.forecast_extracted`: identifying fields and counts only. */
export function forecastExtractedPayload(
  doc: ForecastFiguresDocument,
  findings: readonly ForecastCheckFinding[],
  ctx: ForecastExtractTelemetryContext,
): Rec {
  const clientSafe =
    doc.figures.filter((f) => f.client_safe === true).length +
    doc.derived.filter((d) => d.client_safe === true).length;
  return {
    ...docIdentity(doc),
    figures: doc.figures.length,
    derived: doc.derived.length,
    claims: doc.claims.length,
    sections: doc.sections.length,
    client_safe: clientSafe,
    ...(ctx.checkRan ? { check_findings: findings.length } : {}),
    expect_month: ctx.expectMonth !== undefined,
  };
}

/**
 * Whether an extracted forecast was withheld for a defect, and the
 * `report.forecast_failed` classification when it was. An id the extractor
 * could not place wins over check findings (it causes FORECAST-ROLE findings
 * of its own). Undefined when nothing is wrong: a stale or not-provided
 * forecast is the expected quiet path.
 */
export function classifyWithheldForecast(
  doc: ForecastFiguresDocument,
  findings: readonly ForecastCheckFinding[],
  ctx: ForecastExtractTelemetryContext,
): { errorClass: ForecastFailureClass; payload: Rec } | undefined {
  const unrecognised = doc.source.unrecognised;
  if (unrecognised.length === 0 && findings.length === 0) return undefined;
  const payload: Rec = { ...docIdentity(doc), expect_month: ctx.expectMonth !== undefined };
  if (unrecognised.length > 0) {
    payload.unrecognised_count = unrecognised.length;
    // Only the figure TYPE (first two dot segments, e.g. `forecast.something_new`),
    // deduplicated: enough to name the contract drift, never a value or an item.
    payload.unrecognised = [
      ...new Set(unrecognised.filter((id) => ID_RE.test(id)).map((id) => id.split('.').slice(0, 2).join('.'))),
    ].slice(0, MAX_UNRECOGNISED);
  }
  if (findings.length > 0) {
    payload.check_findings = findings.length;
    payload.rules = findingRules(findings);
  }
  return { errorClass: unrecognised.length > 0 ? 'unrecognised_figures' : 'check_findings', payload };
}

/** The events one successful extraction of a FCT-TRACK-01 answer emits (one or two). */
export function forecastExtractEvents(
  doc: ForecastFiguresDocument,
  findings: readonly ForecastCheckFinding[],
  ctx: ForecastExtractTelemetryContext,
): TrackInput[] {
  const events: TrackInput[] = [
    {
      event_name: EventName.ReportForecastExtracted,
      outcome: 'ok',
      ...(ctx.durationMs !== undefined ? { duration_ms: ctx.durationMs } : {}),
      payload: forecastExtractedPayload(doc, findings, ctx),
    },
  ];
  const withheld = classifyWithheldForecast(doc, findings, ctx);
  if (withheld) {
    events.push({
      event_name: EventName.ReportForecastFailed,
      outcome: 'failed',
      error_class: withheld.errorClass,
      ...(ctx.durationMs !== undefined ? { duration_ms: ctx.durationMs } : {}),
      payload: withheld.payload,
    });
  }
  return events;
}

/** Classify an error thrown on the forecast path of `report extract`. */
export function classifyForecastError(err: unknown): { errorClass: ForecastFailureClass; cause?: string } {
  if (
    err instanceof ForecastMonthMismatchError ||
    (err instanceof UserFacingError && err.errorClass === 'report_forecast_month_mismatch')
  ) {
    return { errorClass: 'forecast_month_mismatch' };
  }
  const cause =
    err instanceof UserFacingError ? boundedLabel(err.errorClass) : err instanceof Error ? boundedLabel(err.name) : undefined;
  return { errorClass: 'extract_error', ...(cause ? { cause } : {}) };
}

/** `report.forecast_failed` for an error thrown while extracting a FCT-TRACK-01 answer. */
export function forecastErrorEvent(
  response: unknown,
  err: unknown,
  ctx: ForecastExtractTelemetryContext,
): TrackInput {
  const { errorClass, cause } = classifyForecastError(err);
  return {
    event_name: EventName.ReportForecastFailed,
    outcome: 'failed',
    error_class: errorClass,
    ...(ctx.durationMs !== undefined ? { duration_ms: ctx.durationMs } : {}),
    payload: compact({
      ...answerIdentity(response),
      expect_month: ctx.expectMonth !== undefined,
      expected_month: errorClass === 'forecast_month_mismatch' ? boundedMonth(ctx.expectMonth) : undefined,
      cause,
    }),
  };
}

/**
 * `report.forecast_failed` (not_a_forecast_answer) when the forecast path was
 * asked for, by `--expect-month` (a FCT-TRACK-01-only option) or by handing in
 * another forecasting answer, but the file is not a FCT-TRACK-01 answer.
 * Undefined when the forecast path was not asked for (an ordinary extraction).
 */
export function notAForecastAnswerEvent(
  response: unknown,
  ctx: ForecastExtractTelemetryContext,
): TrackInput | undefined {
  const forecasting = isRec(response) && response.service === 'forecasting';
  if (ctx.expectMonth === undefined && !forecasting) return undefined;
  const r = isRec(response) ? response : {};
  return {
    event_name: EventName.ReportForecastFailed,
    outcome: 'failed',
    error_class: 'not_a_forecast_answer',
    ...(ctx.durationMs !== undefined ? { duration_ms: ctx.durationMs } : {}),
    payload: compact({
      expect_month: ctx.expectMonth !== undefined,
      expected_month: boundedMonth(ctx.expectMonth),
      service: boundedLabel(r.service),
      kind: boundedLabel(r.kind),
      ok: typeof r.ok === 'boolean' ? r.ok : undefined,
      metric: boundedLabel(r.metric),
      month: boundedMonth(r.month),
      scope_id: boundedScopeId(r.scope_id),
    }),
  };
}
