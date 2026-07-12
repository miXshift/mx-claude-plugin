/**
 * One-time context -> OCL config migration.
 *
 * The Brand Context pivot separates two camps: SHARED brand context
 * (context.yaml, the macro "color" 2+ skills read) vs SKILL CONFIGURATION
 * (config.yaml::<skill_id>, the per-skill knobs). During the additive phase
 * (Phase 3) the per-skill knobs lived in context.yaml and each skill's OCL
 * field `seed_from`'d them. This migrator completes the separation: it COPIES
 * the genuinely single-skill scalar knobs into the owning skill's OCL so the
 * value's canonical home is the skill block, ahead of a future context cleanup.
 *
 * Scope is deliberately NARROW. Most fields the early plan listed for
 * migration turned out, by the 2+/1 litmus, to be SHARED (read by 2+ skills:
 * `negation.lane_rules`, `negation.protected_terms`,
 * `negation.asin_negation.*`, `objective_calibration`) or NON-SCALAR
 * (`reporting.voice_lint` is a regex list) — those stay in brand context and
 * are read through the resolver, never migrated. The only clean single-skill
 * scalar case today is `bid_health.*` (KBH's scale/pullback thresholds).
 *
 * Properties:
 *   - IDEMPOTENT: re-running is a no-op (a field already present in the OCL
 *     block is left untouched).
 *   - SOVEREIGN: never overwrites a value the AM already set in OCL.
 *   - EXTRAS-SAFE: round-trips the skill block's other keys (incl. user extras).
 *   - UNIT-CORRECT: brand state stores percentages WHOLE (50); the OCL `percent`
 *     type stores normalized [0,1] (0.50). Percent migrations normalize on the
 *     way in, matching the seed-resolution convention (confirm-flow).
 *
 * It does NOT rewrite context.yaml. The migrated context fields are marked
 * deprecated in lib/context/schema.ts (already `.optional()`); skills read the
 * OCL value (stored > seed), and the lingering context value is harmless until
 * a future release drops it. No `schema_version` bump — fields move, the
 * envelope is unchanged.
 */

import { validateBrandContext } from '../context/load.js';
import { readBrandConfig, saveSkillConfig } from '../calibration/brand-config.js';
import { pushAfterWrite } from '../context-sync/push-after-write.js';

type ScalarType = 'percent' | 'int' | 'float' | 'string' | 'bool';

interface ConfigMigration {
  /** Stable id for reporting. */
  id: string;
  /** Dotted path under the context root (e.g. "bid_health.scale_threshold_pct"). */
  contextPath: string;
  /** Owning skill whose OCL block receives the value. */
  skillId: string;
  /** OCL field id within that skill's block. */
  oclField: string;
  /** Field type — drives unit normalization (percent: whole -> [0,1]). */
  type: ScalarType;
}

/**
 * The registry. Append-only; each entry is a single-skill scalar knob whose
 * canonical home moves to OCL. Keep entries tiny and obviously single-skill —
 * if a field is read by 2+ skills it belongs in brand context, not here.
 */
export const CONFIG_MIGRATIONS: ConfigMigration[] = [
  {
    id: 'bid_health.scale_threshold_pct->mx-keyword-bid-health',
    contextPath: 'bid_health.scale_threshold_pct',
    skillId: 'mx-keyword-bid-health',
    oclField: 'scale_threshold_pct',
    type: 'percent',
  },
  {
    id: 'bid_health.pullback_threshold_pct->mx-keyword-bid-health',
    contextPath: 'bid_health.pullback_threshold_pct',
    skillId: 'mx-keyword-bid-health',
    oclField: 'pullback_threshold_pct',
    type: 'percent',
  },
];

export interface MigrationResult {
  brand_slug: string;
  moved: Array<{ id: string; skill_id: string; field: string; value: unknown }>;
  skipped: Array<{ id: string; reason: string }>;
  /** Skill blocks (re)written this run. */
  wrote_skills: string[];
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, seg) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[seg];
  }, obj);
}

/** Normalize a context value to the OCL storage convention. Percent fields:
 *  brand state stores whole (50), OCL stores [0,1] (0.50). Same rule the
 *  confirm-flow applies to seeds; idempotent for already-normalized values. */
function normalizeForOcl(type: ScalarType, value: unknown): unknown {
  if (type === 'percent' && typeof value === 'number') {
    return value > 1 ? value / 100 : value;
  }
  return value;
}

/**
 * Run the context -> OCL migration for one brand. Idempotent + sovereign.
 * Returns a structured report; writes config.yaml only when something moved.
 */
export async function migrateBrandConfig(
  brandSlug: string,
  dataDirOverride?: string,
): Promise<MigrationResult> {
  const moved: MigrationResult['moved'] = [];
  const skipped: MigrationResult['skipped'] = [];

  const ctxResult = await validateBrandContext(brandSlug, dataDirOverride);
  if (!ctxResult.ok) {
    for (const m of CONFIG_MIGRATIONS) {
      skipped.push({ id: m.id, reason: 'no valid context.yaml to migrate from' });
    }
    return { brand_slug: brandSlug, moved, skipped, wrote_skills: [] };
  }
  const ctx = ctxResult.context;
  const { config } = await readBrandConfig(brandSlug, dataDirOverride);

  // Plan additions per skill (sovereignty + presence checks), then write once
  // per affected skill so a multi-field move to the same skill is one write.
  const additionsBySkill = new Map<string, Record<string, unknown>>();
  for (const m of CONFIG_MIGRATIONS) {
    const raw = getByPath(ctx, m.contextPath);
    if (raw === undefined || raw === null) {
      skipped.push({ id: m.id, reason: 'context field absent' });
      continue;
    }
    const existingBlock = config[m.skillId] ?? {};
    if (Object.prototype.hasOwnProperty.call(existingBlock, m.oclField)) {
      skipped.push({ id: m.id, reason: 'OCL value already set (sovereign — left untouched)' });
      continue;
    }
    const value = normalizeForOcl(m.type, raw);
    const pending = additionsBySkill.get(m.skillId) ?? {};
    pending[m.oclField] = value;
    additionsBySkill.set(m.skillId, pending);
    moved.push({ id: m.id, skill_id: m.skillId, field: m.oclField, value });
  }

  const wrote_skills: string[] = [];
  for (const [skillId, additions] of additionsBySkill) {
    // Merge: existing block (incl. prior OCL values + user extras) wins on any
    // key collision (sovereignty already filtered those out above), additions fill gaps.
    const existingBlock = config[skillId] ?? {};
    const merged = { ...existingBlock, ...additions };
    await saveSkillConfig(brandSlug, skillId, merged, dataDirOverride);
    wrote_skills.push(skillId);
  }

  // Auto-publish the migrated config.yaml to the org store, once, only when
  // something actually moved (best-effort, bounded, non-throwing).
  if (wrote_skills.length > 0) {
    await pushAfterWrite(brandSlug, { dataDirOverride });
  }

  return { brand_slug: brandSlug, moved, skipped, wrote_skills };
}
