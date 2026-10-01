import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  checkForecast,
  extractForecast,
  isForecastTrackResponse,
  roleOfClaim,
  roleOfId,
} from '../src/lib/report-contract/forecast';

/**
 * The forecast extractor over REAL FCT-TRACK-01 answers: testdata/fct-track-01.*.json
 * were produced by the service's own entry code over the forecasting contract's
 * worked demo document (revenue and units for a closed month, the same scope for
 * a month after the last closed one, and a scope never published).
 */

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../testdata/fct-track-01.${name}.json`, import.meta.url)), 'utf8'));

describe('forecast extractor', () => {
  it('recognises a FCT-TRACK-01 answer and nothing else', () => {
    expect(isForecastTrackResponse(load('revenue.current'))).toBe(true);
    expect(isForecastTrackResponse({ ok: true, service: 'attribution', kind: 'track' })).toBe(false);
    expect(isForecastTrackResponse({ ok: false, kind: 'unknown_insight' })).toBe(false);
    expect(() => extractForecast({ ok: true })).toThrow(/Not a FCT-TRACK-01 answer/);
  });

  it('a current forecast: every figure, derived figure and claim has a role, sections are internal forecast sections, CHECK passes', () => {
    for (const name of ['revenue.current', 'units.current']) {
      const doc = extractForecast(load(name));
      expect(doc.forecast.state).toBe('provided_current');
      expect(doc.figures.length).toBeGreaterThan(50);
      expect(checkForecast(doc)).toEqual([]);
      const roles = new Set([...doc.figures, ...doc.derived, ...doc.claims].map((x) => x.forecast_role));
      expect([...roles].sort()).toEqual(['actual', 'basis', 'forecast', 'outlook', 'projection']);
      expect(doc.sections.length).toBeGreaterThan(0);
      for (const s of doc.sections) {
        expect(s.kind).toBe('forecast');
        expect(s.audience).toBe('internal');
      }
      expect(doc.source.attestation).toMatch(/published forecast vintage 3 \(7d1f0c2e-[0-9a-f-]+\), published 2026-09-30/);
      expect(doc.currency).toBe('USD');
    }
  });

  it('THE GATE: a stale or unpublished forecast carries nothing forecast-flavoured', () => {
    for (const [name, state, reason] of [
      ['revenue.stale', 'stale', null],
      ['never-published', 'not_provided', 'never_published'],
    ] as const) {
      const doc = extractForecast(load(name));
      expect(doc.forecast.state).toBe(state);
      expect(doc.source.reason).toBe(reason);
      expect(doc.figures).toEqual([]);
      expect(doc.derived).toEqual([]);
      expect(doc.claims).toEqual([]);
      expect(doc.sections).toEqual([]);
      expect(doc.caveat_registry).toEqual({});
      expect(checkForecast(doc)).toEqual([]);
    }
  });

  it('the forecast and the projection are never confused', () => {
    const doc = extractForecast(load('revenue.current'));
    const role = (id: string) => doc.figures.find((f) => f.id === id)?.forecast_role ?? doc.derived.find((d) => d.id === id)?.forecast_role;
    // The current model's fit with the month in it: what the app shows.
    expect(role('forecast.projection.sales.month')).toBe('projection');
    expect(role('forecast.fit.sales.ytd')).toBe('projection');
    expect(role('forecast.variance.actual_vs_projection.month')).toBe('projection');
    // What was said before the month closed: the only basis for a beat or miss.
    expect(role('forecast.expected.rolling.sales.month')).toBe('forecast');
    expect(role('forecast.expected.at_actual_spend.sales.month')).toBe('forecast');
    expect(role('forecast.variance.actual_vs_rolling.month')).toBe('forecast');
    expect(role('forecast.variance.actual_vs_forecast_at_actual_spend.month')).toBe('forecast');
    expect(role('forecast.range.lower.sales.month')).toBe('forecast');
    // Months to come, and the basis.
    expect(role('forecast.projected.sales.rest_of_window')).toBe('outlook');
    expect(role('forecast.overlay.sales.corrected')).toBe('basis');
    expect(role('forecast.model.sales.per_ad_dollar')).toBe('basis');
    expect(role('forecast.actual.sales.month')).toBe('actual');
    expect(roleOfClaim('claim.forecast.projection_line')).toBe('projection');
    expect(roleOfClaim('claim.forecast.month_line')).toBe('forecast');
  });

  it('an id the extractor cannot place, a dangling reference, or the other metric fails CHECK', () => {
    expect(roleOfId('forecast.something_new.sales.month')).toBeNull();
    const answer = load('revenue.current');
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.something_new.sales.month' });
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.actual.units.ytd' });
    answer.report_data.sections[0].figure_refs.push('forecast.not_here');
    const findings = checkForecast(extractForecast(answer));
    const rules = findings.map((f) => `${f.rule}:${f.subject}`);
    expect(rules).toContain('FORECAST-ROLE:forecast.something_new.sales.month');
    expect(rules).toContain('FORECAST-METRIC:forecast.actual.units.ytd');
    expect(rules).toContain('FORECAST-TRACE:sec.forecast.tracking');
  });

  it('a units answer keeps its own metric and carries the uncorrected-units caveat and limitation', () => {
    const doc = extractForecast(load('units.current'));
    expect(doc.forecast.metric).toBe('units');
    expect(doc.figures.some((f) => f.id.includes('.units.'))).toBe(true);
    expect(doc.figures.some((f) => f.id.includes('.sales.'))).toBe(false);
    expect(Object.keys(doc.caveat_registry)).toContain('forecast_units_uncorrected');
    expect(doc.limitations.join(' ')).toMatch(/uncorrected units/);
  });
});
