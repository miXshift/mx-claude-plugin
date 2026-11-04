import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  checkForecast,
  extractForecast,
  ForecastMonthMismatchError,
  isForecastTrackResponse,
  roleOfClaim,
  roleOfId,
} from '../src/lib/report-contract/forecast';
import { forecastExtractedPayload } from '../src/lib/report-contract/forecast-telemetry';

/**
 * The forecast extractor over REAL FCT-TRACK-01 answers: testdata/fct-track-01.*.json
 * were produced by the service's own entry code over the forecasting contract's
 * worked demo document (revenue and units for a closed month, the same scope for
 * a month after the last closed one, and a scope never published), with
 * publisher and build identifiers replaced by placeholders.
 */

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../testdata/fct-track-01.${name}.json`, import.meta.url)), 'utf8'));
const fixture = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/lib/report-contract/fixtures/${rel}`, import.meta.url)), 'utf8'));

describe('forecast extractor', () => {
  it('recognises a FCT-TRACK-01 answer and nothing else, existing envelopes included', () => {
    expect(isForecastTrackResponse(load('revenue.current'))).toBe(true);
    expect(isForecastTrackResponse(fixture('envelope-minimal.json'))).toBe(false);
    expect(isForecastTrackResponse({ ok: true, service: 'forecasting', kind: 'readiness' })).toBe(false);
    expect(isForecastTrackResponse({ ok: true, service: 'forecasting', kind: 'baseline' })).toBe(false);
    expect(isForecastTrackResponse({ ok: false, kind: 'unknown_insight' })).toBe(false);
    expect(() => extractForecast({ ok: true })).toThrow(/Not a FCT-TRACK-01 answer/);
  });

  it('a current forecast: every item has a role, sections are internal forecast sections, CHECK passes', () => {
    for (const name of ['revenue.current', 'units.current']) {
      const doc = extractForecast(load(name));
      expect(doc.forecast.state).toBe('provided_current');
      expect(doc.figures.length).toBeGreaterThan(50);
      expect(checkForecast(doc)).toEqual([]);
      const roles = new Set([...doc.figures, ...doc.derived, ...doc.claims].map((x) => x.forecast_role));
      expect([...roles].sort()).toEqual(['actual', 'basis', 'forecast', 'outlook', 'projection', 'year_start']);
      for (const s of doc.sections) expect(s).toMatchObject({ kind: 'forecast', audience: 'internal' });
      expect(doc.source.attestation).toMatch(/published forecast vintage 3 \(7d1f0c2e-[0-9a-f-]+\), published 2026-09-30/);
      expect(doc.limitations.length).toBeGreaterThan(0);
    }
  });

  it('THE GATE: a stale or unpublished answer carries no figure, claim, section, caveat or limitation', () => {
    for (const [name, state, reason] of [
      ['revenue.stale', 'stale', 'report_month_not_closed'],
      ['never-published', 'not_provided', 'never_published'],
    ] as const) {
      const doc = extractForecast(load(name));
      expect(doc.forecast.state).toBe(state);
      expect(doc.source.reason).toBe(reason);
      expect([doc.figures, doc.derived, doc.claims, doc.sections, doc.limitations]).toEqual([[], [], [], [], []]);
      expect(doc.caveat_registry).toEqual({});
      expect(doc.source.attestation).toMatch(/no forecast figures used/);
      expect(checkForecast(doc)).toEqual([]);
    }
  });

  it('the gate holds even when a non-current answer still carries report_data and limitations', () => {
    const answer = load('revenue.current');
    answer.forecast_state = 'stale';
    const doc = extractForecast(answer);
    expect(doc.figures).toEqual([]);
    expect(doc.limitations).toEqual([]);
    expect(doc.source.attestation).toMatch(/no forecast figures used \(stale\)/);
  });

  it('the forecast, the projection and the year-start forecast are never confused', () => {
    const doc = extractForecast(load('revenue.current'));
    const role = (id: string) => [...doc.figures, ...doc.derived].find((x) => x.id === id)?.forecast_role;
    expect(role('forecast.projection.sales.month')).toBe('projection');
    expect(role('forecast.fit.sales.ytd')).toBe('projection');
    expect(role('forecast.variance.actual_vs_projection.month')).toBe('projection');
    expect(role('forecast.expected.rolling.sales.month')).toBe('forecast');
    expect(role('forecast.expected.at_actual_spend.sales.month')).toBe('forecast');
    expect(role('forecast.variance.actual_vs_forecast_at_actual_spend.month')).toBe('forecast');
    expect(role('forecast.range.lower.sales.month')).toBe('forecast');
    expect(role('forecast.assumed_yoy.sales.month')).toBe('forecast');
    expect(role('forecast.expected.year_start.sales.ytd')).toBe('year_start');
    expect(role('forecast.variance.actual_vs_year_start.ytd')).toBe('year_start');
    // The months still to come, including what each assumes about last year.
    expect(role('forecast.assumed_yoy.sales.2026-03')).toBe('outlook');
    expect(role('forecast.projected.sales.rest_of_window')).toBe('outlook');
    expect(role('forecast.overlay.sales.corrected')).toBe('basis');
    expect(role('forecast.actual.sales.month')).toBe('actual');
    expect(roleOfClaim('claim.forecast.projection_line')).toBe('projection');
    expect(roleOfClaim('claim.forecast.month_line')).toBe('forecast');
  });

  it('client_safe (D-089): actual, projection, forecast or outlook figures with no blocking caveat (and derived from such)', () => {
    const doc = extractForecast(load('revenue.current'));
    for (const f of doc.figures) {
      const blocking = f.caveats.some((c) => doc.caveat_registry[c]?.severity === 'blocking');
      expect(f.client_safe, f.id).toBe(['actual', 'projection', 'forecast', 'outlook'].includes(f.forecast_role) && !blocking);
    }
    // The projection leads the client brief now; its in-sample caveat is a disclosure, rendered beside it.
    const projection = doc.figures.filter((f) => f.forecast_role === 'projection');
    expect(projection.length).toBeGreaterThan(0);
    expect(projection.every((f) => f.client_safe && f.caveats.includes('forecast_projection_in_sample'))).toBe(true);
    expect(doc.caveat_registry['forecast_projection_in_sample']?.severity).toBe('disclosure');
    expect(doc.figures.filter((f) => f.forecast_role === 'year_start').every((f) => !f.client_safe)).toBe(true);
    expect(doc.figures.some((f) => f.client_safe)).toBe(true);
  });

  it('the projection leads only where its served variance is clean: a blocking caveat on the month variance keeps the month projection internal', () => {
    const answer = load('revenue.current');
    const v = answer.report_data.figures.find((f: { id: string }) => f.id === 'forecast.variance.actual_vs_projection.month');
    v.caveats = [...v.caveats, 'forecast_month_without_actuals'];
    const doc = extractForecast(answer);
    const safe = (id: string) => doc.figures.find((f) => f.id === id)?.client_safe;
    expect(safe('forecast.projection.sales.month')).toBe(false);
    expect(safe('forecast.variance.actual_vs_projection.month')).toBe(false);
    expect(safe('forecast.variance.actual_vs_projection_pct.month')).toBe(false);
    // The year to date's variance is clean, so its projection still leads.
    expect(safe('forecast.fit.sales.ytd')).toBe(true);
    // Derived figures built on the withheld month projection are withheld too.
    for (const d of doc.derived.filter((x) => x.inputs.includes('forecast.projection.sales.month'))) expect(d.client_safe, d.id).toBe(false);
  });

  it('FAIL CLOSED: one id the extractor cannot place withholds the whole forecast', () => {
    expect(roleOfId('forecast.something_new.sales.month')).toBeNull();
    const answer = load('revenue.current');
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.something_new.sales.month' });
    const doc = extractForecast(answer);
    expect(doc.forecast.state).toBe('not_provided');
    expect(doc.source.reason).toBe('unrecognised_figures');
    expect(doc.source.unrecognised).toEqual(['forecast.something_new.sales.month']);
    expect(doc.figures).toEqual([]);
    expect(checkForecast(doc).map((f) => f.rule)).toContain('FORECAST-ROLE');
  });

  it('a claim id this version cannot place is kept for the internal companion and never withholds the forecast', () => {
    expect(roleOfClaim('claim.forecast.something_new')).toBeNull();
    const answer = load('revenue.current');
    answer.report_data.claims.push({
      id: 'claim.forecast.something_new',
      kind: 'tracking',
      text: 'A disclosure line this version has not seen before.',
      figure_refs: ['forecast.actual.sales.ytd'],
    });
    const doc = extractForecast(answer);
    expect(doc.forecast.state).toBe('provided_current');
    expect(doc.source.reason).not.toBe('unrecognised_figures');
    expect(doc.source.unrecognised).toEqual([]);
    expect(doc.source.unplaced_claims).toEqual(['claim.forecast.something_new']);
    expect(doc.claims.find((c) => c.id === 'claim.forecast.something_new')?.forecast_role).toBe('basis');
    expect(doc.figures.length).toBe(extractForecast(load('revenue.current')).figures.length);
    expect(checkForecast(doc)).toEqual([]);
    // Telemetry carries the count only, never the id or the text.
    const payload = forecastExtractedPayload(doc, [], { checkRan: true });
    expect(payload.unplaced_claims).toBe(1);
    expect(JSON.stringify(payload)).not.toContain('something_new');
    expect(forecastExtractedPayload(extractForecast(load('revenue.current')), [], { checkRan: true })).not.toHaveProperty('unplaced_claims');
  });

  it('two_actuals (months whose figure corrected in the app differs from the warehouse) is internal basis, revenue and units', () => {
    for (const [name, claimId, actualId, word] of [
      ['revenue.current', 'claim.forecast.two_actuals', 'forecast.actual.sales.ytd', 'sales figure'],
      ['units.current', 'claim.forecast.units.two_actuals', 'forecast.actual.units.ytd', 'units figure'],
    ] as const) {
      expect(roleOfClaim(claimId)).toBe('basis');
      const answer = load(name);
      answer.report_data.claims.push({
        id: claimId,
        kind: 'tracking',
        text: `7 of the 10 months in this total carry a ${word} that differs from the warehouse figure read today; the figure used is the one the model was given, and both are in the population.`,
        figure_refs: [actualId],
      });
      const doc = extractForecast(answer);
      expect(doc.forecast.state, name).toBe('provided_current');
      expect(doc.source.unplaced_claims, name).toEqual([]);
      expect(doc.claims.find((c) => c.id === claimId)?.forecast_role, name).toBe('basis');
      expect(checkForecast(doc), name).toEqual([]);
    }
  });

  it('every id the forecasting service emits today is placed, with the same role in revenue and units', () => {
    // The service's figure, derived and claim ids as of 2026-11-04 (revenue spelling). A units id is
    // the same id with `units` where revenue says `sales`, or under `forecast.units.` when it names
    // no metric; a units claim is under `claim.forecast.units.`.
    const unitsId = (id: string) => (id.includes('.sales.') ? id.replace('.sales.', '.units.') : id.replace(/^forecast\./, 'forecast.units.'));
    const figures: Array<[string, string]> = [
      ['forecast.actual.sales.ytd', 'actual'],
      ['forecast.expected.rolling.sales.ytd', 'forecast'],
      ['forecast.expected.at_actual_spend.sales.ytd', 'forecast'],
      ['forecast.expected.year_start.sales.ytd', 'year_start'],
      ['forecast.fit.sales.ytd', 'projection'],
      ['forecast.variance.actual_vs_projection.ytd', 'projection'],
      ['forecast.variance.actual_vs_projection_pct.ytd', 'projection'],
      ['forecast.tolerance.h1_3', 'forecast'],
      ['forecast.actual.sales.month', 'actual'],
      ['forecast.expected.rolling.sales.month', 'forecast'],
      ['forecast.expected.at_actual_spend.sales.month', 'forecast'],
      ['forecast.range.lower.sales.month', 'forecast'],
      ['forecast.range.upper.sales.month', 'forecast'],
      ['forecast.assumed_yoy.sales.month', 'forecast'],
      ['forecast.last_year.sales.month', 'actual'],
      ['forecast.variance.actual_vs_rolling.month', 'forecast'],
      ['forecast.variance.actual_vs_rolling_pct.month', 'forecast'],
      ['forecast.projection.sales.month', 'projection'],
      ['forecast.variance.actual_vs_projection.month', 'projection'],
      ['forecast.variance.actual_vs_projection_pct.month', 'projection'],
      ['forecast.model.sales.per_ad_dollar', 'basis'],
      ['forecast.model.sales.per_ad_dollar_margin', 'basis'],
      ['forecast.model.sales.per_ad_dollar_prior', 'basis'],
      ['forecast.model.sales.growth_per_month_prior', 'basis'],
      ['forecast.model.sales.growth_per_month', 'basis'],
      ['forecast.model.training_months', 'basis'],
      ['forecast.model.seasonal_amplitude', 'basis'],
      ['forecast.model.seasonal_peak_month', 'basis'],
      ['forecast.overlay.sales.corrected', 'basis'],
      ['forecast.overlay.ad_spend_corrected', 'basis'],
      ['forecast.overlay.ignored', 'basis'],
      ['forecast.overlay.withheld', 'basis'],
      ['forecast.overlay.source_moved', 'basis'],
      ['forecast.projected.sales.2026-11', 'outlook'],
      ['forecast.range.lower.sales.2026-11', 'outlook'],
      ['forecast.range.upper.sales.2026-11', 'outlook'],
      ['forecast.spend.2026-11', 'outlook'],
      ['forecast.assumed_yoy.sales.2026-11', 'outlook'],
      // Derived.
      ['forecast.variance.actual_vs_forecast_at_actual_spend.ytd', 'forecast'],
      ['forecast.variance.actual_vs_year_start.ytd', 'year_start'],
      ['forecast.variance.actual_vs_forecast_at_actual_spend.month', 'forecast'],
      ['forecast.projection_vs_last_year_pct.sales.month', 'projection'],
      ['forecast.model.sales.per_ad_dollar_change', 'basis'],
      ['forecast.model.sales.growth_per_month_change', 'basis'],
      ['forecast.projected.sales.rest_of_window', 'outlook'],
      ['forecast.projected.sales.window_total', 'outlook'],
    ];
    for (const [id, role] of figures) {
      expect(roleOfId(id), id).toBe(role);
      expect(roleOfId(unitsId(id)), unitsId(id)).toBe(role);
    }
    const claims: Array<[string, string]> = [
      ['projection_line', 'projection'],
      ['operator_line', 'forecast'],
      ['month_projection_line', 'projection'],
      ['month_line', 'forecast'],
      ['two_actuals', 'basis'],
      ['outlook', 'outlook'],
      ['basis', 'basis'],
    ];
    for (const [name, role] of claims) {
      expect(roleOfClaim(`claim.forecast.${name}`), name).toBe(role);
      expect(roleOfClaim(`claim.forecast.units.${name}`), `units ${name}`).toBe(role);
    }
  });

  it('CHECK catches dangling references, the other metric, duplicates, a forecast claim citing the fit, and contract breaks', () => {
    const answer = load('revenue.current');
    answer.report_data.figures.push({ ...answer.report_data.figures[0], id: 'forecast.actual.units.ytd' });
    answer.report_data.figures.push({ ...answer.report_data.figures[0] });
    answer.report_data.sections[0].figure_refs.push('forecast.not_here');
    const monthLine = answer.report_data.claims.find((c: { id: string }) => c.id === 'claim.forecast.month_line');
    monthLine.figure_refs.push('forecast.projection.sales.month');
    // A blocking caveat no longer rendered where its figure is quoted (the report contract's CAVEAT-1).
    for (const s of answer.report_data.sections) s.caveats_rendered = [];
    const rules = checkForecast(extractForecast(answer)).map((f) => `${f.rule}:${f.subject}`);
    expect(rules).toContain('FORECAST-METRIC:forecast.actual.units.ytd');
    expect(rules).toContain(`FORECAST-DUPLICATE:${answer.report_data.figures[0].id}`);
    expect(rules).toContain('FORECAST-TRACE:sec.forecast.tracking');
    expect(rules).toContain('FORECAST-CLAIM-BASIS:claim.forecast.month_line');
    expect(rules.some((r) => r.startsWith('FORECAST-CONTRACT:'))).toBe(true);
  });

  it('refuses an answer about another month (a file left by an earlier run)', () => {
    expect(() => extractForecast(load('revenue.current'), { expectMonth: '2026-03' })).toThrow(ForecastMonthMismatchError);
    expect(extractForecast(load('revenue.current'), { expectMonth: '2026-02' }).forecast.state).toBe('provided_current');
  });

  it('carries the year-to-date-runs-past flag', () => {
    const answer = load('revenue.current');
    expect(extractForecast(answer).source.ytd_runs_past_report_month).toBe(false);
    answer.ytd_runs_past_report_month = true;
    expect(extractForecast(answer).source.ytd_runs_past_report_month).toBe(true);
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
