/**
 * Bid threshold sanity check for the confirm card (mx-ops#409, D-401 option A).
 *
 * mx-keyword-bid-health compares keyword ACoS directly against
 * `scale_threshold_pct` and `pullback_threshold_pct`: both are ABSOLUTE ACoS
 * levels in whole percents (scale 21 = "below 21% ACoS"). The brand template
 * used to describe them as offsets from the ACoS target ("ACoS above target by
 * this %") and shipped 50/50 defaults, so a brand that followed it saved
 * offsets, and the skill flagged keywords under target for bid cuts.
 *
 * Two value shapes give an offset away, and neither makes sense as a pair of
 * ACoS levels:
 *   - scale at or above pullback: a keyword between them would be a scale and
 *     a cut candidate at once (the template's 50/50 default trips this);
 *   - pullback below the ACoS target: keywords under target would be cut.
 *
 * When either holds, the card warns and asks ONCE: edit the values, or keep
 * them (`acknowledge_warnings: true`). Keeping records the values that were
 * kept under `bid_threshold_ack` in config.yaml::<skill_id>, so the same values
 * never ask again; changed values that still trip ask again. Nothing is ever
 * rewritten for the user.
 *
 * The check runs only for a skill whose manifest seeds BOTH thresholds from
 * `context.bid_health.*` (today mx-keyword-bid-health), so every other skill's
 * card is unchanged.
 */

import type { CalibrationField } from './manifest-schema.js';

export const SCALE_SEED = 'context.bid_health.scale_threshold_pct';
export const PULLBACK_SEED = 'context.bid_health.pullback_threshold_pct';
export const TARGET_SEED = 'context.management.acos_target_pct';

/** Key in config.yaml::<skill_id> that records kept values. */
export const BID_THRESHOLD_ACK_KEY = 'bid_threshold_ack';

export type ThresholdWarningCode =
  | 'scale_at_or_above_pullback'
  | 'pullback_below_target';

export interface ThresholdWarning {
  code: ThresholdWarningCode;
  /** Field ids the warning is about (the card highlights these). */
  fields: string[];
  /** Plain customer-facing sentence(s), no em dashes. */
  message: string;
}

/** Whole-percent values the check judged (null when unset). */
export interface ThresholdValues {
  scale_threshold_pct: number | null;
  pullback_threshold_pct: number | null;
  acos_target: number | null;
}

export interface ThresholdCheck {
  warnings: ThresholdWarning[];
  values: ThresholdValues;
  /** True when the user already kept exactly these values once. */
  acknowledged: boolean;
  /** True when the card must get one answer (edit or keep) before running. */
  reconfirm_required: boolean;
}

export interface ThresholdAck extends ThresholdValues {
  kept_at: string;
}

/**
 * Check the thresholds a run would use. `effective` holds the calibration
 * layer's [0,1] fractions keyed by field id; `extras` is the skill block's
 * non-manifest keys (where an earlier ack lives). Returns null when the
 * manifest does not carry both bid_health thresholds or nothing trips.
 */
export function checkBidThresholds(
  fields: CalibrationField[],
  effective: Record<string, unknown>,
  extras: Record<string, unknown>,
): ThresholdCheck | null {
  const scaleId = idForSeed(fields, SCALE_SEED);
  const pullbackId = idForSeed(fields, PULLBACK_SEED);
  if (!scaleId || !pullbackId) return null;
  const targetId = idForSeed(fields, TARGET_SEED);

  const values: ThresholdValues = {
    scale_threshold_pct: wholePct(effective[scaleId]),
    pullback_threshold_pct: wholePct(effective[pullbackId]),
    acos_target: targetId ? wholePct(effective[targetId]) : null,
  };
  const { scale_threshold_pct: s, pullback_threshold_pct: p, acos_target: t } = values;

  const warnings: ThresholdWarning[] = [];
  if (s !== null && p !== null && s >= p) {
    warnings.push({
      code: 'scale_at_or_above_pullback',
      fields: [scaleId, pullbackId],
      message:
        `Scale threshold (${s}%) is at or above the pullback threshold (${p}%). ` +
        `Both are ACoS levels, not offsets from your target, so a keyword between ` +
        `them would be a scale and a cut candidate at once. ` +
        suggestion(t),
    });
  }
  if (p !== null && t !== null && p < t) {
    warnings.push({
      code: 'pullback_below_target',
      fields: [pullbackId],
      message:
        `Pullback threshold (${p}%) is below your ACoS target (${t}%), so keywords ` +
        `under target would be flagged for a bid cut. The pullback threshold is the ` +
        `ACoS level itself: for a ${t}% target, "20% above target" is ${round1(t * 1.2)}%. ` +
        suggestion(t),
    });
  }
  if (warnings.length === 0) return null;

  const acknowledged = ackMatches(extras[BID_THRESHOLD_ACK_KEY], values);
  return {
    warnings,
    values,
    acknowledged,
    reconfirm_required: !acknowledged,
  };
}

/** The record written when the user keeps flagged values. */
export function buildAck(values: ThresholdValues, now: Date = new Date()): ThresholdAck {
  return { ...values, kept_at: now.toISOString() };
}

function suggestion(target: number | null): string {
  if (target === null) {
    return 'Enter the ACoS levels themselves, or leave both unset to use the skill defaults.';
  }
  return (
    `Enter the ACoS levels themselves, or leave both unset to use ` +
    `${round1(target * 0.7)}% and ${round1(target * 1.5)}% (your ${target}% target x 0.7 and x 1.5).`
  );
}

function idForSeed(fields: CalibrationField[], seed: string): string | null {
  const f = fields.find((x) => !x.deprecated && x.seed_from === seed);
  return f ? f.id : null;
}

/** [0,1] fraction to whole percent, two decimals; null for non-numbers. */
function wholePct(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v * 10000) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function ackMatches(raw: unknown, values: ThresholdValues): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const a = raw as Record<string, unknown>;
  const same = (k: keyof ThresholdValues): boolean => {
    const want = values[k];
    const got = a[k];
    if (want === null) return got === null || got === undefined;
    return typeof got === 'number' && Math.abs(got - want) < 0.005;
  };
  return (
    same('scale_threshold_pct') &&
    same('pullback_threshold_pct') &&
    same('acos_target')
  );
}
