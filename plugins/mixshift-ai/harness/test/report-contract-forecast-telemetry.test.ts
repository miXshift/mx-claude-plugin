import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { checkForecast, extractForecast, ForecastMonthMismatchError } from '../src/lib/report-contract/forecast';
import {
  classifyForecastError,
  classifyWithheldForecast,
  findingRules,
  forecastErrorEvent,
  forecastExtractEvents,
  forecastExtractedPayload,
  notAForecastAnswerEvent,
} from '../src/lib/report-contract/forecast-telemetry';
import { UserFacingError } from '../src/lib/errors';

/**
 * The Report Max forecast events built from REAL FCT-TRACK-01 answers
 * (testdata/fct-track-01.*.json, the same fixtures the extractor is tested on).
 * What matters: the counts are right, a stale or absent forecast is not a
 * failure, a withheld forecast is classified, and no figure value or service
 * text reaches a payload.
 */

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../testdata/fct-track-01.${name}.json`, import.meta.url)), 'utf8'));

const ctx = { checkRan: true, expectMonth: '2026-02' };

/** Every number in the answer's report data, to prove none reaches a payload. */
function figureValues(answer: { report_data: { figures: Array<{ value: unknown }>; derived?: Array<{ value: unknown }> } }): Set<number> {
  const values = new Set<number>();
  for (const x of [...answer.report_data.figures, ...(answer.report_data.derived ?? [])]) {
    if (typeof x.value === 'number' && Math.abs(x.value) > 1000) values.add(x.value);
  }
  return values;
}

describe('report.forecast_extracted payload', () => {
  it('a current forecast: identifying fields and counts only', () => {
    const answer = load('revenue.current');
    const doc = extractForecast(answer, { expectMonth: '2026-02' });
    const findings = checkForecast(doc);
    const payload = forecastExtractedPayload(doc, findings, ctx);
    const clientSafe = [...doc.figures, ...doc.derived].filter((x) => x.client_safe).length;
    expect(payload).toEqual({
      state: 'provided_current',
      metric: 'revenue',
      month: '2026-02',
      scope_id: 'src:demo:1',
      vintage: 3,
      figures: doc.figures.length,
      derived: doc.derived.length,
      claims: doc.claims.length,
      sections: doc.sections.length,
      client_safe: clientSafe,
      check_findings: 0,
      expect_month: true,
    });
    expect(doc.figures.length).toBeGreaterThan(50);
    expect(clientSafe).toBeGreaterThan(0);
    const json = JSON.stringify(payload);
    for (const v of figureValues(answer)) expect(json).not.toContain(String(v));
  });

  it('check_findings only when --check ran; expect_month says whether it was given', () => {
    const doc = extractForecast(load('never-published'));
    const payload = forecastExtractedPayload(doc, [], { checkRan: false });
    expect(payload).not.toHaveProperty('check_findings');
    expect(payload).toMatchObject({ state: 'not_provided', reason: 'never_published', figures: 0, expect_month: false });
  });

  it('stale and never-published are the quiet path: one extracted event, no failure', () => {
    for (const [name, state, reason] of [
      ['revenue.stale', 'stale', 'report_month_not_closed'],
      ['never-published', 'not_provided', 'never_published'],
    ] as const) {
      const doc = extractForecast(load(name));
      const findings = checkForecast(doc);
      expect(classifyWithheldForecast(doc, findings, ctx)).toBeUndefined();
      const events = forecastExtractEvents(doc, findings, { ...ctx, durationMs: 12 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_name: 'report.forecast_extracted',
        outcome: 'ok',
        duration_ms: 12,
        payload: { state, reason, figures: 0, derived: 0, claims: 0, sections: 0, client_safe: 0, check_findings: 0 },
      });
      expect(JSON.stringify(events)).not.toContain('friendly');
      expect(JSON.stringify(events)).not.toContain('published forecast');
    }
  });
});

describe('report.forecast_failed classification', () => {
  it('an id the extractor cannot place: unrecognised_figures, with the ids (contract drift evidence)', () => {
    const answer = load('revenue.current');
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.something_new.sales.month' });
    const doc = extractForecast(answer);
    const findings = checkForecast(doc);
    const events = forecastExtractEvents(doc, findings, ctx);
    expect(events.map((e) => e.event_name)).toEqual(['report.forecast_extracted', 'report.forecast_failed']);
    expect(events[0]!.payload).toMatchObject({ state: 'not_provided', reason: 'unrecognised_figures', figures: 0 });
    expect(events[1]).toMatchObject({
      outcome: 'failed',
      error_class: 'unrecognised_figures',
      payload: {
        state: 'not_provided',
        reason: 'unrecognised_figures',
        unrecognised_count: 1,
        unrecognised: ['forecast.something_new'],
        rules: ['FORECAST-ROLE'],
        expect_month: true,
      },
    });
    for (const v of figureValues(answer)) expect(JSON.stringify(events)).not.toContain(String(v));
  });

  it('sends only the figure type of each unrecognised id, deduplicated and capped at 10, while counting all of them', () => {
    const answer = load('revenue.current');
    for (let i = 0; i < 14; i++) answer.report_data.figures.push({ ...answer.report_data.figures[0], id: `forecast.new_${i}.sales.month` });
    const withheld = classifyWithheldForecast(extractForecast(answer), [], { checkRan: false });
    expect(withheld!.payload.unrecognised_count).toBe(14);
    expect(withheld!.payload.unrecognised).toHaveLength(10);
    expect(withheld!.payload.unrecognised).toContain('forecast.new_0');
    const twice = load('revenue.current');
    for (const m of ['month', 'ytd']) twice.report_data.figures.push({ ...twice.report_data.figures[0], id: `forecast.same.sales.${m}` });
    const one = classifyWithheldForecast(extractForecast(twice), [], { checkRan: false });
    expect(one!.payload).toMatchObject({ unrecognised_count: 2, unrecognised: ['forecast.same'] });
    expect(withheld!.payload).not.toHaveProperty('rules');
  });

  it('--check findings on a current forecast: check_findings, with the unique rule ids', () => {
    const answer = load('revenue.current');
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.actual.units.ytd' });
    for (const s of answer.report_data.sections) s.caveats_rendered = [];
    const doc = extractForecast(answer);
    const findings = checkForecast(doc);
    const withheld = classifyWithheldForecast(doc, findings, ctx)!;
    expect(withheld.errorClass).toBe('check_findings');
    expect(withheld.payload.check_findings).toBe(findings.length);
    const rules = withheld.payload.rules as string[];
    expect(rules).toContain('FORECAST-METRIC');
    expect(rules.some((r) => r.startsWith('FORECAST-CONTRACT:'))).toBe(true);
    expect(new Set(rules).size).toBe(rules.length);
    expect(withheld.payload).toMatchObject({ state: 'provided_current', vintage: 3 });
  });

  it('findingRules keeps rule ids only, unique, at most 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ rule: 'FORECAST-CONTRACT' as const, subject: 'x', detail: `RULE-${i}: some words` }));
    expect(findingRules(many)).toHaveLength(20);
    expect(findingRules([{ rule: 'FORECAST-CONTRACT', subject: 's', detail: 'no rule prefix here' }])).toEqual(['FORECAST-CONTRACT']);
  });

  it('a month mismatch, from the error or its user-facing form', () => {
    const mismatch = new ForecastMonthMismatchError('2026-09', '2026-02');
    expect(classifyForecastError(mismatch)).toEqual({ errorClass: 'forecast_month_mismatch' });
    expect(classifyForecastError(new UserFacingError(mismatch.message, 'report_forecast_month_mismatch'))).toEqual({
      errorClass: 'forecast_month_mismatch',
    });
    const event = forecastErrorEvent(load('revenue.current'), mismatch, { checkRan: true, expectMonth: '2026-09' });
    expect(event).toMatchObject({
      event_name: 'report.forecast_failed',
      outcome: 'failed',
      error_class: 'forecast_month_mismatch',
      payload: { state: 'provided_current', metric: 'revenue', month: '2026-02', expected_month: '2026-09', scope_id: 'src:demo:1', vintage: 3, expect_month: true },
    });
    expect(JSON.stringify(event)).not.toContain('earlier run');
  });

  it('any other error: extract_error, with a cause label and never the message', () => {
    expect(classifyForecastError(new UserFacingError('Could not write /secret/path: EACCES', 'report_out_unwritable'))).toEqual({
      errorClass: 'extract_error',
      cause: 'report_out_unwritable',
    });
    const event = forecastErrorEvent(load('never-published'), new TypeError('x is undefined at /home/someone'), { checkRan: false });
    expect(event).toMatchObject({ error_class: 'extract_error', payload: { cause: 'typeerror', reason: 'never_published', expect_month: false } });
    expect(JSON.stringify(event)).not.toContain('/home/someone');
    expect(classifyForecastError('a string')).toEqual({ errorClass: 'extract_error' });
  });

  it('not_a_forecast_answer only when the forecast path was asked for', () => {
    const envelope = { ok: true, meta: { insightId: 'INS-MONTHLY-01' } };
    expect(notAForecastAnswerEvent(envelope, { checkRan: true })).toBeUndefined();
    expect(notAForecastAnswerEvent(envelope, { checkRan: true, expectMonth: '2026-02' })).toMatchObject({
      event_name: 'report.forecast_failed',
      error_class: 'not_a_forecast_answer',
      payload: { expect_month: true, expected_month: '2026-02', ok: true },
    });
    const baseline = { ok: true, service: 'forecasting', kind: 'baseline', scope_id: 'src:demo:1', metric: 'revenue' };
    expect(notAForecastAnswerEvent(baseline, { checkRan: false })).toMatchObject({
      error_class: 'not_a_forecast_answer',
      payload: { expect_month: false, service: 'forecasting', kind: 'baseline', scope_id: 'src:demo:1', metric: 'revenue' },
    });
  });
});
