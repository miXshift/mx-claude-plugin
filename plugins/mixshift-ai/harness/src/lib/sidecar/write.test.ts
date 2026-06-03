import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSidecar, sidecarPath } from './write.js';

describe('writeSidecar', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mxs-sidecar-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes a valid per_account sidecar at the canonical path', async () => {
    const result = await writeSidecar({
      skill: 'mx-runaway-spend-check',
      skill_version: '0.2.0',
      brand_slug: 'testbrand',
      run_kind: 'per_account',
      data_date: '2026-04-24',
      run_id: 'abc123', // deterministic for assertion
      context_snapshot: {
        account_type: 'SC',
        seller_id: 111,
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
      sql_calls: [
        { id: 'RSC-01', params: { seller_id: 111, yesterday: '2026-04-24' } },
      ],
      headline_metrics: { runaway_count: 0, runaway_total_spend: 0 },
      verdict: 'GREEN',
      artifacts: { report_html_path: '/tmp/report.md' },
      dataDirOverride: dataDir,
    });

    expect(result.run_id).toBe('abc123');
    expect(result.sidecar_path).toBe(
      sidecarPath({
        brand_slug: 'testbrand',
        skill: 'mx-runaway-spend-check',
        data_date: '2026-04-24',
        run_id: 'abc123',
        dataDirOverride: dataDir,
      }),
    );

    const written = JSON.parse(await readFile(result.sidecar_path, 'utf-8'));
    expect(written.run_id).toBe('abc123');
    expect(written.skill).toBe('mx-runaway-spend-check');
    expect(written.verdict).toBe('GREEN');
    // sql_calls should be normalized to {id, params_hash}
    expect(written.sql_calls[0].id).toBe('RSC-01');
    expect(written.sql_calls[0].params_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('produces stable params_hash for identical params regardless of key order', async () => {
    const r1 = await writeSidecar({
      skill: 'x',
      skill_version: '0.1.0',
      brand_slug: 'b',
      run_kind: 'per_account',
      data_date: '2026-04-24',
      run_id: 'aaaaaa',
      context_snapshot: {
        account_type: 'SC',
        seller_id: 1,
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
      sql_calls: [{ id: 'Q1', params: { a: 1, b: 2, c: 3 } }],
      headline_metrics: { v: 1 },
      verdict: 'GREEN',
      artifacts: { report_html_path: '/x' },
      dataDirOverride: dataDir,
    });
    const r2 = await writeSidecar({
      skill: 'x',
      skill_version: '0.1.0',
      brand_slug: 'b',
      run_kind: 'per_account',
      data_date: '2026-04-24',
      run_id: 'bbbbbb',
      context_snapshot: {
        account_type: 'SC',
        seller_id: 1,
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
      // Reordered keys — hash MUST be the same
      sql_calls: [{ id: 'Q1', params: { c: 3, a: 1, b: 2 } }],
      headline_metrics: { v: 1 },
      verdict: 'GREEN',
      artifacts: { report_html_path: '/x' },
      dataDirOverride: dataDir,
    });
    const w1 = JSON.parse(await readFile(r1.sidecar_path, 'utf-8'));
    const w2 = JSON.parse(await readFile(r2.sidecar_path, 'utf-8'));
    expect(w1.sql_calls[0].params_hash).toBe(w2.sql_calls[0].params_hash);
  });

  it('rejects per_account sidecar that omits required context fields', async () => {
    await expect(
      writeSidecar({
        skill: 'x',
        skill_version: '0.1.0',
        brand_slug: 'b',
        run_kind: 'per_account',
        data_date: '2026-04-24',
        run_id: 'cccccc',
        // Missing: account_type, primary_metric, acos_target_pct, attribution_window_days
        context_snapshot: { seller_id: 1 },
        headline_metrics: { v: 1 },
        verdict: 'GREEN',
        artifacts: { report_html_path: '/x' },
        dataDirOverride: dataDir,
      }),
    ).rejects.toThrow(/account_type|primary_metric|acos_target_pct/);
  });

  it('generates a 6-char hex run_id when not provided', async () => {
    const result = await writeSidecar({
      skill: 'x',
      skill_version: '0.1.0',
      brand_slug: 'b',
      run_kind: 'per_account',
      data_date: '2026-04-24',
      // No run_id — must be generated
      context_snapshot: {
        account_type: 'SC',
        seller_id: 1,
        primary_metric: 'ACOS',
        acos_target_pct: 20,
        attribution_window_days: 14,
      },
      headline_metrics: { v: 1 },
      verdict: 'GREEN',
      artifacts: { report_html_path: '/x' },
      dataDirOverride: dataDir,
    });
    expect(result.run_id).toMatch(/^[0-9a-f]{6}$/);
  });

  it('accepts portfolio run_kind when the right keys are present', async () => {
    const result = await writeSidecar({
      skill: 'mx-portfolio-quick-scan',
      skill_version: '0.1.0',
      brand_slug: 'portfolio',
      run_kind: 'portfolio',
      data_date: '2026-04-24',
      run_id: 'dddddd',
      context_snapshot: {
        portfolio_account_count: 12,
        portfolio_config_path: '/etc/portfolio.yaml',
      },
      headline_metrics: { accounts_red: 1 },
      verdict: 'YELLOW',
      artifacts: { report_html_path: '/x' },
      dataDirOverride: dataDir,
    });
    const written = JSON.parse(await readFile(result.sidecar_path, 'utf-8'));
    expect(written.run_kind).toBe('portfolio');
    expect(written.context_snapshot.portfolio_account_count).toBe(12);
  });
});
