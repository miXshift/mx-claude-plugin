import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPricingRuns,
  recordPricingRun,
  updatePricingRunStatus,
} from './pricing-handles.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mx-pricing-handles-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function handle(runId: string) {
  return {
    run_id: runId,
    operation: 'foep_batch' as const,
    items_total: 55,
    status: 'PENDING',
    legacy_seller_id: '574',
  };
}

describe('pricing run handle ledger', () => {
  it('records a run and lists it newest-first with timestamps', async () => {
    await recordPricingRun(handle('run-a'), dataDir);
    await recordPricingRun(handle('run-b'), dataDir);
    const { runs, path } = await listPricingRuns(dataDir);
    expect(runs.map((r) => r.run_id)).toEqual(['run-b', 'run-a']);
    expect(runs[0]!.submitted_at).toBeTruthy();
    expect(runs[0]!.items_total).toBe(55);
    expect(path).toContain('pricing-runs.json');
  });

  it('re-recording the same runId replaces instead of duplicating', async () => {
    await recordPricingRun(handle('run-a'), dataDir);
    await recordPricingRun(handle('run-a'), dataDir);
    const { runs } = await listPricingRuns(dataDir);
    expect(runs).toHaveLength(1);
  });

  it('updates last-seen status in place; unknown runId is a no-op', async () => {
    await recordPricingRun(handle('run-a'), dataDir);
    await updatePricingRunStatus('run-a', 'DONE', dataDir);
    await updatePricingRunStatus('run-zzz', 'DONE', dataDir);
    const { runs } = await listPricingRuns(dataDir);
    expect(runs[0]!.status).toBe('DONE');
    expect(runs).toHaveLength(1);
  });

  it('caps the ledger at 50, dropping the oldest', async () => {
    for (let i = 0; i < 55; i++) {
      await recordPricingRun(handle(`run-${i}`), dataDir);
    }
    const { runs } = await listPricingRuns(dataDir);
    expect(runs).toHaveLength(50);
    expect(runs[0]!.run_id).toBe('run-54');
    expect(runs.some((r) => r.run_id === 'run-0')).toBe(false);
  });

  it('missing file lists empty; corrupt file resets instead of throwing', async () => {
    const empty = await listPricingRuns(dataDir);
    expect(empty.runs).toEqual([]);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'pricing-runs.json'), '{not json', 'utf8');
    const corrupt = await listPricingRuns(dataDir);
    expect(corrupt.runs).toEqual([]);
    // A record after corruption rewrites a clean ledger.
    await recordPricingRun(handle('run-after'), dataDir);
    const recovered = await listPricingRuns(dataDir);
    expect(recovered.runs.map((r) => r.run_id)).toEqual(['run-after']);
    const raw = await readFile(join(dataDir, 'pricing-runs.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
