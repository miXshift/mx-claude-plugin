/**
 * Brand-config editor manifest.
 *
 * Declares which `context.yaml` fields the user can edit via the
 * `mixshift brand config <slug>` confirm-on-edit flow. Same chat
 * primitives as the skill OCL confirm-flow — the difference is the
 * storage layer (context.yaml dotted paths instead of config.yaml
 * skill blocks).
 *
 * --------------------------------------------------------------------------
 * Why a central manifest (not per-skill)
 * --------------------------------------------------------------------------
 *
 * Brand context is brand-wide, not per-skill. So the editable surface is
 * declared ONCE here, not in every skill's manifest. Skills that need a
 * brand-level value read it from context.yaml directly (and the value flows
 * through to their OCL as a seed via `seed_from: context.<path>`).
 *
 * --------------------------------------------------------------------------
 * Authoring guide
 * --------------------------------------------------------------------------
 *
 * Each entry has:
 *   - `field`: a CalibrationField shape (reused from skill OCL so the
 *      same chat renderer + input parser apply)
 *   - `context_path`: dotted path into context.yaml where the value lives
 *
 * Adding a new brand-level setting (e.g. forecast, category share):
 *   1. Add the path + zod schema to lib/context/schema.ts
 *   2. Add the entry below with a user-friendly label/prompt/help
 *   3. Run tests (the manifest's drift test asserts every path resolves
 *      to a known schema field)
 *
 * Non-trivial nested data (accounts table, sub-brands, structural events)
 * stays edited via the cold-start skill for now. Adding a table-editing
 * surface comes later.
 */

import type { CalibrationField } from '../calibration/manifest-schema.js';

export interface BrandContextEntry {
  /** Reuses CalibrationField so the chat renderer + input parser work
   *  identically to skill OCL. */
  field: CalibrationField;
  /** Dotted path inside context.yaml where this value lives.
   *  e.g. "management.acos_target_pct" */
  context_path: string;
}

export const BRAND_CONTEXT_MANIFEST: BrandContextEntry[] = [
  // -----------------------------------------------------------------------
  // Management — how the brand views performance
  // -----------------------------------------------------------------------
  {
    context_path: 'management.primary_metric',
    field: {
      id: 'primary_metric',
      label: 'Primary metric',
      prompt: 'Primary metric for {brand_name}?',
      help:
        'Drives how every skill frames performance. ACoS-thinkers look at ' +
        'ad-attributed efficiency; TACoS-thinkers look at total revenue. ' +
        'Set once at the brand level; can be flipped to RoAS/TRoAS display ' +
        'via profile.yaml::display.metric_framing.',
      type: 'enum',
      options: [
        { value: 'ACOS', label: 'ACoS (ad-attributed)' },
        { value: 'TACOS', label: 'TACoS (total revenue)' },
      ],
      required: true,
      deprecated: false,
    },
  },
  {
    context_path: 'management.acos_target_pct',
    field: {
      id: 'acos_target_pct',
      label: 'ACoS target',
      prompt: 'ACoS target for {brand_name}?',
      help:
        "The brand's reference ACoS target. Skills use this as the default " +
        "threshold for flagging exceptions. Surfaces on every skill's OCL " +
        'card as the seed value; per-skill overrides happen there.',
      type: 'percent',
      range: { min: 0.05, max: 1.0 },
      required: true,
      deprecated: false,
    },
  },
  {
    context_path: 'management.tacos_target_pct',
    field: {
      id: 'tacos_target_pct',
      label: 'TACoS target',
      prompt: 'TACoS target for {brand_name}?',
      help:
        'Total Advertising Cost of Sales target — ad spend over TOTAL ' +
        'ordered revenue. Catches over-investment in ads even when ACoS ' +
        'looks clean. Leave empty for ACoS-primary brands that don\'t ' +
        'track a separate TACoS target.',
      type: 'percent',
      range: { min: 0.01, max: 1.0 },
      required: false,
      deprecated: false,
    },
  },
  {
    context_path: 'management.attribution_window_days',
    field: {
      id: 'attribution_window_days',
      label: 'Attribution window (days)',
      prompt: 'Attribution window for {brand_name}?',
      help:
        'Days from click to attributed conversion. Common values: 7 (most ' +
        'sellers), 14 (longer consideration cycles), 30 (high-AOV). Drives ' +
        'how reports interpret the lag between ad spend and revenue.',
      type: 'int',
      default: 7,
      range: { min: 1, max: 60 },
      required: true,
      deprecated: false,
    },
  },

  // -----------------------------------------------------------------------
  // Goals — sales / performance targets
  // -----------------------------------------------------------------------
  {
    context_path: 'goals.monthly_total_sales_target',
    field: {
      id: 'monthly_total_sales_target',
      label: 'Monthly sales target',
      prompt: 'Monthly total sales target for {brand_name} (USD)?',
      help:
        'Used by monthly-performance-report and the portfolio scorecard. ' +
        'Total ordered revenue across all marketplaces. Leave empty if ' +
        'this brand operates without a monthly sales goal.',
      type: 'int',
      range: { min: 0, max: 100_000_000 },
      required: false,
      deprecated: false,
    },
  },
  {
    context_path: 'goals.tacos_goal_pct',
    field: {
      id: 'tacos_goal_pct',
      label: 'TACoS goal',
      prompt: 'TACoS goal (forward-looking) for {brand_name}?',
      help:
        'Aspirational TACoS — distinct from `tacos_target_pct` above which ' +
        "is the threshold for flagging. Use this when the brand's running " +
        'higher than ideal and you want monthly reports to track the gap ' +
        'between current and target.',
      type: 'percent',
      range: { min: 0.01, max: 1.0 },
      required: false,
      deprecated: false,
    },
  },
];

/**
 * Lookup an entry by its field id. Useful for tests + the apply flow when
 * resolving an edit back to its context_path.
 */
export function findContextEntry(
  fieldId: string,
): BrandContextEntry | undefined {
  return BRAND_CONTEXT_MANIFEST.find((e) => e.field.id === fieldId);
}
