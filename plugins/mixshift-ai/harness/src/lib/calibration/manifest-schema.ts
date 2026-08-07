/**
 * Calibration manifest schema.
 *
 * Validates the `calibration:` block in `skills/<skill-id>/skill.manifest.yaml`.
 * That block is the source of truth for which OCL (Objective Level
 * Configuration) fields the confirm-on-run flow shows the user. The harness
 * reads this manifest, presents the fields, accepts edits, and persists to
 * `~/.mixshift/clients/<slug>/config.yaml::<skill_id>`.
 *
 * --------------------------------------------------------------------------
 * Authoring guide
 * --------------------------------------------------------------------------
 *
 * Each field is one user-visible decision the skill needs the user to confirm
 * (or take responsibility for accepting the default of). Keep manifests
 * SHORT — 3–6 fields per skill is the target. Anything that can be derived
 * from context.yaml should be derived, not asked. The wizard exists for the
 * decisions that genuinely shape skill output.
 *
 * For each field:
 *   - `id`: snake_case key persisted to config.yaml
 *   - `prompt`: the question shown in chat (supports {brand_name})
 *   - `help`: longer explanation surfaced when user asks "what does this mean"
 *   - `type`: one of the discriminated union types below
 *   - `default`: starting value when no `seed_from` resolves
 *   - `seed_from`: dotted path into the brand's context.yaml (cold-start
 *      narrative). If the path resolves, that value is shown as the
 *      suggested answer; the user still confirms.
 *   - `required`: defaults true. Required fields block the run if the user
 *      tries to leave them empty.
 *
 * --------------------------------------------------------------------------
 * The `percent` unit bridge (read before declaring a percent range)
 * --------------------------------------------------------------------------
 *
 * `type: percent` fields live in TWO unit conventions at once, by design:
 *   - INTERNAL/storage + `range` checking: normalized fractions in [0,1].
 *     A manifest `range: {min: 0.05, max: 1.0}` means 5%..100%.
 *   - USER-FACING (chat card display, typed input, `effective_config` handed
 *     to the skill, context.yaml seeds like acos_target_pct): whole-number
 *     percents (45 = 45%).
 * parseFieldInput() normalizes any typed value > 1 by /100 BEFORE the range
 * check, normalizeSeedForField() does the same for seeds, and
 * toConsumableConfig()/formatFieldValue() denormalize back to whole numbers
 * on the way out. So "26.9" passing a {0.05, 1.0} range is CORRECT (it is
 * stored as 0.269) — an auditor reading only the manifest will think the
 * range contradicts the whole-number docs; it does not. Declare ranges in
 * fractions; document prompts/help in whole percents.
 *
 * --------------------------------------------------------------------------
 * Extra fields (user-added)
 * --------------------------------------------------------------------------
 *
 * Users can add their own keys to config.yaml outside the manifest (per the
 * "user could add to the config file" handling). Those keys round-trip
 * through reads/writes but never appear in the confirm-flow. The skill code
 * can read them via `config.extras` (see brand-config.ts).
 *
 * --------------------------------------------------------------------------
 * Schema evolution
 * --------------------------------------------------------------------------
 *
 * - Adding a new field: ship the new field with a `default`. Existing brands
 *   inherit the default silently on next run; the confirm flow will surface
 *   it for explicit user confirmation.
 * - Renaming a field: ship a migration in `harness/src/lib/calibration/
 *   migrations/<skill-id>-<n>.ts`. Never silently rewrite user data.
 * - Removing a field: leave it in the manifest as `deprecated: true` for one
 *   release; skill code stops reading it; the confirm flow hides it. After
 *   one release, drop the manifest entry — orphaned values stay in the user's
 *   config.yaml under `extras` until they manually clean up.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const fieldIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Field id must be snake_case (lowercase letter start, [a-z0-9_])',
  );

const seedFromSchema = z
  .string()
  .regex(
    /^context\.[a-zA-Z0-9_.[\]*]+$/,
    'seed_from must be a dotted path into context, e.g. "context.posture.stance"',
  )
  .optional();

const fieldBase = {
  id: fieldIdSchema,
  prompt: z.string().min(1),
  /** Short sentence-case noun phrase used as the confirmation card label.
   *  Defaults to a derivation from `prompt` (strips question mark, "for
   *  {brand_name}" suffix, capitalizes). Set explicitly when:
   *    - The label contains an acronym ("Hero SKUs", not "Hero skus")
   *    - The prompt is too long to read as a label
   *    - You want different copy in the prompt vs. the column header
   *  Should be under 30 characters and sentence case. */
  label: z.string().min(1).max(40).optional(),
  help: z.string().optional(),
  seed_from: seedFromSchema,
  required: z.boolean().default(true),
  deprecated: z.boolean().default(false),
};

// ---------------------------------------------------------------------------
// Field types (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Enum — pick one of N labeled options.
 *
 * Example manifest:
 *   type: enum
 *   options:
 *     - value: profit
 *       label: "Profit (lower ACoS, accept some volume loss)"
 *     - value: growth
 *       label: "Growth (volume first, accept higher ACoS)"
 *     - value: defend
 *       label: "Defend (hold position on hero SKUs)"
 *   default: growth
 */
export const enumFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('enum'),
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(2),
  default: z.string().optional(),
});

/**
 * Percent — a number in [0, 1] stored normalized, displayed as `XX%`.
 *
 * `range` clamps the editable surface so users can't enter 250%. Inclusive on
 * both ends.
 */
export const percentFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('percent'),
  default: z.number().min(0).max(1).optional(),
  range: z
    .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
    .refine((r) => r.min <= r.max, { message: 'range.min must be <= range.max' })
    .default({ min: 0, max: 1 }),
});

/**
 * Float — a floating point number. Use for unitless multipliers (dampening,
 * weights) where percent semantics don't apply.
 */
export const floatFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('float'),
  default: z.number().optional(),
  range: z
    .object({ min: z.number(), max: z.number() })
    .refine((r) => r.min <= r.max, { message: 'range.min must be <= range.max' })
    .optional(),
  decimals: z.number().int().min(0).max(6).default(2),
});

/**
 * Int — an integer (counts, day windows, click minimums).
 */
export const intFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('int'),
  default: z.number().int().optional(),
  range: z
    .object({ min: z.number().int(), max: z.number().int() })
    .refine((r) => r.min <= r.max, { message: 'range.min must be <= range.max' })
    .optional(),
});

/**
 * Bool — true/false toggle.
 */
export const boolFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('bool'),
  default: z.boolean().optional(),
});

/**
 * String — free-text. Use sparingly; prefer enum where possible.
 */
export const stringFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('string'),
  default: z.string().optional(),
  max_length: z.number().int().positive().default(280),
});

/**
 * ASIN list — comma-separated list of Amazon ASINs (validated B0[A-Z0-9]{8}).
 *
 * Common shape for "hero SKUs", "do-not-touch ASINs", etc.
 */
export const asinListFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('asin_list'),
  default: z.array(z.string()).default([]),
  max_items: z.number().int().positive().default(200),
});

/**
 * SKU list — comma-separated list of merchant SKUs (no validation pattern;
 * sellers use arbitrary internal codes).
 */
export const skuListFieldSchema = z.object({
  ...fieldBase,
  type: z.literal('sku_list'),
  default: z.array(z.string()).default([]),
  max_items: z.number().int().positive().default(500),
});

export const calibrationFieldSchema = z.discriminatedUnion('type', [
  enumFieldSchema,
  percentFieldSchema,
  floatFieldSchema,
  intFieldSchema,
  boolFieldSchema,
  stringFieldSchema,
  asinListFieldSchema,
  skuListFieldSchema,
]);

export type CalibrationField = z.infer<typeof calibrationFieldSchema>;
export type EnumField = z.infer<typeof enumFieldSchema>;
export type PercentField = z.infer<typeof percentFieldSchema>;
export type FloatField = z.infer<typeof floatFieldSchema>;
export type IntField = z.infer<typeof intFieldSchema>;
export type BoolField = z.infer<typeof boolFieldSchema>;
export type StringField = z.infer<typeof stringFieldSchema>;
export type AsinListField = z.infer<typeof asinListFieldSchema>;
export type SkuListField = z.infer<typeof skuListFieldSchema>;

// ---------------------------------------------------------------------------
// Top-level manifest block
// ---------------------------------------------------------------------------

/**
 * The `calibration:` block as it appears in skill.manifest.yaml. The full
 * manifest schema is in `harness/src/lib/manifest/` (existing); this is just
 * the OCL slice. We validate independently so missing/malformed calibration
 * blocks fail with a focused error message rather than mixing with run-kind
 * or sql_id errors.
 */
export const calibrationManifestSchema = z.object({
  /** Schema version of the calibration block itself. Bump on breaking
   *  changes to the field-type union. */
  schema_version: z.literal(1).default(1),
  /** Ordered field list — the confirm-flow renders in this order. */
  fields: z.array(calibrationFieldSchema).min(1),
});

export type CalibrationManifest = z.infer<typeof calibrationManifestSchema>;

/**
 * Convenience: pull just the calibration block out of a parsed skill manifest
 * object. Returns null when the skill has no calibration (the run skips the
 * confirm flow entirely in that case).
 */
export function extractCalibration(
  parsedManifest: unknown,
): CalibrationManifest | null {
  if (
    parsedManifest === null ||
    typeof parsedManifest !== 'object' ||
    !('calibration' in parsedManifest)
  ) {
    return null;
  }
  const block = (parsedManifest as { calibration: unknown }).calibration;
  if (block === null || block === undefined) return null;
  return calibrationManifestSchema.parse(block);
}

/**
 * Helper for the confirm-flow renderer: format the type-specific display
 * string for a stored value. Returns "(not set)" for null/undefined.
 */
export function formatFieldValue(
  field: CalibrationField,
  value: unknown,
): string {
  if (value === null || value === undefined) return '(not set)';
  switch (field.type) {
    case 'enum': {
      const opt = field.options.find((o) => o.value === value);
      return opt?.label ?? String(value);
    }
    case 'percent': {
      if (typeof value !== 'number') return String(value);
      return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
    }
    case 'float': {
      if (typeof value !== 'number') return String(value);
      return value.toFixed(field.decimals);
    }
    case 'int':
      return String(value);
    case 'bool':
      return value ? 'yes' : 'no';
    case 'string':
      return String(value);
    case 'asin_list':
    case 'sku_list': {
      if (!Array.isArray(value)) return String(value);
      if (value.length === 0) return '(none)';
      if (value.length <= 3) return value.join(', ');
      return `${value.slice(0, 3).join(', ')} +${value.length - 3} more`;
    }
  }
}

/**
 * Parse + validate a user-supplied edit for a field. Returns either a
 * validated value or a structured error describing what's wrong (so the
 * chat renderer can show a focused re-prompt). Inputs come from chat as
 * strings; this is where coercion happens.
 */
export type ParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function parseFieldInput(
  field: CalibrationField,
  raw: string,
): ParseResult {
  const trimmed = raw.trim();

  switch (field.type) {
    case 'enum': {
      // Accept both value and label (case-insensitive on label).
      const byValue = field.options.find((o) => o.value === trimmed);
      if (byValue) return { ok: true, value: byValue.value };
      const byLabel = field.options.find(
        (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
      );
      if (byLabel) return { ok: true, value: byLabel.value };
      // Also accept numeric pick (1-based) — common in chat flows.
      const idx = Number(trimmed);
      if (Number.isInteger(idx) && idx >= 1 && idx <= field.options.length) {
        return { ok: true, value: field.options[idx - 1]!.value };
      }
      return {
        ok: false,
        error: `Expected one of: ${field.options.map((o) => o.value).join(', ')}`,
      };
    }

    case 'percent': {
      // Accept "32", "32%", "0.32" — all mean 32%.
      //
      // The old form of this was `n > 1 ? n / 100 : n`, which stripped the "%"
      // BEFORE branching and so threw away the one signal that says which
      // reading the user meant. That silently corrupted the low end of any
      // field whose range reaches below 1%: TACoS goals declare
      // `min: 0.01, max: 1.0`, the out-of-range message tells the user
      // "between 1% and 100%", and typing the advertised floor of `1` stored
      // 1.0, i.e. 100%. No error, 100x wrong, on the value the UI just
      // recommended.
      //
      // So: an explicit "%" is honoured as the user's stated intent, a bare
      // number above 1 can only be a whole percent, and a bare number in
      // (0, 1] is resolved against the field's own range. If BOTH readings
      // land in range the input is genuinely ambiguous and we ask rather than
      // guess. Guessing is what caused the defect.
      //
      // This narrows the guess; it does not bless it. The percent-unit
      // convergence project removes the dual convention outright, at which
      // point this branch collapses to a single reading.
      const hasPercentSign = /%$/.test(trimmed);
      const cleaned = trimmed.replace(/%$/, '').trim();
      const n = Number(cleaned);
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'Expected a number (e.g. "32" or "32%")' };
      }

      const { min, max } = field.range;
      const inRange = (v: number): boolean => v >= min && v <= max;
      const asPercent = n / 100; // "1" or "1%" read as one percent
      const asFraction = n; // "0.01" read as one percent
      const outOfRange = {
        ok: false as const,
        error: `Out of range. Must be between ${(min * 100).toFixed(0)}% and ${(max * 100).toFixed(0)}%`,
      };
      const show = (v: number): string => `${Number((v * 100).toFixed(4))}%`;

      // An explicit "%" states the reading. Take the user at their word.
      if (hasPercentSign) {
        return inRange(asPercent) ? { ok: true, value: asPercent } : outOfRange;
      }
      // Above 1 there is only one sane reading: a whole percent.
      if (n > 1) {
        return inRange(asPercent) ? { ok: true, value: asPercent } : outOfRange;
      }

      // Bare decimal strictly between 0 and 1: the documented convention is
      // that this is a fraction ("0.32" means 32%), and nobody types "0.32"
      // meaning 0.32%. Keep that reading.
      if (n < 1) {
        return inRange(asFraction) ? { ok: true, value: asFraction } : outOfRange;
      }

      // Exactly 1, bare. This is the ONE genuinely ambiguous input, and the
      // one that corrupted TACoS goals: as a fraction it is 100% (the top of
      // the scale), as a percent it is 1% (the floor the error message
      // advertises). Only ask when the field's range actually admits both.
      const percentFits = inRange(asPercent);
      const fractionFits = inRange(asFraction);
      if (percentFits && fractionFits) {
        // Offer BOTH alternatives in explicit percent form. Suggesting the
        // decimal reading here would echo back the exact string the user just
        // typed, which is not a usable instruction.
        return {
          ok: false,
          error:
            `Ambiguous: "${trimmed}" could mean ${show(asPercent)} or ${show(asFraction)}. ` +
            `Write "${show(asPercent)}" or "${show(asFraction)}" to say which.`,
        };
      }
      if (fractionFits) return { ok: true, value: asFraction };
      if (percentFits) return { ok: true, value: asPercent };
      return outOfRange;
    }

    case 'float': {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'Expected a number' };
      }
      if (field.range && (n < field.range.min || n > field.range.max)) {
        return {
          ok: false,
          error: `Out of range. Must be between ${field.range.min} and ${field.range.max}`,
        };
      }
      return { ok: true, value: n };
    }

    case 'int': {
      const n = Number(trimmed);
      if (!Number.isInteger(n)) {
        return { ok: false, error: 'Expected a whole number' };
      }
      if (field.range && (n < field.range.min || n > field.range.max)) {
        return {
          ok: false,
          error: `Out of range. Must be between ${field.range.min} and ${field.range.max}`,
        };
      }
      return { ok: true, value: n };
    }

    case 'bool': {
      const lower = trimmed.toLowerCase();
      if (['y', 'yes', 'true', '1', 'on'].includes(lower))
        return { ok: true, value: true };
      if (['n', 'no', 'false', '0', 'off'].includes(lower))
        return { ok: true, value: false };
      return { ok: false, error: 'Expected yes/no' };
    }

    case 'string': {
      if (trimmed.length === 0 && field.required) {
        return { ok: false, error: 'Cannot be empty' };
      }
      if (trimmed.length > field.max_length) {
        return {
          ok: false,
          error: `Too long. Max ${field.max_length} characters.`,
        };
      }
      return { ok: true, value: trimmed };
    }

    case 'asin_list': {
      if (trimmed === '' || trimmed.toLowerCase() === 'none') {
        return { ok: true, value: [] };
      }
      const parts = trimmed
        .split(/[\s,]+/)
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);
      const invalid = parts.filter((p) => !/^B0[A-Z0-9]{8}$/.test(p));
      if (invalid.length > 0) {
        return {
          ok: false,
          error: `Invalid ASIN(s): ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ` +${invalid.length - 3} more` : ''}. ASINs look like B0XXXXXXXX.`,
        };
      }
      if (parts.length > field.max_items) {
        return {
          ok: false,
          error: `Too many ASINs (${parts.length}). Max ${field.max_items}.`,
        };
      }
      // Dedupe, preserve order.
      return { ok: true, value: Array.from(new Set(parts)) };
    }

    case 'sku_list': {
      if (trimmed === '' || trimmed.toLowerCase() === 'none') {
        return { ok: true, value: [] };
      }
      const parts = trimmed
        .split(/[\s,]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length > field.max_items) {
        return {
          ok: false,
          error: `Too many SKUs (${parts.length}). Max ${field.max_items}.`,
        };
      }
      return { ok: true, value: Array.from(new Set(parts)) };
    }
  }
}
