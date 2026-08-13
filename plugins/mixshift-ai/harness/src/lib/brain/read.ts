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
import { maybeAutoSync } from '../context-sync/autosync.js';
import type { BindingBlock } from '../context/schema.js';
import type { LensSummary } from '../binding/lens.js';

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
  /**
   * Present (and `true`) ONLY when this value describes the WHOLE Amazon
   * seller account rather than this specific sub-brand — i.e. the brand
   * carries a `binding` (mx-ops#6) and this Tier-2 value's underlying
   * source has no PROVEN label-scoped result for it: either the source
   * query structurally has no label param at all, or a label filter was
   * sent but the brain's stored `label_lens` record shows it did not
   * resolve to 'applied' (dropped, unverified, missing_label_value, or
   * query_failed — see lib/binding/lens.ts). Consumers must render this
   * distinctly from an ordinary pre-filled value: "this sub-brand's own
   * number" vs "the whole account's number" (red-team finding F2).
   *
   * Deliberately OMITTED (never `false`) whenever it doesn't apply — every
   * context-sourced field (Tier-3 values are always this brand's own) and
   * every brain-sourced field on an UNBOUND brand (the account IS the
   * brand; nothing to distinguish). This keeps an unbound brand's resolve
   * output byte-identical to before this field existed: additive only.
   */
  account_wide?: true;
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
      // BRAIN-SELLER carries no label param (it is not one of the seven
      // gateway entries that accept one), so a bound brand's seller-sourced
      // value is ALWAYS account-wide, never label-scoped. An unbound
      // brand's own account IS the brand, so nothing to flag (F2).
      const binding = ctx.ok ? ctx.context.binding ?? null : null;
      return {
        value: v,
        source: 'brain',
        fetched_at: brain.brain.sources.seller?.fetched_at,
        ...(binding ? { account_wide: true } : {}),
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
  /**
   * REQUIRED whenever `brainPath` is set (red-team finding F2): identifies
   * whether this brain-sourced field's underlying query can ever be
   * label-scoped, so `resolveFieldFrom` can tell a bound brand's OWN value
   * apart from the whole account's.
   *   - the literal `'account_wide'` — the source query is not one of the
   *     seven gateway entries that accept a label param at all (seller,
   *     hero, recent-activity, capture-rate, stockout, brand-typo sources).
   *     Structural; a bound brand's value here is ALWAYS account-wide.
   *   - a query id from `LABEL_LENS_PARAM_BY_QUERY` (lib/binding/lens.ts) —
   *     the source query CAN be label-scoped. Whether THIS bound brand's
   *     value actually is depends on the brain's stored `label_lens` record
   *     for that id (only 'applied' counts; dropped/unverified/
   *     missing_label_value/query_failed do not).
   */
  brainQueryId?: string | 'account_wide';
}

/**
 * The brand-level fields 2+ skills consume (the crossover set) — the single
 * source of truth for "what is brand context", so skills and the
 * `brand context resolve` command agree. Add a field here when a SECOND
 * skill needs it (the 2+/1 litmus); single-skill knobs stay in OCL.
 */
const BRAND_FIELD_REGISTRY = {
  // Both tiers — context wins, brain pre-fills.
  acos_target_pct: { contextPath: 'management.acos_target_pct', brainPath: 'seller.acos_target_pct', brainSource: 'seller', brainQueryId: 'account_wide' },
  // catalog.sub_brands / catalog.item_groups come off BRAIN-CATALOG-SC,
  // which the label lens CAN scope (mx-ops#6) — a bound brand's value here
  // is this sub-brand's own only when that query's lens actually resolved
  // to 'applied' (checked against the brain's stored label_lens record).
  sub_brands: { contextPath: 'sub_brands', brainPath: 'catalog.sub_brands', brainSource: 'catalog_sc', brainQueryId: 'BRAIN-CATALOG-SC' },
  marketplace: { contextPath: 'accounts.0.marketplace', brainPath: 'seller.marketplace', brainSource: 'seller', brainQueryId: 'account_wide' },
  // Tier 3 only — human judgment.
  primary_metric: { contextPath: 'management.primary_metric' },
  // Provenance of acos_target_pct (warehouse|default|user; absent on
  // pre-provenance files). Exposed so skills can label an unconfirmed
  // bootstrap default without parsing context.yaml directly.
  acos_target_source: { contextPath: 'management.acos_target_source' },
  attribution_window_days: { contextPath: 'management.attribution_window_days' },
  // Canonical field. lib/context/load.ts normalizes the deprecated
  // management.tacos_target_pct alias onto this path before any consumer
  // (including this registry) ever sees the parsed context, so
  // management.tacos_target_pct never resolves here post-load.
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
  // Tier 2 only — auto-derived; the brain is authoritative. None of these
  // sources are label-aware (BRAIN-SELLER / BRAIN-HERO-SC / BRAIN-RECENT-
  // ACTIVITY carry no label param) — a bound brand's value is ALWAYS
  // account-wide (F2's explicit remediation list).
  monthly_budget: { brainPath: 'seller.monthly_budget', brainSource: 'seller', brainQueryId: 'account_wide' },
  recent_spend_30d: { brainPath: 'recent_activity.spend_30d', brainSource: 'recent_activity', brainQueryId: 'account_wide' },
  recent_acos_30d: { brainPath: 'recent_activity.acos_30d', brainSource: 'recent_activity', brainQueryId: 'account_wide' },
  item_groups: { brainPath: 'catalog.item_groups', brainSource: 'catalog_sc', brainQueryId: 'BRAIN-CATALOG-SC' },
  hero_asins: { brainPath: 'catalog.top_asins', brainSource: 'hero_sc', brainQueryId: 'account_wide' },
  // Phase 8 enrichment (each value serves 2+ skills).
  // capture_rate is both-tier (AM-confirmed context wins; brain
  // pre-fills from CS-06/07/08 + CS-28); daily_settlement_curve is the nested
  // sub-block monthly-report prefers. stockouts + brand_term_typos are
  // Tier-2-only advisories (no Tier-3 home; the AM confirms them into
  // structural_events / brand_terms.variants). None of CS-06/07/08/28/29/31
  // are label-aware (only CS-09/11/12/13 are) — always account-wide when bound.
  capture_rate_calibration: { contextPath: 'capture_rate_calibration', brainPath: 'capture_rate_calibration', brainSource: 'capture_rate', brainQueryId: 'account_wide' },
  daily_settlement_curve: { contextPath: 'capture_rate_calibration.daily_settlement_curve', brainPath: 'capture_rate_calibration.daily_settlement_curve', brainSource: 'capture_rate', brainQueryId: 'account_wide' },
  stockouts: { brainPath: 'stockouts', brainSource: 'stockout', brainQueryId: 'account_wide' },
  brand_term_typos: { brainPath: 'brand_term_typos', brainSource: 'brand_typos', brainQueryId: 'account_wide' },
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

/**
 * Whether a brain-sourced field's value is ACCOUNT-WIDE rather than this
 * bound brand's own (red-team finding F2). Unbound brands
 * never get here as `true`: the account IS the brand, nothing to
 * distinguish. For a bound brand: a query with no label param at all is
 * ALWAYS account-wide (`brainQueryId === 'account_wide'`); a label-aware
 * query is account-wide UNLESS the brain's own `label_lens` record shows it
 * resolved to 'applied' — dropped, unverified, missing_label_value, and
 * query_failed all fall through to account-wide, matching the lens's own
 * "never render as confirmed label-scoped" rule (lib/binding/lens.ts).
 */
function isAccountWideBrainField(
  spec: FieldSpec,
  binding: BindingBlock | null,
  labelLens: LensSummary | null | undefined,
): boolean {
  if (!binding) return false;
  if (!spec.brainQueryId || spec.brainQueryId === 'account_wide') return true;
  return !(labelLens?.applied.includes(spec.brainQueryId) ?? false);
}

/** Pure tier resolution from already-loaded docs (no I/O). */
function resolveFieldFrom(
  ctx: ContextResult,
  brain: LoadBrainResult,
  spec: FieldSpec,
): ResolvedField<unknown> | null {
  if (spec.contextPath && ctx.ok) {
    const v = getByPath(ctx.context, spec.contextPath);
    // Tier-3 values are always THIS brand's own, bound or not — no
    // account_wide flag, ever (F2).
    if (isPresent(v)) return { value: v, source: 'context' };
  }
  if (spec.brainPath && brain.ok) {
    const v = getByPath(brain.brain, spec.brainPath);
    if (isPresent(v)) {
      const binding = ctx.ok ? ctx.context.binding ?? null : null;
      const accountWide = isAccountWideBrainField(spec, binding, brain.brain.label_lens);
      return {
        value: v,
        source: 'brain',
        fetched_at: spec.brainSource
          ? brain.brain.sources[spec.brainSource]?.fetched_at
          : undefined,
        ...(accountWide ? { account_wide: true } : {}),
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
  // Preflight pull-if-stale (P2 auto-sync). This is THE seam: every skill
  // enters brand context through resolveBrandFields (Step-0 `brand context
  // resolve`, the OCL confirm flow, the context-page composer), so hooking
  // here freshens the local cache org-wide without touching the dozens of
  // other validateBrandContext callers (validate/migrate flows must never
  // mutate local files mid-read). Contract: throttled to one attempt per
  // brand per 15 min, ~2s worst-case budget, pull-only on conflict-free
  // docs, and ANY failure is a silent no-op — the local read below always
  // proceeds unchanged. Kill switch: MIXSHIFT_CONTEXT_AUTOSYNC=off.
  await maybeAutoSync(brandSlug, { dataDirOverride });

  const ctx = await validateBrandContext(brandSlug, dataDirOverride);
  const brain = await loadBrain(brandSlug, dataDirOverride);
  const out = {} as Record<BrandFieldKey, ResolvedField<unknown> | null>;
  for (const key of BRAND_FIELD_KEYS) {
    out[key] = resolveFieldFrom(ctx, brain, BRAND_FIELD_REGISTRY[key]);
  }
  return out;
}

// Reverse map: context dotted-path (a `seed_from` target, minus the `context.`
// prefix) → registry key. Lets the confirm-flow brain-fall-back a seed when
// context.yaml lacks the value. Built once at module load.
const CONTEXT_PATH_TO_KEY: Record<string, BrandFieldKey> = {};
for (const k of BRAND_FIELD_KEYS) {
  const spec: FieldSpec = BRAND_FIELD_REGISTRY[k];
  if (spec.contextPath !== undefined) CONTEXT_PATH_TO_KEY[spec.contextPath] = k;
}

/**
 * Map a `seed_from` context dotted-path (minus the `context.` prefix) to its
 * registry key, so the confirm-flow can resolve the same logical field from
 * the brain when context.yaml doesn't provide it. Null when the path isn't a
 * registered brand-level field.
 */
export function brandFieldKeyForContextPath(
  contextDotPath: string,
): BrandFieldKey | null {
  return CONTEXT_PATH_TO_KEY[contextDotPath] ?? null;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
