/**
 * Per-brand OCL (Objective Level Configuration) storage.
 *
 * File: `~/.mixshift/clients/<brand-slug>/config.yaml`
 *
 * Layout (intentionally minimal — no metadata, no timestamps, no version
 * numbers per the sovereignty rule):
 *
 *   ```yaml
 *   mx-daily-health-check:
 *     objective: growth
 *     nb_acos_target: 0.32
 *     hero_skus: [B07XYZ123, B08ABC456]
 *     dampening: 0.6
 *
 *   mx-runaway-spend-check:
 *     daily_spend_floor: 50
 *     # User-added comment — preserved by yaml lib? No. See "extras" below.
 *
 *   __extras:
 *     # User-added keys we don't recognize. See preserveExtras for details.
 * ```
 *
 * --------------------------------------------------------------------------
 * Sovereignty rules
 * --------------------------------------------------------------------------
 *
 * 1. The wizard/confirm-flow is the only path that writes to this file
 *    AUTOMATICALLY. All other writes require explicit user confirmation.
 * 2. We never delete or rename keys silently. Users can add custom keys
 *    inside a skill's block; those round-trip through read/write.
 * 3. Schema migrations are additive only. Old keys remain in the file
 *    forever unless the user explicitly resets.
 *
 * --------------------------------------------------------------------------
 * Extras (user-added keys)
 * --------------------------------------------------------------------------
 *
 * Inside a skill block (e.g. `mx-daily-health-check.{...}`), any key not in
 * the skill's calibration manifest is considered an "extra". Extras are:
 *   - Round-tripped on read/write (preserved verbatim)
 *   - Available to skill code via `getSkillConfig(...).extras`
 *   - Not surfaced in the confirm-flow (the wizard only shows manifest fields)
 *   - Not validated (it's the user's data; we don't second-guess)
 *
 * This lets power users add per-brand tweaks the skill knows how to read
 * but isn't part of the user-facing calibration set.
 */

import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { brandConfigPath } from '../paths/resolve.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';
import {
  type CalibrationField,
  type CalibrationManifest,
} from './manifest-schema.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The on-disk shape. Schema is intentionally permissive — every top-level
 * key is a skill_id, every value is a free-form record. Validation lives
 * at the per-skill access layer (manifest-driven), not at file read time.
 */
const skillBlockSchema = z.record(z.string(), z.unknown());

const brandConfigSchema = z.record(z.string(), skillBlockSchema);

export type BrandConfig = z.infer<typeof brandConfigSchema>;
export type SkillBlock = z.infer<typeof skillBlockSchema>;

/**
 * What skill code consumes: known fields (from manifest, validated + typed)
 * plus extras (user-added, unvalidated). `effective` is the merged result
 * the skill should actually use — defaults + stored values + manifest types.
 */
export interface SkillConfigView {
  /** Validated values for every field in the manifest. Missing values
   *  fall back to the field's default (or `undefined` if no default). */
  effective: Record<string, unknown>;
  /** Raw values from disk (no defaults applied, no type coercion). */
  stored: Record<string, unknown>;
  /** Manifest-defined keys for which the user has explicitly stored a value
   *  (i.e. confirmed via the wizard or hand-edited the file). */
  user_set_keys: string[];
  /** Keys present on disk but NOT in the manifest — user-added passthrough.
   *  Available to skill code that knows how to interpret them. */
  extras: Record<string, unknown>;
  /** True if the skill has no entry on disk yet — first run for this brand. */
  is_first_run: boolean;
  /** Manifest-defined keys for which neither a stored value nor a default
   *  exists. The confirm-flow MUST surface these or the run errors. */
  missing_required_keys: string[];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load the full per-brand config file. Returns an empty record if the file
 * doesn't exist (normal first-run state). Throws only on malformed YAML.
 */
export async function readBrandConfig(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<{ config: BrandConfig; source: 'file' | 'empty'; path: string }> {
  const path = brandConfigPath(brandSlug, dataDirOverride);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { config: {}, source: 'empty', path };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Brand config at ${path} is malformed YAML: ${message}\n` +
        `Hint: open the file and fix the YAML, or run ` +
        `\`mixshift skill config <skill> --brand ${brandSlug} --reset\` ` +
        `to wipe a specific skill's block.`,
    );
  }

  // Empty file (touched but never written) parses as null.
  if (parsed === null || parsed === undefined) {
    return { config: {}, source: 'file', path };
  }

  const result = brandConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Brand config at ${path} is structurally invalid (each top-level key ` +
        `must map to a skill_id → object of values).\n` +
        `First issue: ${result.error.issues[0]?.message ?? '(unknown)'}`,
    );
  }

  return { config: result.data, source: 'file', path };
}

// ---------------------------------------------------------------------------
// Per-skill access (the surface skill code uses)
// ---------------------------------------------------------------------------

/**
 * Build a SkillConfigView for one skill against its calibration manifest.
 *
 * This is the surface skill code SHOULD consume. It applies defaults,
 * computes "missing required" status, and partitions known fields from
 * user-added extras. Pure function over the input args — no I/O.
 */
export function buildSkillConfigView(
  storedBlock: SkillBlock | undefined,
  manifest: CalibrationManifest | null,
): SkillConfigView {
  const stored: Record<string, unknown> = storedBlock ?? {};
  const isFirstRun = storedBlock === undefined;

  // If the skill has no calibration manifest, everything stored is extras
  // and the skill can read whatever it likes.
  if (manifest === null) {
    return {
      effective: { ...stored },
      stored,
      user_set_keys: Object.keys(stored),
      extras: { ...stored },
      is_first_run: isFirstRun,
      missing_required_keys: [],
    };
  }

  const manifestKeys = new Set(manifest.fields.map((f) => f.id));

  const effective: Record<string, unknown> = {};
  const user_set_keys: string[] = [];
  const missing_required_keys: string[] = [];

  for (const field of manifest.fields) {
    if (field.deprecated) continue;
    if (Object.prototype.hasOwnProperty.call(stored, field.id)) {
      effective[field.id] = stored[field.id];
      user_set_keys.push(field.id);
    } else if (hasDefault(field)) {
      effective[field.id] = field.default;
    } else if (field.required) {
      missing_required_keys.push(field.id);
    }
  }

  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(stored)) {
    if (!manifestKeys.has(k)) extras[k] = stored[k];
  }

  return {
    effective,
    stored,
    user_set_keys,
    extras,
    is_first_run: isFirstRun,
    missing_required_keys,
  };
}

/**
 * Convenience: read config from disk + build the view in one shot.
 */
export async function getSkillConfig(
  brandSlug: string,
  skillId: string,
  manifest: CalibrationManifest | null,
  dataDirOverride?: string,
): Promise<SkillConfigView & { source: 'file' | 'empty' }> {
  const { config, source } = await readBrandConfig(brandSlug, dataDirOverride);
  const view = buildSkillConfigView(config[skillId], manifest);
  return { ...view, source };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Save (or replace) one skill's block in the per-brand config file.
 *
 * Round-trips other skills' blocks verbatim. Atomic via temp + rename.
 *
 * `values` should be the FULL block to persist — caller is responsible for
 * merging old extras with new known values. Use composeSkillBlock() to
 * help with that.
 */
export async function saveSkillConfig(
  brandSlug: string,
  skillId: string,
  values: SkillBlock,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const path = brandConfigPath(brandSlug, dataDirOverride);
  const { config: existing } = await readBrandConfig(brandSlug, dataDirOverride);

  const next: BrandConfig = { ...existing, [skillId]: values };
  await writeBrandConfigFile(path, next);
  return { path };
}

/**
 * Remove a skill's block entirely. Used by `mixshift skill config --reset`.
 * Idempotent — succeeds silently if the block isn't there.
 *
 * If the file would become empty (no skills left), it gets deleted entirely
 * to keep `ls ~/.mixshift/clients/<slug>/` clean.
 */
export async function resetSkillConfig(
  brandSlug: string,
  skillId: string,
  dataDirOverride?: string,
): Promise<{ existed: boolean; path: string }> {
  const path = brandConfigPath(brandSlug, dataDirOverride);
  const { config: existing, source } = await readBrandConfig(
    brandSlug,
    dataDirOverride,
  );
  if (source === 'empty' || !(skillId in existing)) {
    return { existed: false, path };
  }
  const next = { ...existing };
  delete next[skillId];

  if (Object.keys(next).length === 0) {
    try {
      await unlink(path);
    } catch {
      // Best-effort — if delete fails we still claim success since the
      // skill block is gone from the in-memory representation. The file
      // just sticks around empty.
    }
  } else {
    await writeBrandConfigFile(path, next);
  }
  // Auto-publish the reset to the org store (best-effort, bounded,
  // non-throwing — the local reset above is the durable result; a wholesale
  // local delete never force-deletes the org copy, only a rewrite publishes).
  await pushAfterWrite(brandSlug, { dataDirOverride });
  return { existed: true, path };
}

/**
 * Compose a save-ready block from (a) values produced by the wizard for
 * manifest fields plus (b) extras preserved from the previous on-disk
 * block. Caller passes the *current* extras (read once before the wizard
 * runs) to avoid races with parallel skill runs.
 */
export function composeSkillBlock(
  manifestValues: Record<string, unknown>,
  preservedExtras: Record<string, unknown>,
): SkillBlock {
  // Manifest values take precedence on key collision. (User can't accidentally
  // shadow a manifest field via an extra; the manifest is authoritative.)
  return { ...preservedExtras, ...manifestValues };
}

/**
 * Validate per-skill calibration values against the manifest. Used by the
 * confirm-flow before persistence, and by `--show` for displaying lint
 * status. Returns { ok, issues } — non-throwing so callers can render
 * issues inline.
 */
export function validateAgainstManifest(
  values: Record<string, unknown>,
  manifest: CalibrationManifest,
): { ok: boolean; issues: Array<{ field: string; message: string }> } {
  const issues: Array<{ field: string; message: string }> = [];
  for (const field of manifest.fields) {
    if (field.deprecated) continue;
    const present = Object.prototype.hasOwnProperty.call(values, field.id);
    if (!present) {
      if (field.required && !hasDefault(field)) {
        issues.push({ field: field.id, message: 'required, no value set' });
      }
      continue;
    }
    const issue = checkType(field, values[field.id]);
    if (issue) issues.push({ field: field.id, message: issue });
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasDefault(field: CalibrationField): boolean {
  return (field as { default?: unknown }).default !== undefined;
}

function checkType(field: CalibrationField, value: unknown): string | null {
  switch (field.type) {
    case 'enum':
      if (typeof value !== 'string') return `expected enum string`;
      if (!field.options.some((o) => o.value === value)) {
        return `not one of ${field.options.map((o) => o.value).join(', ')}`;
      }
      return null;
    case 'percent':
      if (typeof value !== 'number') return 'expected number';
      if (value < field.range.min || value > field.range.max) {
        return `out of range [${field.range.min}, ${field.range.max}]`;
      }
      return null;
    case 'float':
      if (typeof value !== 'number') return 'expected number';
      if (field.range && (value < field.range.min || value > field.range.max)) {
        return `out of range [${field.range.min}, ${field.range.max}]`;
      }
      return null;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return 'expected integer';
      if (field.range && (value < field.range.min || value > field.range.max)) {
        return `out of range [${field.range.min}, ${field.range.max}]`;
      }
      return null;
    case 'bool':
      if (typeof value !== 'boolean') return 'expected boolean';
      return null;
    case 'string':
      if (typeof value !== 'string') return 'expected string';
      if (value.length > field.max_length)
        return `too long (max ${field.max_length})`;
      return null;
    case 'asin_list':
      if (!Array.isArray(value)) return 'expected list of ASINs';
      for (const a of value) {
        if (typeof a !== 'string' || !/^B0[A-Z0-9]{8}$/.test(a)) {
          return `invalid ASIN "${String(a)}"`;
        }
      }
      if (value.length > field.max_items)
        return `too many items (max ${field.max_items})`;
      return null;
    case 'sku_list':
      if (!Array.isArray(value)) return 'expected list of SKUs';
      if (value.length > field.max_items)
        return `too many items (max ${field.max_items})`;
      return null;
  }
}

async function writeBrandConfigFile(
  path: string,
  config: BrandConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const yamlText = stringifyYaml(config, {
    indent: 2,
    lineWidth: 0, // never wrap — keeps user-readable values intact
  });

  // Atomic write: temp + rename.
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, yamlText, 'utf-8');
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    // chmod is a noop on Windows; tolerate.
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
