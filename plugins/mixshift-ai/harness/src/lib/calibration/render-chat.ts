/**
 * Chat-format renderer for the confirm-on-run flow.
 *
 * The harness produces structured `ConfirmationPayload`s; Claude (in Cowork
 * chat) is the one actually conversing with the user. This module turns the
 * structured payload into a plain-text block Claude can paste into chat —
 * the "confirmation card" shown before every skill run.
 *
 * --------------------------------------------------------------------------
 * Design system alignment
 * --------------------------------------------------------------------------
 *
 * Cowork chat is plain monospace text — no HTML, no colors. But the design
 * system's voice rules still apply:
 *   - Sentence case for labels ("Primary objective", not "Primary Objective")
 *   - No emoji (the existing brand registry's ⭐ marker is the only
 *     exception we keep, by Sam's request)
 *   - Tabular alignment using monospace whitespace
 *   - Specific vocabulary: ACoS / TACoS / RoAS / Buy Box %, not ACOS / TACOS
 *   - Sentence-case help text, no exclamation points
 *
 * The same payload also feeds the HTML brand view renderer (later) — which
 * IS allowed to use design system tokens, cards, pills, etc.
 *
 * --------------------------------------------------------------------------
 * UX caveat: each skill may render slightly differently
 * --------------------------------------------------------------------------
 *
 * This renderer covers the common shape: a list of fields with prompts +
 * current values. Some skills will want extra hints (e.g. DHC may want to
 * show "your last run was YELLOW because of X — adjust dampening?"). Those
 * additions are skill-specific and live in the skill's own SKILL.md
 * instructions; the renderer here is the baseline.
 */

import {
  type ConfirmationPayload,
  type ConfirmationFieldEntry,
  type ApplyResult,
} from './confirm-flow.js';
import {
  type CalibrationField,
  formatFieldValue,
} from './manifest-schema.js';

// ---------------------------------------------------------------------------
// Top-level: full confirmation card
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Display name shown above the field list. Defaults to the skill_id. */
  skill_display_name?: string;
  /** Footer hint shown after the fields, before the action prompt. */
  footer?: string;
  /** Width to align field labels to, in characters. Default 22. */
  label_width?: number;
}

/**
 * Render the full confirmation card. Output is multi-line plain text;
 * caller (Claude) drops it into the chat verbatim.
 *
 * Returned shape lets the caller compose with surrounding chat:
 *   - `header` — one line, the skill + brand name
 *   - `fields` — the value list block
 *   - `extras_note` — optional note about user-added passthrough keys
 *   - `action_prompt` — the call-to-action ("Confirm and run, or edit?")
 *
 * Call `joinCard()` to glue them together with proper spacing.
 */
export function renderConfirmationCard(
  payload: ConfirmationPayload,
  options: RenderOptions = {},
): {
  header: string;
  fields: string;
  extras_note: string | null;
  blocking_note: string | null;
  action_prompt: string;
} {
  const skillName = options.skill_display_name ?? payload.skill_id;
  const labelWidth = options.label_width ?? 22;

  const header = payload.is_first_run
    ? `${skillName} — ${payload.brand_name} (first run — review calibration before running)`
    : `${skillName} — ${payload.brand_name} (review calibration)`;

  // Field block
  const lines: string[] = [];
  for (const entry of payload.fields) {
    lines.push(renderFieldLine(entry, labelWidth));
    const hint = renderSourceHint(entry);
    if (hint) lines.push(`${''.padStart(labelWidth + 2)}${hint}`);
  }
  const fields = lines.join('\n');

  const extras_note =
    Object.keys(payload.extras).length > 0
      ? renderExtrasNote(payload.extras)
      : null;

  const blocking_note = payload.blocking.has_missing_required
    ? renderBlockingNote(payload.blocking.missing_keys)
    : null;

  const action_prompt = payload.blocking.has_missing_required
    ? `Some required fields are unset. Choose a number above to set, or "cancel".`
    : payload.is_first_run
      ? `Confirm and run, or edit a field?  [number to edit / "run" / "cancel"]`
      : `Confirm and run, or edit?  [Enter / number to edit / "cancel"]`;

  return {
    header,
    fields,
    extras_note,
    blocking_note,
    action_prompt,
  };
}

/**
 * Convenience: render the full card and glue the parts into one string.
 * Useful when the caller doesn't need to interleave the parts with other
 * chat content.
 */
export function joinCard(
  parts: ReturnType<typeof renderConfirmationCard>,
): string {
  const blocks: string[] = [parts.header, '', parts.fields];
  if (parts.extras_note) blocks.push('', parts.extras_note);
  if (parts.blocking_note) blocks.push('', parts.blocking_note);
  blocks.push('', parts.action_prompt);
  return blocks.join('\n');
}

// ---------------------------------------------------------------------------
// Per-field rendering
// ---------------------------------------------------------------------------

/**
 * One field line in the confirmation card. Numbered prefix so the user
 * can say "edit 2" without retyping the field id.
 *
 * Format:
 *   `  1. Primary objective       Growth`
 *   `  2. ACoS target (non-brand) 32%`
 */
function renderFieldLine(entry: ConfirmationFieldEntry, labelWidth: number): string {
  const num = entryIndex(entry).toString().padStart(2, ' ');
  const label = humanLabel(entry.field).padEnd(labelWidth);
  const value = entry.display;
  return `  ${num}. ${label}  ${value}`;
}

/**
 * Source hint shown beneath a field. Surfaces the seed/default origin so
 * users know whether they're confirming their own past edit, a context
 * inference, or a vanilla default.
 *
 * Skipped for `stored` source on subsequent runs — that's the normal
 * confirmation path and doesn't need noise.
 */
function renderSourceHint(entry: ConfirmationFieldEntry): string | null {
  switch (entry.source) {
    case 'stored':
      return null;
    case 'seed':
      return `(from your cold-start notes — confirm or edit)`;
    case 'default':
      return `(default — set explicitly if this isn't right)`;
    case 'missing':
      return entry.field.required
        ? `(required — must be set before running)`
        : `(optional — leave unset to skip)`;
  }
}

function renderExtrasNote(extras: Record<string, unknown>): string {
  const keys = Object.keys(extras);
  const sample = keys.slice(0, 3).join(', ');
  const overflow = keys.length > 3 ? `, +${keys.length - 3} more` : '';
  return `Note: ${keys.length} user-added field(s) in your config will round-trip but aren't edited here: ${sample}${overflow}`;
}

function renderBlockingNote(missing: string[]): string {
  return `Missing required: ${missing.join(', ')}`;
}

function entryIndex(entry: ConfirmationFieldEntry & { _idx?: number }): number {
  // Index is attached by the parent renderer via a small dance below.
  return entry._idx ?? 0;
}

// ---------------------------------------------------------------------------
// Per-field re-prompt (after the user says "edit 2")
// ---------------------------------------------------------------------------

/**
 * Render the prompt for editing one field. Used after the user picks
 * a field number off the main card.
 *
 * For enum fields, lists the available options inline. For percent/float/
 * int, shows the range. For ASIN/SKU lists, mentions the format expectation.
 */
export function renderFieldEditPrompt(
  field: CalibrationField,
  current: unknown | undefined,
  brandName: string,
): string {
  const lines: string[] = [];
  lines.push(interpolatePrompt(field.prompt, brandName));
  if (field.help) lines.push(field.help);

  switch (field.type) {
    case 'enum':
      lines.push('Options:');
      field.options.forEach((opt, i) => {
        lines.push(`  ${i + 1}. ${opt.label}`);
      });
      break;
    case 'percent':
      lines.push(
        `Range: ${pct(field.range.min)}–${pct(field.range.max)}. Accepts "32", "32%", or "0.32".`,
      );
      break;
    case 'float':
      if (field.range)
        lines.push(`Range: ${field.range.min}–${field.range.max}`);
      break;
    case 'int':
      if (field.range)
        lines.push(`Range: ${field.range.min}–${field.range.max} (whole numbers)`);
      break;
    case 'bool':
      lines.push(`Answer yes or no.`);
      break;
    case 'asin_list':
      lines.push(
        `Comma-separated ASINs (e.g. B07XYZ1234, B08ABC9876), or "none".`,
      );
      break;
    case 'sku_list':
      lines.push(`Comma-separated SKUs (or "none").`);
      break;
    case 'string':
      // No extra hint — prompt is enough.
      break;
  }

  if (current !== undefined) {
    lines.push(`Current value: ${formatFieldValue(field, current)}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation feedback
// ---------------------------------------------------------------------------

/**
 * Render validation issues from an ApplyResult so the user knows what
 * to fix on the next attempt. Issues are presented one per line, field id
 * humanized via the manifest's prompt where possible.
 */
export function renderValidationIssues(
  result: ApplyResult,
  fieldsById: Map<string, CalibrationField>,
): string {
  if (result.validation_issues.length === 0) return '';
  const lines = ['Could not save — please fix:'];
  for (const issue of result.validation_issues) {
    const field = fieldsById.get(issue.field);
    const label = field ? humanLabel(field) : issue.field;
    lines.push(`  - ${label}: ${issue.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Post-run confirmation (write-back)
// ---------------------------------------------------------------------------

/**
 * Short message confirming the persistence decision after a run. Goes in
 * chat after the skill output. Examples:
 *
 *   "Saved your edits to Skratch's mx-daily-health-check config."
 *   "Used your edits for this run only. Run again to re-set on Skratch."
 *   "Ran with existing config."
 */
export function renderPersistenceFooter(
  result: ApplyResult,
  brandName: string,
  skillDisplayName: string,
): string {
  if (result.status !== 'ok') return '';
  if (result.did_persist) {
    return `Saved your edits to ${brandName}'s ${skillDisplayName} config.`;
  }
  return ''; // Don't clutter the chat on confirm-as-is or use-once.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the column label for the confirmation card.
 *
 * Priority:
 *   1. Explicit `field.label` from the manifest (authors should set this
 *      when the auto-derivation mangles an acronym like SKU/ASIN/RoAS).
 *   2. Strip-prompt heuristic — works when prompts read like questions
 *      that decompose into a short noun phrase.
 *   3. Snake_case id fallback.
 *
 * "Primary objective for {brand_name} right now?" → "Primary objective"
 * "nb_acos_target"                                → "Nb acos target"
 *                                                    (rare — authors should
 *                                                    write a label or a
 *                                                    better prompt)
 */
function humanLabel(field: CalibrationField): string {
  if (field.label && field.label.length > 0) return field.label;

  // Strip trailing "?" and any "for {brand_name}..." suffix.
  const trimmed = field.prompt
    .replace(/\?$/, '')
    .replace(/\s*for\s+\{brand_name\}.*$/i, '')
    .replace(/\s*for\s+the\s+brand.*$/i, '')
    .replace(/\s*right now$/i, '')
    .trim();
  // If the cleaned prompt is short enough, use it. Otherwise fall back to
  // a snake_case → sentence transform on the id.
  if (trimmed.length > 0 && trimmed.length <= 36) {
    // Force sentence case (capitalize first letter only).
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return field.id
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function interpolatePrompt(prompt: string, brandName: string): string {
  return prompt.replace(/\{brand_name\}/g, brandName);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ---------------------------------------------------------------------------
// Indexing helper (attaches _idx to entries for stable numbering)
// ---------------------------------------------------------------------------

/**
 * Mutate the payload entries to attach a 1-based index. The renderer uses
 * this index for the "1." / "2." prefix and the user references it back
 * when saying "edit 2". Stable across re-renders for the same payload.
 */
export function indexConfirmationEntries(payload: ConfirmationPayload): void {
  payload.fields.forEach((entry, i) => {
    (entry as ConfirmationFieldEntry & { _idx: number })._idx = i + 1;
  });
}
