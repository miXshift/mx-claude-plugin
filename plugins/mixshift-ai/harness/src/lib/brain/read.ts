/**
 * The Brand Brain accessor: the ONLY way skills and harness commands read
 * brain data. Today it reads the local yaml cache; at P2 it fetches from
 * the brain service with local caching. Because every consumer goes
 * through this module, that promotion is a transport swap that touches
 * exactly one file.
 *
 * Also owns the cross-tier resolution helpers (Tier 3 context.yaml wins
 * over Tier 2 brain; see the precedence note in lib/brain/schema.ts).
 * OCL sits ABOVE both and is applied by the calibration layer at the
 * skill boundary, not here.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { brandBrainSchema, type BrandBrain } from './schema.js';
import { brainPath } from '../paths/resolve.js';
import { validateBrandContext } from '../context/load.js';
import { formatZodError } from '../profile/format-error.js';

export type LoadBrainResult =
  | { ok: true; brain: BrandBrain; path: string }
  | {
      ok: false;
      path: string;
      kind: 'file_missing' | 'malformed_yaml' | 'schema_violation';
      errors: string[];
    };

/**
 * Load + validate the brain document for a brand. Never throws for the
 * expected absent case (brand keyed but fetch hasn't run, or pre-brain
 * install): callers branch on `ok`.
 */
export async function loadBrain(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<LoadBrainResult> {
  const path = brainPath(brandSlug, dataDirOverride);

  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return {
        ok: false,
        path,
        kind: 'file_missing',
        errors: [
          `No brand-brain.yaml for "${brandSlug}". Run ` +
            `\`mixshift brand brain fetch ${brandSlug}\` to populate it.`,
        ],
      };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, path, kind: 'malformed_yaml', errors: [message] };
  }

  const result = brandBrainSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      path,
      kind: 'schema_violation',
      errors: [formatZodError(result.error, `brand-brain.yaml for ${brandSlug}`)],
    };
  }
  return { ok: true, brain: result.data, path };
}

/**
 * Persist a brain document (atomic: write temp + rename). Used by the
 * fetch pipeline and the observation applier. Skills never write.
 */
export async function saveBrain(
  brain: BrandBrain,
  dataDirOverride?: string,
): Promise<{ path: string }> {
  const path = brainPath(brain.brand_slug, dataDirOverride);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, stringifyYaml(brain), 'utf-8');
  await rename(tmp, path);
  return { path };
}

/** Where a resolved field's value came from, for output labeling. */
export type FieldSource = 'context' | 'brain';

export interface ResolvedField<T> {
  value: T;
  /** context = Tier 3 (AM-confirmed, render as authoritative);
   *  brain = Tier 2 (system pre-fill, render with a "confirm?" label). */
  source: FieldSource;
  /** Tier 2 only: when the source data was fetched (staleness display). */
  fetched_at?: string;
}

/**
 * The first-slice field resolver: the brand's ACoS target.
 *
 * Precedence: context.yaml management.acos_target_pct (Tier 3) wins;
 * falls back to brain seller.acos_target_pct (Tier 2, labeled
 * pre-filled). Returns null when neither tier has it; OCL overrides and
 * skill defaults are the caller's layers above this.
 *
 * The first consumer is mx-daily-health-check, which previously failed
 * closed when no cold-start had populated the target.
 */
export async function resolveAcosTargetPct(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<ResolvedField<number> | null> {
  const ctx = await validateBrandContext(brandSlug, dataDirOverride);
  if (ctx.ok) {
    const v = ctx.context.management?.acos_target_pct;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return { value: v, source: 'context' };
    }
  }

  const brain = await loadBrain(brandSlug, dataDirOverride);
  if (brain.ok) {
    const v = brain.brain.seller?.acos_target_pct;
    if (typeof v === 'number' && Number.isFinite(v)) {
      return {
        value: v,
        source: 'brain',
        fetched_at: brain.brain.sources.seller?.fetched_at,
      };
    }
  }

  return null;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
