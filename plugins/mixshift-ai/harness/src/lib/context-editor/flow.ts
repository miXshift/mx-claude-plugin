/**
 * Brand-context confirm-on-edit flow.
 *
 * Mirror of the skill OCL flow (`lib/calibration/confirm-flow.ts`) but for
 * brand-level context.yaml fields. Same two-phase contract:
 *
 *   prepareBrandConfigEdit() — pure read. Builds a payload describing every
 *                              editable brand context field's current value
 *                              and where it came from. Chat renderer turns
 *                              this into the confirmation card.
 *
 *   applyBrandConfigEdit()   — write. Takes the user's decision, validates,
 *                              writes back to context.yaml at the right
 *                              dotted paths, bumps last_updated.
 *
 * --------------------------------------------------------------------------
 * Key differences from skill OCL flow
 * --------------------------------------------------------------------------
 *
 * 1. SOURCE TRUTH: brand context is the source of truth for these fields.
 *    There's no separate "stored" layer above context.yaml — the value in
 *    context IS the user-set value. So `source` is always 'stored' (when
 *    context has the field), 'default' (manifest default), or 'missing'.
 *    No 'seed' tier because context isn't seeded from anything deeper.
 *
 * 2. STORAGE: writes scatter across context.yaml at dotted paths using
 *    setNested(). The whole file is parsed → mutated → re-written, NOT
 *    a per-skill block replacement. Atomic via temp + rename in writer.
 *
 * 3. GATING: context.yaml must already exist (brand-context setup has run).
 *    Editing brand config on a brand with no context yet returns an
 *    error pointing at /mx-brand-context.
 *
 * 4. last_updated BUMP: every successful write updates
 *    context.yaml::last_updated to today's date. Keeps the freshness
 *    signal honest.
 */

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { contextPath } from '../paths/resolve.js';
import { setNested } from '../utils/set-nested.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';
import {
  type CalibrationField,
  parseFieldInput,
  formatFieldValue,
} from '../calibration/manifest-schema.js';
import {
  BRAND_CONTEXT_MANIFEST,
  findContextEntry,
  type BrandContextEntry,
} from './manifest.js';

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export type BrandContextSource = 'stored' | 'default' | 'missing';

export interface BrandContextFieldState {
  field: CalibrationField;
  context_path: string;
  /** Raw value from context.yaml at the dotted path (undefined if absent). */
  stored_value: unknown | undefined;
  /** Manifest default (undefined if none declared). */
  default_value: unknown | undefined;
  /** What the skill would use right now if no edits happen. */
  effective_value: unknown | undefined;
  source: BrandContextSource;
  /** Pre-formatted display string for the chat renderer. */
  display: string;
}

export interface BrandConfigPayload {
  brand_slug: string;
  brand_name: string;
  /** True when no context.yaml exists yet (brand isn't cold-started). The
   *  caller should NOT show the edit card in that case — user has to
   *  cold-start first. */
  context_missing: boolean;
  fields: BrandContextFieldState[];
  blocking: {
    has_missing_required: boolean;
    missing_keys: string[];
  };
}

export type BrandConfigDecision =
  | { action: 'confirm' }
  | { action: 'edit'; edits: Record<string, string> }
  | { action: 'cancel' };

export interface ApplyBrandConfigResult {
  status: 'ok' | 'validation_failed' | 'cancelled' | 'context_missing';
  /** The full updated context object after edits applied. Empty when
   *  cancelled or validation_failed. */
  updated_context: Record<string, unknown> | null;
  did_write: boolean;
  written_to: string | null;
  /** Number of fields whose values changed. Useful for the success
   *  footer ("saved 2 brand config edits"). */
  changed_field_count: number;
  validation_issues: Array<{ field: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Phase 1: prepare
// ---------------------------------------------------------------------------

export interface PrepareBrandConfigOptions {
  brandSlug: string;
  brandName: string;
  dataDirOverride?: string;
}

export async function prepareBrandConfigEdit(
  opts: PrepareBrandConfigOptions,
): Promise<BrandConfigPayload> {
  const ctx = await tryReadContextObject(opts.brandSlug, opts.dataDirOverride);

  if (ctx === null) {
    return {
      brand_slug: opts.brandSlug,
      brand_name: opts.brandName,
      context_missing: true,
      fields: [],
      blocking: { has_missing_required: false, missing_keys: [] },
    };
  }

  const fields: BrandContextFieldState[] = BRAND_CONTEXT_MANIFEST.filter(
    (e) => !e.field.deprecated,
  ).map((entry) => buildFieldState(entry, ctx));

  const missing_keys = fields
    .filter((f) => f.field.required && f.source === 'missing')
    .map((f) => f.field.id);

  return {
    brand_slug: opts.brandSlug,
    brand_name: opts.brandName,
    context_missing: false,
    fields,
    blocking: {
      has_missing_required: missing_keys.length > 0,
      missing_keys,
    },
  };
}

function buildFieldState(
  entry: BrandContextEntry,
  ctx: Record<string, unknown>,
): BrandContextFieldState {
  const stored_value = normalizePercentForDisplay(
    entry.field,
    getByPath(ctx, entry.context_path),
  );
  const default_value = hasDefault(entry.field)
    ? (entry.field as { default?: unknown }).default
    : undefined;

  let effective_value: unknown | undefined;
  let source: BrandContextSource;
  if (stored_value !== undefined) {
    effective_value = stored_value;
    source = 'stored';
  } else if (default_value !== undefined) {
    effective_value = default_value;
    source = 'default';
  } else {
    effective_value = undefined;
    source = 'missing';
  }

  return {
    field: entry.field,
    context_path: entry.context_path,
    stored_value,
    default_value,
    effective_value,
    source,
    display: formatFieldValue(entry.field, effective_value),
  };
}

// ---------------------------------------------------------------------------
// Phase 2: apply
// ---------------------------------------------------------------------------

export async function applyBrandConfigEdit(
  payload: BrandConfigPayload,
  decision: BrandConfigDecision,
  opts: { dataDirOverride?: string },
): Promise<ApplyBrandConfigResult> {
  if (payload.context_missing) {
    return {
      status: 'context_missing',
      updated_context: null,
      did_write: false,
      written_to: null,
      changed_field_count: 0,
      validation_issues: [],
    };
  }

  if (decision.action === 'cancel') {
    return {
      status: 'cancelled',
      updated_context: null,
      did_write: false,
      written_to: null,
      changed_field_count: 0,
      validation_issues: [],
    };
  }

  // Confirm-as-is: nothing to write. Required fields still get checked so
  // we don't silently leave a brand with a missing required value.
  if (decision.action === 'confirm') {
    if (payload.blocking.has_missing_required) {
      return {
        status: 'validation_failed',
        updated_context: null,
        did_write: false,
        written_to: null,
        changed_field_count: 0,
        validation_issues: payload.blocking.missing_keys.map((k) => ({
          field: k,
          message: 'required, no value set',
        })),
      };
    }
    return {
      status: 'ok',
      updated_context: null,
      did_write: false,
      written_to: null,
      changed_field_count: 0,
      validation_issues: [],
    };
  }

  // Edit path: parse + validate every input, bail if any fail.
  const issues: Array<{ field: string; message: string }> = [];
  const parsedEdits: Array<{ path: string; value: unknown; field_id: string }> = [];
  for (const [fieldId, raw] of Object.entries(decision.edits)) {
    const entry = findContextEntry(fieldId);
    if (!entry) {
      issues.push({ field: fieldId, message: 'unknown brand-config field' });
      continue;
    }
    const parsed = parseFieldInput(entry.field, raw);
    if (!parsed.ok) {
      issues.push({ field: fieldId, message: parsed.error });
      continue;
    }
    parsedEdits.push({
      path: entry.context_path,
      value: denormalizePercentForStorage(entry.field, parsed.value),
      field_id: fieldId,
    });
  }
  if (issues.length > 0) {
    return {
      status: 'validation_failed',
      updated_context: null,
      did_write: false,
      written_to: null,
      changed_field_count: 0,
      validation_issues: issues,
    };
  }

  // Read current context, apply edits at dotted paths, bump last_updated.
  const path = contextPath(payload.brand_slug, opts.dataDirOverride);
  let rawText: string;
  try {
    rawText = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        status: 'context_missing',
        updated_context: null,
        did_write: false,
        written_to: null,
        changed_field_count: 0,
        validation_issues: [],
      };
    }
    throw err;
  }

  const ctxObj = (parseYaml(rawText) ?? {}) as Record<string, unknown>;
  let changedCount = 0;
  for (const edit of parsedEdits) {
    const before = getByPath(ctxObj, edit.path);
    if (!deepEqual(before, edit.value)) {
      setNested(ctxObj, edit.path, edit.value);
      changedCount += 1;
      // An explicit user edit of the ACOS target supersedes bootstrap
      // provenance: stamp it user-confirmed so skills stop treating the
      // value as an unconfirmed placeholder, and so a stale 'default'
      // can never stick to a number the user actually set.
      if (edit.path === 'management.acos_target_pct') {
        setNested(ctxObj, 'management.acos_target_source', 'user');
      }
    }
  }

  // Bump last_updated to today (ISO date, matches schema)
  if (changedCount > 0) {
    const today = new Date().toISOString().slice(0, 10);
    setNested(ctxObj, 'last_updated', today);
  }

  // Re-stringify + atomic write. Skip the file write if nothing actually
  // changed — keeps the on-disk timestamp honest.
  if (changedCount === 0) {
    return {
      status: 'ok',
      updated_context: ctxObj,
      did_write: false,
      written_to: null,
      changed_field_count: 0,
      validation_issues: [],
    };
  }
  await writeContextFile(path, ctxObj);
  // Auto-publish the edited context.yaml to the org store (best-effort,
  // bounded, non-throwing — the local write above is the durable result).
  await pushAfterWrite(payload.brand_slug, { dataDirOverride: opts.dataDirOverride });
  return {
    status: 'ok',
    updated_context: ctxObj,
    did_write: true,
    written_to: path,
    changed_field_count: changedCount,
    validation_issues: [],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasDefault(field: CalibrationField): boolean {
  return (field as { default?: unknown }).default !== undefined;
}

/**
 * context.yaml stores percentages as WHOLE numbers (acos_target_pct: 22) — the
 * warehouse / brain / cold-start convention. But the CalibrationField `percent`
 * type that drives this editor's display (formatFieldValue) and input parsing
 * (parseFieldInput) works in [0,1]. These two helpers bridge that boundary so
 * the editor reads/writes whole numbers while the [0,1] machinery is unchanged.
 * Both are idempotent for values already in [0,1], so they're safe over any
 * legacy normalized data left by the pre-fix editor.
 */
function normalizePercentForDisplay(
  field: CalibrationField,
  v: unknown,
): unknown {
  if (field.type === 'percent' && typeof v === 'number') {
    return v > 1 ? v / 100 : v;
  }
  return v;
}

function denormalizePercentForStorage(
  field: CalibrationField,
  v: unknown,
): unknown {
  if (field.type === 'percent' && typeof v === 'number') {
    // parseFieldInput already produced a [0,1] fraction; scale back to the
    // whole-number storage convention, rounding to 2 decimals to clear
    // floating-point noise (e.g. 0.07 * 100).
    return Math.round(v * 10000) / 100;
  }
  return v;
}

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

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(ao[k], bo[k]));
}

async function tryReadContextObject(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<Record<string, unknown> | null> {
  const path = contextPath(brandSlug, dataDirOverride);
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeContextFile(
  path: string,
  obj: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const yamlText = stringifyYaml(obj, { indent: 2, lineWidth: 0 });
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, yamlText, 'utf-8');
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    // Windows tolerant.
  }
  await rename(tmpPath, path);
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
