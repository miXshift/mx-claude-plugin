import { describe, it, expect } from 'vitest';
import {
  deriveCaptureRateCalibration,
  type CS06Row,
  type CS07Row,
  type CS08Row,
} from './capture-rate.js';

describe('deriveCaptureRateCalibration — empty input', () => {
  it('returns null when no source carries signal', () => {
    expect(deriveCaptureRateCalibration({})).toBeNull();
    expect(
      deriveCaptureRateCalibration({ cs06: [], cs07: [], cs08: [] }),
    ).toBeNull();
  });

  it('returns null when the monthly rows are all-null and CS-08 empty', () => {
    const cs06: CS06Row[] = [
      {
        spend: null,
        sales_1day: null,
        sales_7day: null,
        acos_1day: null,
        acos_7day: null,
        improvement_pts: null,
      },
    ];
    expect(deriveCaptureRateCalibration({ cs06, cs08: [] })).toBeNull();
  });
});

describe('deriveCaptureRateCalibration — SC basis (CS-06)', () => {
  /**
   * spend 100, sales_1day 620, sales_7day 1000.
   *   capture_rate_pct = 620 / 1000 * 100 = 62
   *   acos_1day = 16.13, acos_7day = 10.0, improvement_pts = 6.13
   */
  const cs06: CS06Row[] = [
    {
      spend: 100,
      sales_1day: 620,
      sales_7day: 1000,
      acos_1day: 16.13,
      acos_7day: 10.0,
      improvement_pts: 6.13,
    },
  ];

  it('computes capture_rate_pct from 1-day / 7-day settled sales', () => {
    const cal = deriveCaptureRateCalibration({ cs06 })!;
    expect(cal.enabled).toBe(true);
    expect(cal.basis).toBe('SC');
    expect(cal.settled_window_days).toBe(7);
    expect(cal.capture_rate_pct).toBe(62);
  });

  it('uses the monthly improvement_pts when CS-08 is absent', () => {
    const cal = deriveCaptureRateCalibration({ cs06 })!;
    expect(cal.fresh_day_acos_improvement_pts).toBe(6.13);
  });

  it('emits a one-sentence operating read mentioning the SC 7-day basis', () => {
    const cal = deriveCaptureRateCalibration({ cs06 })!;
    expect(cal.settlement_application_rule).toContain('Sponsored Products');
    expect(cal.settlement_application_rule).toContain('SC, 1-day vs 7-day');
    expect(cal.settlement_application_rule).toContain('62%');
    // No em dashes in the customer-facing string.
    expect(cal.settlement_application_rule).not.toContain('—');
  });

  it('prefers SC (CS-06) over VC (CS-07) when both are present', () => {
    const cs07: CS07Row[] = [
      { sales_1day: 100, sales_14day: 1000, improvement_pts: 20 },
    ];
    const cal = deriveCaptureRateCalibration({ cs06, cs07 })!;
    expect(cal.basis).toBe('SC');
    expect(cal.settled_window_days).toBe(7);
    expect(cal.capture_rate_pct).toBe(62); // SC ratio, not VC's 10%
  });

  it('derives improvement from acos_1day - acos_7day when improvement_pts is absent', () => {
    const noImp: CS06Row[] = [
      { sales_1day: 500, sales_7day: 1000, acos_1day: 30, acos_7day: 18 },
    ];
    const cal = deriveCaptureRateCalibration({ cs06: noImp })!;
    expect(cal.fresh_day_acos_improvement_pts).toBe(12);
  });
});

describe('deriveCaptureRateCalibration — VC basis (CS-07)', () => {
  it('falls back to VC 1-day vs 14-day when no SC row is usable', () => {
    const cs07: CS07Row[] = [
      {
        spend: 200,
        sales_1day: 450,
        sales_14day: 900,
        acos_1day: 44.44,
        acos_14day: 22.22,
        improvement_pts: 22.22,
      },
    ];
    const cal = deriveCaptureRateCalibration({ cs07 })!;
    expect(cal.basis).toBe('VC');
    expect(cal.settled_window_days).toBe(14);
    expect(cal.capture_rate_pct).toBe(50); // 450/900
    expect(cal.fresh_day_acos_improvement_pts).toBe(22.22);
    expect(cal.settlement_application_rule).toContain('VC, 1-day vs 14-day');
  });
});

describe('deriveCaptureRateCalibration — CS-08 daily median', () => {
  it('prefers the CS-08 median improvement over the monthly aggregate', () => {
    const cs06: CS06Row[] = [
      { sales_1day: 620, sales_7day: 1000, improvement_pts: 6.13 },
    ];
    // Five settled days; median improvement = 10.
    const cs08: CS08Row[] = [
      { improvement_pts: 4 },
      { improvement_pts: 8 },
      { improvement_pts: 10 },
      { improvement_pts: 12 },
      { improvement_pts: 14 },
    ];
    const cal = deriveCaptureRateCalibration({ cs06, cs08 })!;
    // capture_rate stays monthly; improvement comes from CS-08 median.
    expect(cal.capture_rate_pct).toBe(62);
    expect(cal.fresh_day_acos_improvement_pts).toBe(10);
  });

  it('computes the median from acos_1day - acos_7day when improvement_pts missing', () => {
    const cs08: CS08Row[] = [
      { acos_1day: 30, acos_7day: 25 }, // 5
      { acos_1day: 40, acos_7day: 25 }, // 15
      { acos_1day: 35, acos_7day: 25 }, // 10
    ];
    // No monthly row at all — CS-08 alone still yields a calibration.
    const cal = deriveCaptureRateCalibration({ cs08 })!;
    expect(cal.basis).toBeNull();
    expect(cal.capture_rate_pct).toBeNull();
    expect(cal.fresh_day_acos_improvement_pts).toBe(10); // median of 5,10,15
    expect(cal.settlement_application_rule).toContain('Insufficient');
  });

  it('averages the two middle values for an even-length distribution', () => {
    const cs08: CS08Row[] = [
      { improvement_pts: 8 },
      { improvement_pts: 12 },
    ];
    const cal = deriveCaptureRateCalibration({ cs08 })!;
    expect(cal.fresh_day_acos_improvement_pts).toBe(10);
  });
});

describe('deriveCaptureRateCalibration — input tolerance', () => {
  it('handles string-encoded numeric columns', () => {
    const cs06: CS06Row[] = [
      {
        sales_1day: '620',
        sales_7day: '1000.00',
        improvement_pts: '6.13',
      },
    ];
    const cal = deriveCaptureRateCalibration({ cs06 })!;
    expect(cal.capture_rate_pct).toBe(62);
    expect(cal.fresh_day_acos_improvement_pts).toBe(6.13);
  });

  it('nulls capture_rate_pct when settled-window sales are zero', () => {
    const cs06: CS06Row[] = [
      { sales_1day: 100, sales_7day: 0, acos_1day: 50, acos_7day: 50, improvement_pts: 0 },
    ];
    const cal = deriveCaptureRateCalibration({ cs06 })!;
    // sales_7day=0 -> no ratio, but acos/improvement still give a basis.
    expect(cal.basis).toBe('SC');
    expect(cal.capture_rate_pct).toBeNull();
    expect(cal.fresh_day_acos_improvement_pts).toBe(0);
  });
});
