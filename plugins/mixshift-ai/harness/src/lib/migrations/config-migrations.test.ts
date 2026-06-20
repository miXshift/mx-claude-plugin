import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { migrateBrandConfig } from './config-migrations.js';
import { contextPath, brandConfigPath } from '../paths/resolve.js';

let testDir: string;
let brandDir: string;

const CONTEXT = `
schema_version: 1
brand_slug: summit
brand_name: Summit
last_updated: 2026-06-18
accounts:
  - seller_id: 123
    seller_name: Test
    account_type: SC
    status: active
    role: primary
sources:
  ad_metrics: ads
  ops_revenue: rev
  ops_revenue_field: r
  ops_units_field: u
  ops_date_field: d
management:
  primary_metric: ACOS
  acos_target_pct: 22
  attribution_window_days: 14
bid_health:
  scale_threshold_pct: 50
  pullback_threshold_pct: 45
`;

async function writeContext(body = CONTEXT): Promise<void> {
  await writeFile(contextPath('summit', testDir), body, 'utf-8');
}
async function writeConfig(yaml: string): Promise<void> {
  await writeFile(brandConfigPath('summit', testDir), yaml, 'utf-8');
}
async function readConfig(): Promise<Record<string, Record<string, unknown>>> {
  const raw = await readFile(brandConfigPath('summit', testDir), 'utf-8');
  return parseYaml(raw);
}

beforeEach(async () => {
  testDir = join(tmpdir(), `mxtest-migrate-${process.pid}-${Date.now()}-${Math.random()}`);
  brandDir = join(testDir, 'clients', 'summit');
  await mkdir(brandDir, { recursive: true });
});
afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('migrateBrandConfig', () => {
  it('moves bid_health.* into KBH OCL, normalizing whole percents to [0,1]', async () => {
    await writeContext();
    const r = await migrateBrandConfig('summit', testDir);
    expect(r.moved.map((m) => m.field).sort()).toEqual([
      'pullback_threshold_pct',
      'scale_threshold_pct',
    ]);
    const cfg = await readConfig();
    expect(cfg['mx-keyword-bid-health']!.scale_threshold_pct).toBe(0.5); // 50 -> 0.50
    expect(cfg['mx-keyword-bid-health']!.pullback_threshold_pct).toBe(0.45); // 45 -> 0.45
  });

  it('is idempotent — a second run moves nothing (sovereign)', async () => {
    await writeContext();
    await migrateBrandConfig('summit', testDir);
    const r2 = await migrateBrandConfig('summit', testDir);
    expect(r2.moved).toEqual([]);
    expect(r2.skipped).toHaveLength(2);
    expect(r2.skipped.every((s) => /sovereign/.test(s.reason))).toBe(true);
  });

  it('never overwrites an OCL value the AM already set', async () => {
    await writeContext();
    // AM already tuned scale (stored [0,1]); pullback unset.
    await writeConfig(`mx-keyword-bid-health:\n  scale_threshold_pct: 0.3\n`);
    const r = await migrateBrandConfig('summit', testDir);
    const cfg = await readConfig();
    expect(cfg['mx-keyword-bid-health']!.scale_threshold_pct).toBe(0.3); // untouched
    expect(cfg['mx-keyword-bid-health']!.pullback_threshold_pct).toBe(0.45); // migrated
    expect(r.moved.map((m) => m.field)).toEqual(['pullback_threshold_pct']);
    expect(r.skipped.some((s) => s.id.includes('scale'))).toBe(true);
  });

  it('round-trips user extras in the skill block', async () => {
    await writeContext();
    await writeConfig(`mx-keyword-bid-health:\n  my_custom_knob: hello\n`);
    await migrateBrandConfig('summit', testDir);
    const cfg = await readConfig();
    expect(cfg['mx-keyword-bid-health']!.my_custom_knob).toBe('hello');
    expect(cfg['mx-keyword-bid-health']!.scale_threshold_pct).toBe(0.5);
  });

  it('skips everything when there is no valid context.yaml', async () => {
    const r = await migrateBrandConfig('summit', testDir);
    expect(r.moved).toEqual([]);
    expect(r.wrote_skills).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
    await expect(
      readFile(brandConfigPath('summit', testDir), 'utf-8'),
    ).rejects.toThrow();
  });

  it('skips a field absent from context (e.g. no bid_health block)', async () => {
    await writeContext(CONTEXT.replace(/bid_health:[\s\S]*$/, '').trimEnd() + '\n');
    const r = await migrateBrandConfig('summit', testDir);
    expect(r.moved).toEqual([]);
    expect(r.skipped.every((s) => s.reason === 'context field absent')).toBe(true);
  });
});
