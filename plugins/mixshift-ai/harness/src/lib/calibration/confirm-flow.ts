/**
 * Confirm-on-run flow — the unified surface that handles both first-run
 * calibration AND every subsequent run's "show current config + let user
 * edit" prompt.
 *
 * --------------------------------------------------------------------------
 * Why one flow for both cases
 * --------------------------------------------------------------------------
 *
 * First-run has empty fields; subsequent runs have stored values. The
 * presentation is identical — show every manifest field with its current
 * value (or `(not set)` for empty), let the user confirm or edit. This
 * collapses what was previously a separate "wizard" + "edit" surface into
 * one mental model: every run starts with a confirmation card.
 *
 * The user never sees calendar-based staleness checks or version-bump
 * re-wizards. The config is sovereign once set; every run lets them adjust.
 *
 * --------------------------------------------------------------------------
 * Two-phase contract (so Claude can drive it from chat)
 * --------------------------------------------------------------------------
 *
 * 1. `prepareConfirmation(...)` — pure read. Returns a structured payload
 *    describing every manifest field's current state (stored, seed, default,
 *    effective). The chat renderer turns this into the confirmation card.
 *
 * 2. `applyConfirmation(payload, decision)` — write. Takes the user's
 *    decision (confirm as-is / edit with edits / edit ephemerally), validates,
 *    persists if requested, returns the effective config + did_persist.
 *
 * Splitting like this lets Claude (or a CLI prompt loop) own the
 * back-and-forth while the harness owns parsing + persistence.
 *
 * --------------------------------------------------------------------------
 * Seed resolution
 * --------------------------------------------------------------------------
 *
 * Each field can declare `seed_from: context.<path>` — e.g. `context.posture.
 * stance` for the objective field. On first run (or for any field with no
 * stored value), we resolve the path against the brand's `context.yaml` and
 * present that as the suggested answer. The user still has to confirm; we
 * never inherit silently.
 *
 * If the path doesn't resolve, the field falls back to its manifest `default`.
 * If there's no default either, the field surfaces as "(not set)" and the
 * run is blocked until the user enters a value (when `required: true`).
 */

import { readFile } from 'node:fs/promises';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { contextPath, runOclPath } from '../paths/resolve.js';
import {
  type CalibrationManifest,
  type CalibrationField,
  parseFieldInput,
  formatFieldValue,
} from './manifest-schema.js';
import {
  buildSkillConfigView,
  composeSkillBlock,
  readBrandConfig,
  saveSkillConfig,
  validateAgainstManifest,
  type SkillConfigView,
} from './brand-config.js';
import {
  resolveBrandFields,
  brandFieldKeyForContextPath,
} from '../brain/read.js';
import { appendCaptureDiscoveries } from '../brain/discoveries.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';

// ---------------------------------------------------------------------------
// Payload + decision shapes (the two-phase contract)
// ---------------------------------------------------------------------------

export type FieldValueSource =
  | 'stored' // value came from config.yaml::<skill_id>
  | 'seed' // value came from context.yaml via seed_from
  | 'default' // value came from manifest default
  | 'missing'; // no value available — blocks run if field.required

export interface ConfirmationFieldEntry {
  field: CalibrationField;
  /** Raw value from config.yaml::<skill_id> (undefined if absent). */
  stored_value: unknown | undefined;
  /** Value resolved from context.yaml via seed_from (undefined if path
   *  doesn't resolve or no seed_from declared). */
  seed_value: unknown | undefined;
  /** Manifest default (undefined if none declared). */
  default_value: unknown | undefined;
  /** What the skill would use right now if no edits happen. */
  effective_value: unknown | undefined;
  /** Where effective_value came from. */
  source: FieldValueSource;
  /** Pre-formatted display string for the chat renderer. */
  display: string;
}

export interface ConfirmationPayload {
  skill_id: string;
  brand_slug: string;
  brand_name: string;
  is_first_run: boolean;
  fields: ConfirmationFieldEntry[];
  /** User-added keys (outside the manifest). Round-tripped on save;
   *  not rendered in the confirm card. */
  extras: Record<string, unknown>;
  blocking: {
    has_missing_required: boolean;
    missing_keys: string[];
  };
}

/**
 * The user's decision after seeing the confirmation card.
 *   - `confirm`: run with the effective_value of every field. No write.
 *   - `edit`: apply the provided edits (keyed by field.id), then decide
 *      whether to persist (save: true) or use for this run only (save: false).
 *   - `cancel`: don't run. No write.
 */
export type ConfirmationDecision =
  | { action: 'confirm' }
  | {
      action: 'edit';
      edits: Record<string, string>; // raw string inputs, parsed via parseFieldInput
      save: boolean; // true = persist to config.yaml; false = use once
    }
  | { action: 'cancel' };

export interface ApplyResult {
  status: 'ok' | 'validation_failed' | 'cancelled';
  /** The effective config for the run. Empty when cancelled. */
  effective_config: Record<string, unknown>;
  /** True if config.yaml was written. */
  did_persist: boolean;
  /** Path to config.yaml when did_persist === true. */
  saved_to: string | null;
  /** Issues encountered while validating user edits. Non-empty implies
   *  status === 'validation_failed' — caller should re-show the card with
   *  the issues highlighted. */
  validation_issues: Array<{ field: string; message: string }>;
  /** Shared brand fields the user just set+saved that were proposed for
   *  brand-wide promotion (GAP-04). Drives the end-of-run "I learned X"
   *  acknowledgment (renderPersistenceFooter). Empty/absent on confirm-as-is,
   *  use-once, skill-only edits, cancel, or validation failure. */
  captured?: Array<{ label: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Phase 1: prepare
// ---------------------------------------------------------------------------

export interface PrepareOptions {
  brandSlug: string;
  brandName: string;
  skillId: string;
  manifest: CalibrationManifest;
  dataDirOverride?: string;
}

/**
 * Read brand config + context, resolve every manifest field's current state.
 * No writes. The chat renderer turns the result into a confirmation card.
 */
export async function prepareConfirmation(
  opts: PrepareOptions,
): Promise<ConfirmationPayload> {
  const { brandSlug, brandName, skillId, manifest, dataDirOverride } = opts;

  // Stored values
  const { config: brandConfig } = await readBrandConfig(
    brandSlug,
    dataDirOverride,
  );
  const storedBlock = brandConfig[skillId];
  const view: SkillConfigView = buildSkillConfigView(storedBlock, manifest);

  // Context (for seeds). Missing context.yaml is OK — every seed_from just
  // resolves to undefined and the field falls through to default.
  const ctx = await tryReadContext(brandSlug, dataDirOverride);
  // Tier-2 brain fallback for seeds: resolve the registered brand-level fields
  // once (context + brain) so a field whose seed_from path is absent from
  // context.yaml can still pre-fill from a freshly fetched brain.
  const brandFields = await resolveBrandFields(brandSlug, dataDirOverride);

  const entries: ConfirmationFieldEntry[] = manifest.fields
    .filter((f) => !f.deprecated)
    .map((field): ConfirmationFieldEntry => {
      const stored_value = storedBlock?.[field.id];
      let seed_value = field.seed_from
        ? getByPath(ctx, stripContextPrefix(field.seed_from))
        : undefined;
      if (seed_value === undefined && field.seed_from) {
        // Context lacked it — fall back to the brand brain (Tier 2) for the
        // same logical field, when seed_from maps to a registered brand field.
        const key = brandFieldKeyForContextPath(
          stripContextPrefix(field.seed_from),
        );
        const resolved = key ? brandFields[key] : null;
        if (resolved && resolved.source === 'brain') {
          seed_value = resolved.value;
        }
      }
      // Reconcile units: brand state stores percentages whole (acos_target_pct:
      // 22), but the OCL `percent` type stores normalized [0,1]. Apply the same
      // rule parseFieldInput uses for typed input so seeded and typed values
      // agree. Idempotent for already-normalized values; no-op for non-percent.
      seed_value = normalizeSeedForField(field, seed_value);
      const default_value = hasDefault(field) ? field.default : undefined;

      // Effective resolution priority: stored > seed > default > missing
      let effective_value: unknown | undefined;
      let source: FieldValueSource;
      if (stored_value !== undefined) {
        effective_value = stored_value;
        source = 'stored';
      } else if (seed_value !== undefined) {
        effective_value = seed_value;
        source = 'seed';
      } else if (default_value !== undefined) {
        effective_value = default_value;
        source = 'default';
      } else {
        effective_value = undefined;
        source = 'missing';
      }

      return {
        field,
        stored_value,
        seed_value,
        default_value,
        effective_value,
        source,
        display: formatFieldValue(field, effective_value),
      };
    });

  const missing_keys = entries
    .filter((e) => e.field.required && e.source === 'missing')
    .map((e) => e.field.id);

  return {
    skill_id: skillId,
    brand_slug: brandSlug,
    brand_name: brandName,
    is_first_run: view.is_first_run,
    fields: entries,
    extras: view.extras,
    blocking: {
      has_missing_required: missing_keys.length > 0,
      missing_keys,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 2: apply
// ---------------------------------------------------------------------------

/**
 * Apply the user's confirmation decision. Returns the effective config to
 * hand to the skill, plus persistence status.
 *
 * Validation behavior: if any edit fails to parse, NOTHING is persisted and
 * status === 'validation_failed' with issues listed. Caller should re-render
 * the card with errors and re-prompt.
 */
export async function applyConfirmation(
  payload: ConfirmationPayload,
  decision: ConfirmationDecision,
  opts: { dataDirOverride?: string },
): Promise<ApplyResult> {
  if (decision.action === 'cancel') {
    return {
      status: 'cancelled',
      effective_config: {},
      did_persist: false,
      saved_to: null,
      validation_issues: [],
    };
  }

  // Build effective from the prepared payload's effective values.
  const effective: Record<string, unknown> = {};
  for (const entry of payload.fields) {
    if (entry.effective_value !== undefined) {
      effective[entry.field.id] = entry.effective_value;
    }
  }

  // Confirm-as-is: still check that no required field is missing.
  if (decision.action === 'confirm') {
    if (payload.blocking.has_missing_required) {
      return {
        status: 'validation_failed',
        effective_config: {},
        did_persist: false,
        saved_to: null,
        validation_issues: payload.blocking.missing_keys.map((k) => ({
          field: k,
          message: 'required, no value set',
        })),
      };
    }
    return {
      status: 'ok',
      effective_config: toConsumableConfig(payload.fields, effective),
      did_persist: false,
      saved_to: null,
      validation_issues: [],
    };
  }

  // Edit path: parse each edit, accumulate issues, bail on any failure.
  const issues: Array<{ field: string; message: string }> = [];
  const fieldsById = new Map(payload.fields.map((e) => [e.field.id, e.field]));
  for (const [key, raw] of Object.entries(decision.edits)) {
    const field = fieldsById.get(key);
    if (!field) {
      issues.push({ field: key, message: 'unknown field (not in manifest)' });
      continue;
    }
    const parsed = parseFieldInput(field, raw);
    if (!parsed.ok) {
      issues.push({ field: key, message: parsed.error });
      continue;
    }
    effective[key] = parsed.value;
  }

  // After edits, validate the merged set against the manifest as a
  // belt-and-suspenders check.
  const manifest = paddedManifestFromEntries(payload.fields);
  const sanity = validateAgainstManifest(effective, manifest);
  for (const issue of sanity.issues) {
    if (!issues.find((i) => i.field === issue.field)) issues.push(issue);
  }

  if (issues.length > 0) {
    return {
      status: 'validation_failed',
      effective_config: {},
      did_persist: false,
      saved_to: null,
      validation_issues: issues,
    };
  }

  // Persist (or not).
  if (!decision.save) {
    return {
      status: 'ok',
      effective_config: toConsumableConfig(payload.fields, effective),
      did_persist: false,
      saved_to: null,
      validation_issues: [],
    };
  }

  // Persist: compose manifest values + preserved extras, then save.
  const blockToSave = composeSkillBlock(effective, payload.extras);
  const { path } = await saveSkillConfig(
    payload.brand_slug,
    payload.skill_id,
    blockToSave,
    opts.dataDirOverride,
  );

  // GAP-04 capture-on-save: edited fields that map to a SHARED brand-context
  // field (2+/1 litmus via the registry) are proposed for context promotion —
  // appended to the brand's pending-discoveries file for the Phase-9 applier,
  // and surfaced as the end-of-run "I learned X" acknowledgment. Best-effort:
  // a discovery-write failure never fails the save.
  const shared = collectSharedCaptures(payload, decision, effective);
  if (shared.length > 0) {
    const observed_at = new Date().toISOString();
    await appendCaptureDiscoveries(
      payload.brand_slug,
      shared.map((s) => ({
        field: s.contextPath,
        proposed_value: s.consumableValue,
        source_skill: payload.skill_id,
        observed_by: 'confirm-flow',
        observed_at,
        confidence: 0.95,
      })),
      opts.dataDirOverride,
    ).catch(() => {
      // best-effort: a discovery-write failure never fails the save
    });
  }

  // Auto-publish the saved skill config block to the org store (best-effort,
  // bounded, non-throwing — the local save above is the durable result).
  await pushAfterWrite(payload.brand_slug, { dataDirOverride: opts.dataDirOverride });

  return {
    status: 'ok',
    effective_config: toConsumableConfig(payload.fields, effective),
    did_persist: true,
    saved_to: path,
    validation_issues: [],
    captured: shared.map((s) => ({
      label: s.field.label ?? humanizeFieldId(s.field.id),
      value: s.display,
    })),
  };
}

// ---------------------------------------------------------------------------
// Capture candidates (first-capture + "improve this skill")
//
// A skill runs on defaults + whatever brand context already provides. These
// helpers answer "what could the user set to sharpen this skill?" — the unset
// fields, ranked, each tagged with WHERE a captured value should persist per
// the 2+/1 litmus. The first-run flow surfaces the top few as micro-prompts;
// the `skill config --missing` surface lists them all on demand.
// ---------------------------------------------------------------------------

/** Where a captured value persists.
 *  - `context`: a shared brand field (its seed_from maps to a registered
 *    brand-context key — used by 2+ skills) → context.yaml (Tier 3), so every
 *    skill inherits it.
 *  - `ocl`: a skill-specific knob → config.yaml::<skill_id>. */
export type CaptureTier = 'context' | 'ocl';

/** Why a field is a capture candidate, in descending value:
 *  - `missing_required`: required, no value anywhere — the run can't proceed
 *    well without it (the first thing to ask).
 *  - `missing_optional`: optional, no value anywhere — the skill runs, but
 *    blind on this lever.
 *  - `using_default`: a skill default is in effect; the brand-specific value
 *    is simply unknown (lowest urgency — sharpening, not a gap). */
export type CaptureReason =
  | 'missing_required'
  | 'missing_optional'
  | 'using_default';

export interface CaptureCandidate {
  field: CalibrationField;
  /** Persistence target per the 2+/1 litmus (see CaptureTier). */
  target: CaptureTier;
  /** Context dotted-path (no `context.` prefix) when target === 'context';
   *  the writer uses it to place the value. Undefined for OCL targets. */
  context_path?: string;
  reason: CaptureReason;
  /** Higher surfaces first: missing_required 3 > missing_optional 2 >
   *  using_default 1. */
  priority: number;
}

const CAPTURE_PRIORITY: Record<CaptureReason, number> = {
  missing_required: 3,
  missing_optional: 2,
  using_default: 1,
};

/**
 * Select the fields worth capturing from a prepared confirmation payload —
 * the substrate for both the first-run micro-prompt and the
 * `skill config --missing` ("improve this skill") surface.
 *
 * A field is a candidate when the brand has not supplied a value: source is
 * `missing` (nothing anywhere) or `default` (skill fallback, brand value
 * unknown). Fields already resolved from context/brain (`seed`) or set by the
 * user (`stored`) are NOT candidates. Each candidate is tagged with its
 * persistence target via the registry-encoded litmus: if its seed_from maps to
 * a registered brand-context field it is shared → `context`, else it is this
 * skill's `ocl` knob.
 *
 * Ordered by priority (required gaps first), then manifest order within a tier.
 */
export function selectCaptureCandidates(
  payload: ConfirmationPayload,
  opts: { limit?: number } = {},
): CaptureCandidate[] {
  const candidates: CaptureCandidate[] = [];
  payload.fields.forEach((entry, idx) => {
    if (entry.field.deprecated) return;
    if (entry.source === 'stored' || entry.source === 'seed') return;
    const reason: CaptureReason =
      entry.source === 'missing'
        ? entry.field.required
          ? 'missing_required'
          : 'missing_optional'
        : 'using_default';
    const ctxPath = entry.field.seed_from
      ? stripContextPrefix(entry.field.seed_from)
      : undefined;
    const shared =
      ctxPath !== undefined && brandFieldKeyForContextPath(ctxPath) !== null;
    candidates.push({
      field: entry.field,
      target: shared ? 'context' : 'ocl',
      context_path: shared ? ctxPath : undefined,
      reason,
      priority: CAPTURE_PRIORITY[reason] * 1000 - idx, // stable within a tier
    });
  });
  candidates.sort((a, b) => b.priority - a.priority);
  return opts.limit !== undefined ? candidates.slice(0, opts.limit) : candidates;
}

// ---------------------------------------------------------------------------
// Per-run snapshot (audit trail)
// ---------------------------------------------------------------------------

/**
 * Write the effective config to runs/<skill_id>/<run_date>/ocl.yaml so
 * "what config did this run actually use" is answerable months later, even
 * if config.yaml has been edited since.
 *
 * Best-effort — failures here log to stderr but never block the run.
 */
export async function writeRunOclSnapshot(args: {
  brandSlug: string;
  skillId: string;
  runDate: string;
  effective: Record<string, unknown>;
  extras?: Record<string, unknown>;
  dataDirOverride?: string;
}): Promise<{ path: string } | { error: string }> {
  const path = runOclPath(
    args.brandSlug,
    args.skillId,
    args.runDate,
    args.dataDirOverride,
  );
  try {
    await mkdir(dirname(path), { recursive: true });
    const body =
      stringifyYaml(
        {
          skill_id: args.skillId,
          brand_slug: args.brandSlug,
          run_date: args.runDate,
          effective: args.effective,
          ...(args.extras && Object.keys(args.extras).length > 0
            ? { extras: args.extras }
            : {}),
        },
        { indent: 2, lineWidth: 0 },
      );
    await writeFile(path, body, 'utf-8');
    return { path };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDefault(field: CalibrationField): boolean {
  return (field as { default?: unknown }).default !== undefined;
}

/**
 * Reconcile a seed value's units to the OCL field's storage convention.
 *
 * Brand state (context.yaml + the Tier-2 brain) stores percentages as whole
 * numbers — `management.acos_target_pct: 22`, `bid_health.scale_threshold_pct:
 * 50` — but the OCL `percent` type stores normalized [0,1] and renders `* 100`.
 * Without this, a seeded 22 would display "2200%" and, on confirm-as-is,
 * persist 22 (out of every percent field's [0,1] range). We apply the SAME
 * `n > 1 ? n / 100 : n` rule parseFieldInput uses for typed input, so a seeded
 * percent and a hand-typed percent normalize identically. Idempotent for values
 * already in [0,1] (a brain that ever stored 0.22 passes through). Non-percent
 * fields and non-numeric values pass through untouched.
 */
function normalizeSeedForField(field: CalibrationField, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (field.type === 'percent' && typeof value === 'number') {
    return value > 1 ? value / 100 : value;
  }
  return value;
}

/**
 * Denormalize percent fields from the OCL's internal [0,1] representation to
 * the WHOLE-number convention that brand state, the warehouse, and every skill
 * formula use (acos_target 0.22 -> 22). Storage in config.yaml and the
 * confirm-card display stay [0,1]; only the CONSUMED config (what a skill reads
 * to run) is whole, so a skill's math is identical whether a threshold came
 * from brand context or an OCL override. Non-percent fields pass through.
 * Mirrors the context-editor's denormalize-on-write so every consumption
 * surface agrees on whole-number percents.
 */
function toConsumableConfig(
  fields: ConfirmationFieldEntry[],
  effective: Record<string, unknown>,
): Record<string, unknown> {
  const typeById = new Map(fields.map((e) => [e.field.id, e.field.type]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effective)) {
    out[k] =
      typeById.get(k) === 'percent' && typeof v === 'number'
        ? Math.round(v * 10000) / 100
        : v;
  }
  return out;
}

/**
 * GAP-04 capture-on-save: turn edited fields that map to a SHARED brand-context
 * field (registered in BRAND_FIELD_REGISTRY) into context-promotion proposals
 * on the brand's pending-discoveries file. Skill-only knobs (no seed_from, or a
 * seed_from that isn't a registered brand field) are NOT proposed. The proposed
 * value is the whole-number (consumable) form, matching context's convention.
 * Best-effort — never throws.
 */
interface SharedCapture {
  /** Dotted context path (seed_from minus the `context.` prefix). */
  contextPath: string;
  field: CalibrationField;
  /** Whole-number (consumable) value for the discovery proposal. */
  consumableValue: unknown;
  /** Human display string ("22%") for the end-of-run acknowledgment. */
  display: string;
}

/**
 * Collect the edited fields that map to a SHARED brand-context field (the 2+/1
 * litmus via BRAND_FIELD_REGISTRY). Only fires for edit+save (a genuine
 * capture); skill-only knobs (no seed_from, or a seed_from that isn't a
 * registered brand field) are excluded. Pure — no I/O.
 */
function collectSharedCaptures(
  payload: ConfirmationPayload,
  decision: ConfirmationDecision,
  effective: Record<string, unknown>,
): SharedCapture[] {
  if (decision.action !== 'edit' || !decision.save) return [];
  const consumable = toConsumableConfig(payload.fields, effective);
  const fieldsById = new Map(payload.fields.map((e) => [e.field.id, e.field]));
  const out: SharedCapture[] = [];
  for (const id of Object.keys(decision.edits)) {
    const field = fieldsById.get(id);
    if (!field?.seed_from) continue; // skill-only knob — no brand-context home
    const contextPath = stripContextPrefix(field.seed_from);
    if (!brandFieldKeyForContextPath(contextPath)) continue; // not a SHARED field
    out.push({
      contextPath,
      field,
      consumableValue: consumable[id],
      display: formatFieldValue(field, effective[id]),
    });
  }
  return out;
}

/** Fallback label when a calibration field declares no explicit `label`. */
function humanizeFieldId(id: string): string {
  return id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function stripContextPrefix(seedPath: string): string {
  return seedPath.replace(/^context\./, '');
}

/**
 * Lookup a dotted path against an arbitrary object. Returns undefined if
 * any segment doesn't resolve. Does NOT support array indexing — keep
 * seed_from paths simple.
 */
function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

async function tryReadContext(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<unknown> {
  const path = contextPath(brandSlug, dataDirOverride);
  try {
    const raw = await readFile(path, 'utf-8');
    return parseYaml(raw);
  } catch {
    // Missing or malformed context — fine, every seed_from will return undefined.
    return null;
  }
}

/**
 * Re-derive a manifest object from a confirmation payload's field entries.
 * Used to run validateAgainstManifest as a sanity check post-edit without
 * re-loading the file. The schema_version is synthetic since we don't have
 * the original manifest's version readily available here.
 */
function paddedManifestFromEntries(
  entries: ConfirmationFieldEntry[],
): CalibrationManifest {
  return {
    schema_version: 1,
    fields: entries.map((e) => e.field),
  };
}
