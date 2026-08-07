/**
 * frameMetric — whole-number target framing regression suite.
 *
 * `management.acos_target_pct` / `tacos_goal_pct` are stored as WHOLE
 * numbers (22 means 22%, per context/schema.ts + formatWholePct's
 * convention). frameMetric feeds that value into two branches:
 *
 *   - framing='acos': formatPct, which expects a [0,1] fraction.
 *   - framing='roas': formatRoas, which inverts the value directly.
 *
 * Before the fix, passing 22 straight through 100x-inflated the acos
 * branch ("2200%") and inverted the wrong magnitude on the roas branch
 * ("0.05x" instead of "4.55x"). Both are pinned here so neither path can
 * silently revert.
 */

import { describe, it, expect } from 'vitest';
import { frameMetric } from './design-system.js';

describe('frameMetric', () => {
  it('renders the acos framing correctly for a whole-number target', () => {
    const result = frameMetric(22, 'ad', 'acos');
    expect(result.label).toBe('ACoS target');
    expect(result.value).toBe('22%');
  });

  it('renders the roas framing correctly for the same whole-number target', () => {
    const result = frameMetric(22, 'ad', 'roas');
    expect(result.label).toBe('RoAS target');
    expect(result.value).toBe('4.55x');
  });

  it('renders the acos framing correctly for a whole-number TACoS target', () => {
    const result = frameMetric(18, 'total', 'acos');
    expect(result.label).toBe('TACoS target');
    expect(result.value).toBe('18%');
  });

  it('renders the roas framing correctly for the same whole-number TACoS target', () => {
    const result = frameMetric(18, 'total', 'roas');
    expect(result.label).toBe('TRoAS target');
    expect(result.value).toBe('5.56x');
  });

  it('is idempotent for a legacy value already stored as a fraction', () => {
    // Some pre-migration data may already hold 0.22 rather than 22. The
    // same >1 heuristic used by formatWholePct keeps this safe.
    expect(frameMetric(0.22, 'ad', 'acos').value).toBe('22%');
    expect(frameMetric(0.22, 'ad', 'roas').value).toBe('4.55x');
  });

  it('passes null/undefined through as a placeholder in both framings', () => {
    expect(frameMetric(undefined, 'ad', 'acos').value).toBe('—');
    expect(frameMetric(undefined, 'ad', 'roas').value).toBe('—');
    expect(frameMetric(null, 'total', 'acos').value).toBe('—');
    expect(frameMetric(null, 'total', 'roas').value).toBe('—');
  });
});
