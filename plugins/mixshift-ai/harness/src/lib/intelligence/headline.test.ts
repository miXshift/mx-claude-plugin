import { describe, it, expect } from 'vitest';
import { extractRunHeadline, renderHeadline } from './headline.js';
import type { InsightResult } from './client.js';

/**
 * Insight payload shapes are not fixed by one schema shared with the plugin
 * (each insight id can evolve independently server-side), so extraction is
 * deliberately tolerant — these tests pin down the "known field" path, the
 * best-effort candidate-path probing (including nested variants), and the
 * graceful-degradation path for a shape that matches none of the candidates.
 */

function baseMeta(overrides: Partial<InsightResult['meta']> = {}): InsightResult['meta'] {
  return {
    insightId: 'INS-MONTHLY-01',
    revision: 'r12',
    engineSha: 'abc1234',
    methodologyVersion: '2.1',
    computedAt: '2026-07-27T09:00:00Z',
    ...overrides,
  };
}

describe('extractRunHeadline', () => {
  it('extracts the fixed envelope fields (ok, meta.*, limitations count)', () => {
    const result: InsightResult = {
      ok: true,
      limitations: ['partial ads coverage', 'no YoY for this SKU'],
      meta: baseMeta({ cache: { hit: true } }),
    };
    const h = extractRunHeadline(result);
    expect(h.ok).toBe(true);
    expect(h.insightId).toBe('INS-MONTHLY-01');
    expect(h.revision).toBe('r12');
    expect(h.computedAt).toBe('2026-07-27T09:00:00Z');
    expect(h.cache).toBe('hit');
    expect(h.limitationCount).toBe(2);
  });

  it('picks up top-level momOpsDelta / momOpsDeltaPct / tacosDelta for the INS-MONTHLY-01 bundle shape', () => {
    // INS-MONTHLY-01 bundles MoM ops + ads bridge figures; this fixture models
    // a plausible top-level shape for the monthly bundle envelope.
    const result: InsightResult = {
      ok: true,
      momOpsDelta: 18234.56,
      momOpsDeltaPct: 4.2,
      tacosDelta: -0.8,
      limitations: [],
      meta: baseMeta({ cache: false }),
    };
    const h = extractRunHeadline(result);
    expect(h.keyTotals).toEqual({
      momOpsDelta: 18234.56,
      momOpsDeltaPct: 4.2,
      tacosDelta: -0.8,
    });
    expect(h.cache).toBe('miss');
  });

  it('falls back to nested candidate paths (summary / headline / opsBridge / adsBridge)', () => {
    const result: InsightResult = {
      ok: true,
      summary: { momOpsDelta: 100 },
      headline: { momOpsDeltaPct: 2.5 },
      adsBridge: { tacosDelta: -1.1 },
      limitations: [],
      meta: baseMeta(),
    };
    const h = extractRunHeadline(result);
    expect(h.keyTotals).toEqual({
      momOpsDelta: 100,
      momOpsDeltaPct: 2.5,
      tacosDelta: -1.1,
    });
  });

  it('prefers a top-level field over a nested one when both are present', () => {
    const result: InsightResult = {
      ok: true,
      momOpsDelta: 1,
      summary: { momOpsDelta: 999 },
      limitations: [],
      meta: baseMeta(),
    };
    const h = extractRunHeadline(result);
    expect(h.keyTotals.momOpsDelta).toBe(1);
  });

  it('degrades gracefully when the payload matches none of the candidate shapes', () => {
    const result: InsightResult = {
      ok: true,
      someUnrelatedField: 'x',
      limitations: [],
      meta: baseMeta(),
    };
    const h = extractRunHeadline(result);
    expect(h.keyTotals).toEqual({});
  });

  it('never throws on a malformed/partial meta or limitations field', () => {
    const result = { ok: true } as unknown as InsightResult;
    expect(() => extractRunHeadline(result)).not.toThrow();
    const h = extractRunHeadline(result);
    expect(h.insightId).toBeUndefined();
    expect(h.limitationCount).toBeUndefined();
    expect(h.keyTotals).toEqual({});
  });

  it('renders meta.cache object shapes with a status field', () => {
    const result: InsightResult = {
      ok: true,
      limitations: [],
      meta: baseMeta({ cache: { status: 'stale' } }),
    };
    expect(extractRunHeadline(result).cache).toBe('stale');
  });
});

describe('renderHeadline', () => {
  it('renders a compact multi-line block with ok marker, meta line, and key totals', () => {
    const result: InsightResult = {
      ok: true,
      momOpsDelta: 500,
      momOpsDeltaPct: 3.1,
      tacosDelta: -0.4,
      limitations: ['one caveat'],
      meta: baseMeta({ cache: { hit: true } }),
    };
    const text = renderHeadline(extractRunHeadline(result));
    expect(text).toContain('✓ INS-MONTHLY-01');
    expect(text).toContain('cache: hit');
    expect(text).toContain('revision: r12');
    expect(text).toContain('limitations: 1');
    expect(text).toContain('momOpsDelta: 500');
    expect(text).toContain('tacosDelta: -0.4');
  });

  it('renders a failure-shaped headline (ok:false) with the ✗ marker and no throw', () => {
    const h = extractRunHeadline({ ok: false } as unknown as InsightResult);
    expect(() => renderHeadline(h)).not.toThrow();
    expect(renderHeadline(h)).toContain('✗');
  });

  it('omits the key-totals line entirely when there are none', () => {
    const result: InsightResult = { ok: true, limitations: [], meta: baseMeta() };
    const text = renderHeadline(extractRunHeadline(result));
    expect(text.split('\n')).toHaveLength(2); // marker line + meta line, no totals line
  });
});

describe('forecasting answers (no meta envelope)', () => {
  const track = (extra: Record<string, unknown> = {}) =>
    ({
      ok: true,
      service: 'forecasting',
      kind: 'track',
      scope_id: 'src:demo:1',
      metric: 'revenue',
      month: '2026-02',
      forecast_state: 'not_provided',
      reason: 'never_published',
      friendly: 'No forecast has been published for this scope and metric.',
      report_data: null,
      ...extra,
    }) as unknown as InsightResult;

  it('takes the insight id from the id the CLI ran and renders a one-line forecast summary', () => {
    const h = extractRunHeadline(track(), 'FCT-TRACK-01');
    expect(h.insightId).toBe('FCT-TRACK-01');
    expect(renderHeadline(h)).toBe('✓ FCT-TRACK-01 · forecast not provided (never_published) · revenue 2026-02 · src:demo:1');
  });

  it('a current forecast names its vintage and age, and never a figure', () => {
    const h = extractRunHeadline(
      track({
        forecast_state: 'provided_current',
        reason: undefined,
        report_data: { figures: [{ id: 'forecast.expected.rolling.sales.month', value: 98765.43 }] },
        published: { gateway_revision: 3, age_days: 2 },
        limitations: ['Served from the published copy.'],
      }),
      'FCT-TRACK-01',
    );
    const text = renderHeadline(h);
    expect(text.split('\n')[0]).toBe('✓ FCT-TRACK-01 · forecast current, vintage 3, 2 days old · revenue 2026-02 · src:demo:1');
    expect(text).toContain('limitations: 1');
    expect(text).not.toContain('98765');
    expect(text).not.toContain('Served from');
  });

  it('a meta insight id still wins (FCT-READINESS-01 carries one)', () => {
    const h = extractRunHeadline(
      { ok: true, service: 'forecasting', kind: 'readiness', verdict: 'recommended', limitations: [], meta: baseMeta({ insightId: 'FCT-READINESS-01' }) },
      'something-else',
    );
    expect(h.insightId).toBe('FCT-READINESS-01');
    expect(renderHeadline(h).split('\n')[0]).toBe('✓ FCT-READINESS-01 · readiness verdict recommended');
  });

  it('the fallback id is ignored for every other answer, which reads exactly as before', () => {
    const h = extractRunHeadline({ ok: true } as unknown as InsightResult, 'INS-OPS-BRIDGE-01');
    expect(h.insightId).toBeUndefined();
    expect(h.forecastSummary).toBeUndefined();
    expect(renderHeadline(h)).toBe('✓ (insight id unknown)');
  });
});
