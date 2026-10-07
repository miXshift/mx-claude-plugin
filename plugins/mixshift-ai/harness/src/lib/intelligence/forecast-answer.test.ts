import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  boundedLabel,
  boundedMonth,
  boundedScopeId,
  forecastTelemetryFields,
  isForecastingAnswer,
  renderForecastSummary,
  summarizeForecastAnswer,
} from './forecast-answer.js';

/**
 * What `intelligence.run_retrieved` and the CLI headline say about a
 * forecasting answer. The FCT-TRACK-01 fixtures are the real service answers
 * the report extractor is tested on (testdata/fct-track-01.*.json). The point
 * of most of these tests is what is NOT said: no forecast figure, no free text.
 */

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../testdata/fct-track-01.${name}.json`, import.meta.url)), 'utf8'));

const baseline = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  service: 'forecasting',
  kind: 'baseline',
  scope_id: 'src:acme:123',
  metric: 'revenue',
  ...extra,
});

const readiness = (extra: Record<string, unknown> = {}) => ({
  ok: true,
  service: 'forecasting',
  kind: 'readiness',
  verdict: 'floor',
  merchant: { legacySellerId: 123 },
  limitations: ['Twelve complete months found.'],
  meta: { insightId: 'FCT-READINESS-01' },
  ...extra,
});

describe('bounded values', () => {
  it('labels are short snake_case; anything else is dropped, not truncated', () => {
    expect(boundedLabel('never_published')).toBe('never_published');
    expect(boundedLabel('Not-Ready')).toBe('not_ready');
    expect(boundedLabel('The published forecast does not yet have the month')).toBeUndefined();
    expect(boundedLabel('x'.repeat(49))).toBeUndefined();
    expect(boundedLabel(3)).toBeUndefined();
  });

  it('scope ids and months must match their shapes', () => {
    expect(boundedScopeId('src:demo:1')).toBe('src:demo:1');
    expect(boundedScopeId('src:demo:1:scope:ab12')).toBe('src:demo:1:scope:ab12');
    expect(boundedScopeId('src:demo:1:scope:AB')).toBeUndefined();
    expect(boundedScopeId('acme brand')).toBeUndefined();
    expect(boundedMonth('2026-02')).toBe('2026-02');
    expect(boundedMonth('2026-13')).toBeUndefined();
    expect(boundedMonth('2026-02-01')).toBeUndefined();
  });
});

describe('forecastTelemetryFields', () => {
  it('adds nothing for an answer that is not from the forecasting service', () => {
    expect(isForecastingAnswer({ ok: true, meta: { insightId: 'INS-MONTHLY-01' } })).toBe(false);
    expect(forecastTelemetryFields({ ok: true, momOpsDelta: 5, meta: {} })).toEqual({});
    expect(forecastTelemetryFields(null)).toEqual({});
  });

  it('TRACK, current: served, with the vintage and its age, and no figure anywhere', () => {
    const answer = load('revenue.current');
    const fields = forecastTelemetryFields(answer);
    expect(fields).toEqual({
      service: 'forecasting',
      kind: 'track',
      forecast_state: 'provided_current',
      metric: 'revenue',
      month: '2026-02',
      scope_id: 'src:demo:1',
      vintage: 3,
      vintage_age_days: 1,
      ytd_runs_past_report_month: false,
      served: true,
    });
    // Nothing from report_data travels: every figure value is absent from the payload.
    const values = new Set(Object.values(fields));
    for (const f of answer.report_data.figures as Array<{ value: number }>) {
      if (f.value !== 1 && f.value !== 3) expect(values.has(f.value)).toBe(false);
    }
  });

  it('TRACK, never published: not served, reason kept, the friendly text never', () => {
    const fields = forecastTelemetryFields(load('never-published'));
    expect(fields).toEqual({
      service: 'forecasting',
      kind: 'track',
      forecast_state: 'not_provided',
      reason: 'never_published',
      metric: 'revenue',
      month: '2026-02',
      scope_id: 'src:demo:1',
      served: false,
    });
    expect(JSON.stringify(fields)).not.toContain('No forecast has been published');
  });

  it('TRACK, stale: not served, with the vintage it was judged on', () => {
    expect(forecastTelemetryFields(load('revenue.stale'))).toMatchObject({
      forecast_state: 'stale',
      reason: 'report_month_not_closed',
      month: '2026-06',
      vintage: 3,
      served: false,
    });
  });

  it('TRACK provided_current without report_data is not served', () => {
    const answer = { ...load('revenue.current'), report_data: null };
    expect(forecastTelemetryFields(answer).served).toBe(false);
  });

  it('BASELINE: available decides served', () => {
    expect(forecastTelemetryFields(baseline({ available: true, published: { gateway_revision: 4, age_days: 2 } }))).toEqual({
      service: 'forecasting',
      kind: 'baseline',
      available: true,
      metric: 'revenue',
      scope_id: 'src:acme:123',
      vintage: 4,
      vintage_age_days: 2,
      served: true,
    });
    expect(forecastTelemetryFields(baseline({ available: false, reason: 'below_floor' }))).toMatchObject({
      available: false,
      reason: 'below_floor',
      served: false,
    });
  });

  it('READINESS: the verdict, never served', () => {
    expect(forecastTelemetryFields(readiness())).toEqual({
      service: 'forecasting',
      kind: 'readiness',
      verdict: 'floor',
      served: false,
    });
  });

  it('drops values that do not match their shape', () => {
    const fields = forecastTelemetryFields({
      ...load('never-published'),
      reason: 'a sentence the service wrote',
      scope_id: 'acme:everything',
      month: 'February',
      metric: 'revenue; drop table',
    });
    expect(fields).toEqual({ service: 'forecasting', kind: 'track', forecast_state: 'not_provided', served: false });
  });
});

describe('renderForecastSummary', () => {
  const line = (answer: unknown) => renderForecastSummary(summarizeForecastAnswer(answer)!);

  it('TRACK states', () => {
    expect(line(load('never-published'))).toBe('forecast not provided (never_published) · revenue 2026-02 · src:demo:1');
    expect(line(load('revenue.current'))).toBe('forecast current, vintage 3, 1 day old · revenue 2026-02 · src:demo:1');
    expect(line({ ...load('revenue.current'), published: { gateway_revision: 3, age_days: 2 } })).toContain(
      'forecast current, vintage 3, 2 days old',
    );
    expect(line(load('revenue.stale'))).toBe(
      'forecast stale (report_month_not_closed), vintage 3, 1 day old · revenue 2026-06 · src:demo:1',
    );
  });

  it('BASELINE and READINESS', () => {
    expect(line(baseline({ available: false, reason: 'never_published' }))).toBe(
      'baseline unavailable (never_published) · revenue · src:acme:123',
    );
    expect(line(baseline({ available: true, published: { gateway_revision: 4, age_days: 0 } }))).toBe(
      'baseline available, vintage 4, under a day old · revenue · src:acme:123',
    );
    expect(line(readiness())).toBe('readiness verdict floor');
  });

  it('an unknown kind still renders without a throw', () => {
    expect(line({ ok: true, service: 'forecasting', kind: 'plan' })).toBe('forecasting answer (kind plan)');
  });
});

describe('BASELINE computed by the gateway (nothing published)', () => {
  const computed = { service: 'forecasting', kind: 'baseline', available: true, reason: 'computed', source: 'computed', published: null, metric: 'revenue', scope_id: 'src:tenant:113' };

  it('is served, carries source in telemetry, and never a vintage', () => {
    const s = summarizeForecastAnswer(computed)!;
    expect(s).toMatchObject({ kind: 'baseline', available: true, served: true, source: 'computed', reason: 'computed' });
    expect(s.vintage).toBeUndefined();
    expect(forecastTelemetryFields(computed)).toMatchObject({ service: 'forecasting', kind: 'baseline', served: true, source: 'computed' });
  });

  it('the summary line says it was computed, and a published copy keeps its vintage line', () => {
    expect(renderForecastSummary(summarizeForecastAnswer(computed)!)).toMatch(/baseline available \(computed by the gateway, nothing published\)/);
    const published = { ...computed, source: undefined, reason: undefined, published: { gateway_revision: 3, age_days: 2 } };
    const line = renderForecastSummary(summarizeForecastAnswer(published)!);
    expect(line).toMatch(/baseline available/);
    expect(line).not.toMatch(/computed/);
    expect(forecastTelemetryFields(published)).not.toHaveProperty('source');
  });
});
