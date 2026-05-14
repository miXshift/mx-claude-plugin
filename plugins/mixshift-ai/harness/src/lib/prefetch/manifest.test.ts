import { describe, expect, it } from 'vitest';
import { resolveBatchPlan, type SkillManifest } from './manifest.js';

function baseManifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    schema_version: 1,
    skill_id: 'x',
    display_name: 'X',
    version: '0.1.0',
    description: 'desc',
    run_kind: 'per_account',
    cadence: 'daily',
    risk_tier: 3,
    allowed_tools: ['db_read'],
    side_effect_policy: 'recommendation_only',
    review_required: 'always',
    sql_ids: [],
    required_context_fields: [],
    optional_context_fields: [],
    artifacts: [],
    verdict_range: ['GREEN', 'YELLOW', 'RED'],
    pricing_tier: 'pro',
    ...overrides,
  } as SkillManifest;
}

describe('resolveBatchPlan', () => {
  it('returns explicit batch_plan in round order', () => {
    const manifest = baseManifest({
      sql_ids: ['A', 'B', 'C'],
      pre_execution: {
        enabled: true,
        artifact_path: 'foo.json',
        batch_plan: [
          { round: 2, parallel: ['C'] },
          { round: 1, parallel: ['A', 'B'] },
        ],
      },
    });
    const rounds = resolveBatchPlan(manifest);
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[0]?.parallel).toEqual(['A', 'B']);
    expect(rounds[1]?.parallel).toEqual(['C']);
  });

  it('fabricates a single round from sql_ids when no batch_plan is declared', () => {
    const manifest = baseManifest({ sql_ids: ['X', 'Y'] });
    const rounds = resolveBatchPlan(manifest);
    expect(rounds.length).toBe(1);
    expect(rounds[0]?.parallel).toEqual(['X', 'Y']);
    expect(rounds[0]?.round).toBe(1);
  });

  it('returns an empty plan when sql_ids is empty and no batch_plan', () => {
    const manifest = baseManifest({ sql_ids: [] });
    expect(resolveBatchPlan(manifest)).toEqual([]);
  });
});
