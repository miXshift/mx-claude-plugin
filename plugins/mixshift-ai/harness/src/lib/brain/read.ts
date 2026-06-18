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

// ---------------------------------------------------------------------------
// Generalized cross-tier resolution (the accessor seam)
//
// Skills read brand-level fields THROUGH here, never by parsing a brand file
// directly. `getBrandField` / `resolveBrandFields` resolve a logical field
// across the tiers (Tier 3 context.yaml wins; Tier 2 brain pre-fills),
// returning the value + its source so output can label confirmed (context)
// vs pre-filled (brain) vs gap (absent). OCL still sits above this, applied
// by the calibration layer at the skill boundary.
// ---------------------------------------------------------------------------

type ContextResult = Awaited<ReturnType<typeof validateBrandContext>>;

/**
 * Where a brand-level field lives in each tier. `contextPath`-only =
 * Tier-3-only (human judgment the brain can't derive: posture, targets,
 * protected terms). `brainPath`-only = Tier-2-only (auto-derived telemetry:
 * recent activity, hero ASINs). Dotted paths support numeric array indices
 * (e.g. `accounts.0.marketplace`).
 */
interface FieldSpec {
  contextPath?: string;
  brainPath?: string;
  /** sources[] entry whose fetched_at stamps a brain-sourced value. */
  brainSource?: keyof BrandBrain['sources'];
}

/**
 * The brand-level fields 2+ skills consume (the crossover set) — the single
 * source of truth for "what is brand context", so skills and the
 * `brand context resolve` command agree. Add a field here when a SECOND
 * skill needs it (the 2+/1 litmus); single-skill knobs stay in OCL.
 */
const BRAND_FIELD_REGISTRY = {
  // Both tiers — context wins, brain pre-fills.
  acos_target_pct: { contextPath: 'management.acos_target_pct', brainPath: 'seller.acos_target_pct', brainSource: 'seller' },
  sub_brands: { contextPath: 'sub_brands', brainPath: 'catalog.sub_brands', brainSource: 'catalog_sc' },
  marketplace: { contextPath: 'accounts.0.marketplace', brainPath: 'seller.marketplace', brainSource: 'seller' },
  // Tier 3 only — human judgment.
  primary_metric: { contextPath: 'management.primary_metric' },
  attribution_window_days: { contextPath: 'management.attribution_window_days' },
  tacos_target_pct: { contextPath: 'management.tacos_target_pct' },
  tacos_goal_pct: { contextPath: 'management.tacos_goal_pct' },
  posture_stance: { contextPath: 'posture.stance' },
  posture_multiplier: { contextPath: 'posture.multiplier' },
  monthly_total_sales_target: { contextPath: 'goals.monthly_total_sales_target' },
  quarterly_total_sales_target: { contextPath: 'goals.quarterly_total_sales_target' },
  protected_terms: { contextPath: 'negation.protected_terms' },
  lane_rules: { contextPath: 'negation.lane_rules' },
  campaign_naming_pattern: { contextPath: 'campaign_structure.naming_pattern' },
  structural_events: { contextPath: 'structural_events' },
  paused_campaigns: { contextPath: 'paused_campaigns' },
  // Tier 2 only — auto-derived; the brain is authoritative.
  monthly_budget: { brainPath: 'seller.monthly_budget', brainSource: 'seller' },
  recent_spend_30d: { brainPath: 'recent_activity.spend_30d', brainSource: 'recent_activity' },
  recent_acos_30d: { brainPath: 'recent_activity.acos_30d', brainSource: 'recent_activity' },
  item_groups: { brainPath: 'catalog.item_groups', brainSource: 'catalog_sc' },
  hero_asins: { brainPath: 'catalog.top_asins', brainSource: 'hero_sc' },
} satisfies Record<string, FieldSpec>;

export type BrandFieldKey = keyof typeof BRAND_FIELD_REGISTRY;

export const BRAND_FIELD_KEYS = Object.keys(
  BRAND_FIELD_REGISTRY,
) as BrandFieldKey[];

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    const key = /^\d+$/.test(seg) ? Number(seg) : seg;
    return (acc as Record<string | number, unknown>)[key];
  }, obj);
}

/** "Present" = meaningfully set. null/undefined, empty string, empty array,
 *  and empty object all count as absent, so the resolver falls through to
 *  the next tier (or reports the gap). */
function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true; // boolean
}

/** Pure tier resolution from already-loaded docs (no I/O). */
function resolveFieldFrom(
  ctx: ContextResult,
  brain: LoadBrainResult,
  spec: FieldSpec,
): ResolvedField<unknown> | null {
  if (spec.contextPath && ctx.ok) {
    const v = getByPath(ctx.context, spec.contextPath);
    if (isPresent(v)) return { value: v, source: 'context' };
  }
  if (spec.brainPath && brain.ok) {
    const v = getByPath(brain.brain, spec.brainPath);
    if (isPresent(v)) {
      return {
        value: v,
        source: 'brain',
        fetched_at: spec.brainSource
          ? brain.brain.sources[spec.brainSource]?.fetched_at
          : undefined,
      };
    }
  }
  return null;
}

/**
 * Resolve ONE brand-level field across the tiers. Null when neither tier
 * has it (the caller applies its skill default and labels the gap).
 */
export async function getBrandField(
  brandSlug: string,
  key: BrandFieldKey,
  dataDirOverride?: string,
): Promise<ResolvedField<unknown> | null> {
  const ctx = await validateBrandContext(brandSlug, dataDirOverride);
  const brain = await loadBrain(brandSlug, dataDirOverride);
  return resolveFieldFrom(ctx, brain, BRAND_FIELD_REGISTRY[key]);
}

/**
 * Resolve EVERY registered brand-level field in one pass (context + brain
 * read once). The payload behind `mixshift brand context resolve`: a skill
 * makes a single call instead of N ad-hoc reads, then labels each value ✓
 * (context) vs ⊙ (brain) vs gap (null = use the skill default).
 */
export async function resolveBrandFields(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<Record<BrandFieldKey, ResolvedField<unknown> | null>> {
  const ctx = await validateBrandContext(brandSlug, dataDirOverride);
  const brain = await loadBrain(brandSlug, dataDirOverride);
  const out = {} as Record<BrandFieldKey, ResolvedField<unknown> | null>;
  for (const key of BRAND_FIELD_KEYS) {
    out[key] = resolveFieldFrom(ctx, brain, BRAND_FIELD_REGISTRY[key]);
  }
  return out;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
